// Supernoba-symbol-cleanup: Async cleanup of symbol-related data
// Triggered by SQS when a symbol is deleted
// Runs OUTSIDE VPC (DynamoDB access only)

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
    DynamoDBDocumentClient,
    ScanCommand,
    DeleteCommand,
    UpdateCommand,
    BatchWriteCommand
} from '@aws-sdk/lib-dynamodb';

const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-2';

const dynamodb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: AWS_REGION }),
    { marshallOptions: { removeUndefinedValues: true } }
);

const TABLES = {
    HOLDINGS: 'supernoba-holdings',
    ORDERS: 'supernoba-orders',
    FAVORITES: 'supernoba-favorites',
    IPO_ORDERS: 'supernoba-ipo-orders'
};

export const handler = async (event) => {
    console.log('[SYMBOL-CLEANUP] Received event:', JSON.stringify(event, null, 2));

    const results = {
        processed: 0,
        failed: 0,
        details: []
    };

    for (const record of event.Records) {
        try {
            const message = JSON.parse(record.body);
            const { symbol, action } = message;

            if (action !== 'DELETE_SYMBOL') {
                console.log(`[SYMBOL-CLEANUP] Unknown action: ${action}`);
                continue;
            }

            if (!symbol) {
                console.error('[SYMBOL-CLEANUP] Missing symbol in message');
                continue;
            }

            console.log(`[SYMBOL-CLEANUP] Processing cleanup for symbol: ${symbol}`);

            const cleanupResult = {
                symbol,
                holdings: 0,
                orders: 0,
                favorites: 0,
                ipoOrders: 0
            };

            // 1. Delete holdings for this symbol
            cleanupResult.holdings = await deleteHoldings(symbol);

            // 2. Delete orders for this symbol
            cleanupResult.orders = await deleteOrders(symbol);

            // 3. Remove symbol from favorites
            cleanupResult.favorites = await cleanFavorites(symbol);

            // 4. Delete IPO orders for this symbol
            cleanupResult.ipoOrders = await deleteIpoOrders(symbol);

            console.log(`[SYMBOL-CLEANUP] Cleanup completed for ${symbol}:`, cleanupResult);
            results.details.push(cleanupResult);
            results.processed++;

        } catch (err) {
            console.error('[SYMBOL-CLEANUP] Error processing record:', err);
            results.failed++;
            throw err; // Re-throw to trigger SQS retry
        }
    }

    console.log('[SYMBOL-CLEANUP] Final results:', results);
    return results;
};

/**
 * Generic batch delete by symbol filter
 * @param {string} tableName - DynamoDB table name
 * @param {string} symbol - Symbol to filter by
 * @param {Function} keyMapper - Function to extract key from item
 * @param {string} logLabel - Label for logging
 */
async function batchDeleteBySymbol(tableName, symbol, keyMapper, logLabel) {
    let deletedCount = 0;
    let lastEvaluatedKey = undefined;

    do {
        const scanResult = await dynamodb.send(new ScanCommand({
            TableName: tableName,
            FilterExpression: 'symbol = :symbol',
            ExpressionAttributeValues: { ':symbol': symbol },
            ExclusiveStartKey: lastEvaluatedKey
        }));

        const items = scanResult.Items || [];

        if (items.length > 0) {
            for (const batch of chunkArray(items, 25)) {
                await dynamodb.send(new BatchWriteCommand({
                    RequestItems: {
                        [tableName]: batch.map(item => ({
                            DeleteRequest: { Key: keyMapper(item) }
                        }))
                    }
                }));
                deletedCount += batch.length;
            }
        }

        lastEvaluatedKey = scanResult.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    console.log(`[SYMBOL-CLEANUP] Deleted ${deletedCount} ${logLabel} for ${symbol}`);
    return deletedCount;
}

const deleteHoldings = (symbol) => batchDeleteBySymbol(
    TABLES.HOLDINGS, symbol,
    item => ({ user_id: item.user_id, symbol: item.symbol }),
    'holdings'
);

const deleteOrders = (symbol) => batchDeleteBySymbol(
    TABLES.ORDERS, symbol,
    item => ({ user_id: item.user_id, order_id: item.order_id }),
    'orders'
);

/**
 * Remove symbol from all user favorites
 * Schema: PK=user_id, symbols=string[]
 */
async function cleanFavorites(symbol) {
    let updatedCount = 0;
    let lastEvaluatedKey = undefined;

    do {
        const scanResult = await dynamodb.send(new ScanCommand({
            TableName: TABLES.FAVORITES,
            FilterExpression: 'contains(symbols, :symbol)',
            ExpressionAttributeValues: { ':symbol': symbol },
            ProjectionExpression: 'user_id, symbols',
            ExclusiveStartKey: lastEvaluatedKey
        }));

        const items = scanResult.Items || [];

        for (const item of items) {
            const newSymbols = (item.symbols || []).filter(s => s !== symbol);

            await dynamodb.send(new UpdateCommand({
                TableName: TABLES.FAVORITES,
                Key: { user_id: item.user_id },
                UpdateExpression: 'SET symbols = :symbols, updated_at = :updated_at',
                ExpressionAttributeValues: {
                    ':symbols': newSymbols,
                    ':updated_at': new Date().toISOString()
                }
            }));

            updatedCount++;
        }

        lastEvaluatedKey = scanResult.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    console.log(`[SYMBOL-CLEANUP] Updated ${updatedCount} favorites for ${symbol}`);
    return updatedCount;
}

/**
 * Delete IPO orders for this symbol
 * Schema: PK=symbol
 */
async function deleteIpoOrders(symbol) {
    try {
        await dynamodb.send(new DeleteCommand({
            TableName: TABLES.IPO_ORDERS,
            Key: { symbol }
        }));
        console.log(`[SYMBOL-CLEANUP] Deleted IPO order for ${symbol}`);
        return 1;
    } catch (err) {
        if (err.name === 'ResourceNotFoundException') {
            console.log(`[SYMBOL-CLEANUP] No IPO order found for ${symbol}`);
            return 0;
        }
        throw err;
    }
}

/**
 * Split array into chunks
 */
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}
