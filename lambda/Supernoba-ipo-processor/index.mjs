// Supernoba-ipo-processor: Process IPO orders from DynamoDB Stream
// This Lambda runs OUTSIDE VPC to access Kinesis

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { UpdateCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
import crypto from 'node:crypto';

const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-2';
const ORDER_STREAM = process.env.ORDER_STREAM || 'supernoba-orders';
const IPO_ORDERS_TABLE = process.env.IPO_ORDERS_TABLE || 'supernoba-ipo-orders';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }));
const kinesis = new KinesisClient({ region: AWS_REGION });

// Helper to update IPO order status (PK = order_id)
const updateIpoStatus = async (orderId, status, extraFields = {}) => {
    const attrs = { ':status': status, ...Object.fromEntries(
        Object.entries(extraFields).map(([k, v]) => [`:${k}`, v])
    )};
    const expr = 'SET #status = :status' +
        (Object.keys(extraFields).length ? ', ' + Object.keys(extraFields).map(k => `${k} = :${k}`).join(', ') : '');
    await dynamodb.send(new UpdateCommand({
        TableName: IPO_ORDERS_TABLE,
        Key: { order_id: orderId },
        UpdateExpression: expr,
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: attrs
    }));
};

export const handler = async (event) => {
    console.log('[IPO-PROCESSOR] Received event:', JSON.stringify(event, null, 2));

    for (const record of event.Records) {
        // Only process INSERT events (new PENDING orders)
        if (record.eventName !== 'INSERT') {
            console.log(`[IPO-PROCESSOR] Skipping ${record.eventName} event`);
            continue;
        }

        const newImage = record.dynamodb?.NewImage;
        if (!newImage) {
            console.log('[IPO-PROCESSOR] No NewImage in record');
            continue;
        }

        // Parse DynamoDB stream format
        const orderIdFromStream = newImage.order_id?.S;
        const symbol = newImage.symbol?.S;
        const status = newImage.status?.S;
        const quantity = parseInt(newImage.quantity?.N || '0');
        const price = parseFloat(newImage.price?.N || '0');
        const userId = newImage.userId?.S;

        // Only process PENDING orders
        if (status !== 'PENDING') {
            console.log(`[IPO-PROCESSOR] Skipping non-PENDING order: ${symbol} (${status})`);
            continue;
        }

        if (!orderIdFromStream || !symbol || quantity <= 0 || price <= 0 || !userId) {
            console.error(`[IPO-PROCESSOR] Invalid order data: order_id=${orderIdFromStream}, ${symbol}, ${quantity}, ${price}, ${userId}`);
            continue;
        }

        console.log(`[IPO-PROCESSOR] Processing IPO order: ${orderIdFromStream} ${symbol} ${quantity}@${price}`);

        try {
            // 1. Update status to PROCESSING
            await updateIpoStatus(orderIdFromStream, 'PROCESSING', { processedAt: new Date().toISOString() });

            // 2. Create and publish SELL order to Kinesis (C++ engine format)
            const orderId = crypto.randomUUID();
            await kinesis.send(new PutRecordCommand({
                StreamName: ORDER_STREAM,
                PartitionKey: symbol,
                Data: Buffer.from(JSON.stringify({
                    action: 'ADD',
                    order_id: orderId,
                    user_id: userId,
                    symbol: symbol.toUpperCase(),
                    is_buy: false,
                    price, quantity,
                    order_type: 'LIMIT',
                    timestamp: Date.now(),
                    conditions: {},
                    lock_amount: 0,
                    source: 'IPO'
                }))
            }));
            console.log(`[IPO-PROCESSOR] Order published to Kinesis: ${orderId}`);

            // 3. Update status to COMPLETED
            await updateIpoStatus(orderIdFromStream, 'COMPLETED', { orderId, completedAt: new Date().toISOString() });
            console.log(`[IPO-PROCESSOR] IPO order completed: ${symbol} -> ${orderId}`);

        } catch (err) {
            console.error(`[IPO-PROCESSOR] Error processing ${symbol}:`, err);
            try {
                await updateIpoStatus(orderIdFromStream, 'FAILED', { errorMessage: err.message, failedAt: new Date().toISOString() });
            } catch (updateErr) {
                console.error(`[IPO-PROCESSOR] Failed to update error status:`, updateErr);
            }
        }
    }

    return { statusCode: 200, body: 'OK' };
};
