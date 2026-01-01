// Supernoba-fill-processor
// Trigger: Kinesis Stream (supernoba-fills)
// Logic:
//   1. Update DynamoDB orders (filled_qty, status)
//   2. Update DynamoDB holdings (quantity, locked)
//   3. Update Supabase wallets (BOLT balance transfer)

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

// === Configuration ===
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'supernoba-orders';
const HOLDINGS_TABLE = process.env.HOLDINGS_TABLE || 'supernoba-holdings';

// Market Maker IDs (지갑 업데이트 제외 대상)
const MARKET_MAKER_IDS = new Set([
    'mm-kinesis-direct-buy',
    'mm-kinesis-direct-sell'
]);

function isMarketMaker(userId) {
    return MARKET_MAKER_IDS.has(userId);
}

// DynamoDB Client
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const ddb = DynamoDBDocumentClient.from(dynamoClient);

// Supabase Client (lazy import)
let supabaseClient = null;
let createSupabaseClient = null;

async function getSupabase() {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;

    if (!supabaseClient && !createSupabaseClient) {
        try {
            const supabaseModule = await import('@supabase/supabase-js');
            createSupabaseClient = supabaseModule.createClient;
            supabaseClient = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
                auth: { persistSession: false }
            });
        } catch (err) {
            console.warn(`[Supabase] Failed to initialize:`, err.message);
            return null;
        }
    }
    return supabaseClient;
}

export const handler = async (event) => {
    const records = event.Records || [];
    console.log(`Processing ${records.length} records...`);

    const results = await Promise.allSettled(records.map(async (record) => {
        try {
            const payload = Buffer.from(record.kinesis.data, 'base64').toString('utf-8');
            const data = JSON.parse(payload);

            if (data.event !== 'FILL') return;

            console.log(`Processing FILL: ${data.trade_id} (${data.symbol})`);

            // 1. Update DynamoDB Orders (Buyer & Seller) - 병렬 처리
            const buyerFullyFilled = data.buyer?.fully_filled === true;
            const sellerFullyFilled = data.seller?.fully_filled === true;

            await Promise.all([
                updateOrderInDynamoDB(data.buyer.user_id, data.buyer.order_id, data.quantity, data.price, buyerFullyFilled),
                updateOrderInDynamoDB(data.seller.user_id, data.seller.order_id, data.quantity, data.price, sellerFullyFilled)
            ]);
            console.log(`[DynamoDB] Updated orders: buyer=${data.buyer.order_id}, seller=${data.seller.order_id}`);

            // 2. Update DynamoDB Holdings (Buyer & Seller) - 병렬 처리
            await Promise.all([
                updateHoldings(data.buyer.user_id, data.symbol, data.quantity, data.price, 'BUY'),
                updateHoldings(data.seller.user_id, data.symbol, data.quantity, data.price, 'SELL')
            ]);
            console.log(`[DynamoDB] Updated holdings: buyer +${data.quantity}, seller -${data.quantity}`);

            // 3. Update Supabase Wallets
            const buyerIsMarketMaker = isMarketMaker(data.buyer.user_id);
            const sellerIsMarketMaker = isMarketMaker(data.seller.user_id);
            const tradeValue = data.price * data.quantity;

            if (buyerIsMarketMaker && sellerIsMarketMaker) {
                console.log(`[Supabase] Skipping - Both parties are market makers`);
            } else {
                const client = await getSupabase();
                if (client) {
                    try {
                        await Promise.all([
                            !buyerIsMarketMaker ? updateBuyerWallet(client, data.buyer.user_id, tradeValue) : Promise.resolve(),
                            !sellerIsMarketMaker ? updateSellerWallet(client, data.seller.user_id, tradeValue) : Promise.resolve()
                        ]);
                    } catch (walletErr) {
                        console.error(`[Supabase] Wallet update error:`, walletErr.message);
                    }
                }
            }

        } catch (e) {
            console.error(`[fill-processor] Error:`, e.message);
            throw e;
        }
    }));

    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
        console.error(`Batch completed with ${failures.length} errors.`);
        // Kinesis partial batch failure response (fixed: proper index mapping)
        const failedRecords = [];
        results.forEach((r, i) => {
            if (r.status === 'rejected') {
                failedRecords.push({ itemIdentifier: records[i].kinesis.sequenceNumber });
            }
        });
        return { batchItemFailures: failedRecords };
    }

    console.log("Batch processed successfully.");
    return { statusCode: 200, body: 'Processed' };
};

// Helper: Update order in DynamoDB
async function updateOrderInDynamoDB(userId, orderId, fillQuantity, fillPrice, isFullyFilled = false) {
    const status = isFullyFilled ? 'FILLED' : 'PARTIAL';

    await ddb.send(new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { user_id: userId, order_id: orderId },
        UpdateExpression: 'SET filled_qty = if_not_exists(filled_qty, :zero) + :qty, filled_price = :fillPrice, #status = :status, updated_at = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
            ':qty': fillQuantity,
            ':zero': 0,
            ':fillPrice': fillPrice,
            ':status': status,
            ':now': new Date().toISOString()
        }
    }));
}

// Helper: Update holdings in DynamoDB with optimistic locking
async function updateHoldings(userId, symbol, quantity, price, side, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const existing = await ddb.send(new GetCommand({
                TableName: HOLDINGS_TABLE,
                Key: { user_id: userId, symbol: symbol.toUpperCase() }
            }));

            const currentQty = existing.Item?.quantity || 0;
            const currentLocked = existing.Item?.locked || 0;
            const currentVersion = existing.Item?.version || 0;
            const currentAvgPrice = existing.Item?.avg_price || 0;
            const currentTotalCost = currentQty * currentAvgPrice;

            let newQty, newAvgPrice, newLocked;

            if (side === 'BUY') {
                const fillCost = quantity * price;
                newQty = currentQty + quantity;
                newAvgPrice = newQty > 0 ? Math.round((currentTotalCost + fillCost) / newQty * 10) / 10 : price;
                newLocked = currentLocked;
            } else {
                newQty = Math.max(0, currentQty - quantity);
                newLocked = Math.max(0, currentLocked - quantity);
                newAvgPrice = newQty > 0 ? currentAvgPrice : 0;
            }

            if (newQty <= 0) {
                try {
                    await ddb.send(new DeleteCommand({
                        TableName: HOLDINGS_TABLE,
                        Key: { user_id: userId, symbol: symbol.toUpperCase() },
                        ConditionExpression: 'version = :ver OR attribute_not_exists(version)',
                        ExpressionAttributeValues: { ':ver': currentVersion }
                    }));
                    return;
                } catch (deleteErr) {
                    if (deleteErr.name === 'ConditionalCheckFailedException') {
                        await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
                        continue;
                    }
                    if (deleteErr.name !== 'ResourceNotFoundException') throw deleteErr;
                }
            } else {
                try {
                    if (existing.Item) {
                        await ddb.send(new UpdateCommand({
                            TableName: HOLDINGS_TABLE,
                            Key: { user_id: userId, symbol: symbol.toUpperCase() },
                            UpdateExpression: 'SET quantity = :qty, locked = :locked, avg_price = :avgPrice, version = :newVer, updated_at = :now',
                            ConditionExpression: 'version = :ver OR attribute_not_exists(version)',
                            ExpressionAttributeValues: {
                                ':qty': newQty,
                                ':locked': newLocked,
                                ':avgPrice': newAvgPrice,
                                ':ver': currentVersion,
                                ':newVer': currentVersion + 1,
                                ':now': new Date().toISOString()
                            }
                        }));
                    } else {
                        await ddb.send(new PutCommand({
                            TableName: HOLDINGS_TABLE,
                            Item: {
                                user_id: userId,
                                symbol: symbol.toUpperCase(),
                                quantity: newQty,
                                locked: newLocked,
                                avg_price: newAvgPrice,
                                version: 1,
                                updated_at: new Date().toISOString()
                            },
                            ConditionExpression: 'attribute_not_exists(user_id)'
                        }));
                    }
                    return;
                } catch (condErr) {
                    if (condErr.name === 'ConditionalCheckFailedException') {
                        await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
                        continue;
                    }
                    throw condErr;
                }
            }
        } catch (err) {
            if (attempt === maxRetries - 1) throw err;
        }
    }
    throw new Error(`Holdings update failed after ${maxRetries} retries`);
}

// Helper: Update buyer wallet (locked 차감)
async function updateBuyerWallet(client, userId, amount, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const { data: wallet, error: fetchErr } = await client
            .from('wallets')
            .select('locked')
            .eq('user_id', userId)
            .eq('currency', 'BOLT')
            .single();

        if (fetchErr || !wallet) {
            console.warn(`[Wallet] Buyer ${userId}: wallet not found`);
            return;
        }

        const newLocked = Math.max(0, (wallet.locked || 0) - amount);

        const { error: updateErr } = await client
            .from('wallets')
            .update({ locked: newLocked })
            .eq('user_id', userId)
            .eq('currency', 'BOLT')
            .eq('locked', wallet.locked);

        if (!updateErr) {
            console.log(`[Wallet] Buyer ${userId}: locked → ${newLocked}`);
            return;
        }
        await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
    }
    console.error(`[Wallet] Buyer ${userId}: update failed after ${maxRetries} retries`);
    throw new Error(`Buyer wallet update failed for ${userId}`);
}

// Helper: Update seller wallet (available 증가)
async function updateSellerWallet(client, userId, amount, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const { data: wallet, error: fetchErr } = await client
            .from('wallets')
            .select('available')
            .eq('user_id', userId)
            .eq('currency', 'BOLT')
            .single();

        if (fetchErr || !wallet) {
            console.warn(`[Wallet] Seller ${userId}: wallet not found`);
            return;
        }

        const newAvailable = (wallet.available || 0) + amount;

        const { error: updateErr } = await client
            .from('wallets')
            .update({ available: newAvailable })
            .eq('user_id', userId)
            .eq('currency', 'BOLT')
            .eq('available', wallet.available);

        if (!updateErr) {
            console.log(`[Wallet] Seller ${userId}: available → ${newAvailable}`);
            return;
        }
        await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
    }
    console.error(`[Wallet] Seller ${userId}: update failed after ${maxRetries} retries`);
    throw new Error(`Seller wallet update failed for ${userId}`);
}
