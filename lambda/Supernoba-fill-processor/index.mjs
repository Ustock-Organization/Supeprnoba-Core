// Supernoba-fill-processor
// Trigger: Kinesis Stream (supernoba-fills)
// Logic:
//   1. 원자적 트랜잭션: DynamoDB orders + holdings (TransactWriteItems)
//      - Buyer/Seller Orders 업데이트 (filled_qty, status)
//      - Buyer/Seller Holdings 업데이트 (quantity, locked, avg_price)
//   2. Supabase wallets (BOLT balance transfer) - 별도 처리, 실패 시 로깅
//
// 원자성 보장:
//   - Orders와 Holdings는 단일 트랜잭션으로 처리 (all-or-nothing)
//   - Optimistic locking (version 필드) + 자동 재시도
//   - Supabase Wallet은 별도 처리 (DynamoDB 트랜잭션과 독립)

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand, PutCommand, DeleteCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// === Configuration ===
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'supernoba-orders';
const HOLDINGS_TABLE = process.env.HOLDINGS_TABLE || 'supernoba-holdings';
const MM_IDS_SECRET_ID = process.env.MM_IDS_SECRET_ID || 'supernoba/mm-ids';

// Secrets Manager Client
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });

// Market Maker IDs 캐시 (5분)
let cachedMmIds = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5분

async function getMarketMakerIds() {
    if (cachedMmIds && Date.now() < cacheExpiry) {
        return cachedMmIds;
    }

    try {
        const response = await secretsClient.send(
            new GetSecretValueCommand({ SecretId: MM_IDS_SECRET_ID })
        );
        const secretData = JSON.parse(response.SecretString);
        cachedMmIds = new Set(secretData.ids || []);
        cacheExpiry = Date.now() + CACHE_TTL_MS;
        console.log(`[Secrets] Loaded ${cachedMmIds.size} MM IDs from Secrets Manager`);
        return cachedMmIds;
    } catch (err) {
        console.error(`[Secrets] Failed to fetch MM IDs:`, err.message);
        // 캐시가 만료되었지만 조회 실패시 기존 캐시 반환 (graceful degradation)
        if (cachedMmIds) {
            console.warn(`[Secrets] Using stale cache with ${cachedMmIds.size} MM IDs`);
            return cachedMmIds;
        }
        // 최초 조회 실패시 빈 Set 반환 (모든 사용자를 일반 사용자로 처리)
        return new Set();
    }
}

async function isMarketMaker(userId) {
    const mmIds = await getMarketMakerIds();
    return mmIds.has(userId);
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

            // 1. Orders + Holdings 원자적 트랜잭션 처리
            const buyerFullyFilled = data.buyer?.fully_filled === true;
            const sellerFullyFilled = data.seller?.fully_filled === true;

            await processFillAtomic(data, buyerFullyFilled, sellerFullyFilled);
            console.log(`[DynamoDB] Atomic transaction completed: orders & holdings updated`);

            // 3. Update Supabase Wallets
            const [buyerIsMarketMaker, sellerIsMarketMaker] = await Promise.all([
                isMarketMaker(data.buyer.user_id),
                isMarketMaker(data.seller.user_id)
            ]);
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
                        // Wallet 실패는 DynamoDB 트랜잭션에 영향 없음 (별도 처리)
                        // 추후 DLQ 또는 재처리 큐로 전송 가능
                        console.error(`[Supabase] Wallet update FAILED - Trade ${data.trade_id}:`, {
                            error: walletErr.message,
                            buyer: !buyerIsMarketMaker ? data.buyer.user_id : 'MM',
                            seller: !sellerIsMarketMaker ? data.seller.user_id : 'MM',
                            tradeValue,
                            symbol: data.symbol,
                            quantity: data.quantity,
                            price: data.price
                        });
                        // NOTE: DynamoDB 트랜잭션은 이미 완료됨. Wallet 실패는 별도 모니터링 필요.
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

// ========================================
// 원자적 트랜잭션 처리 (Orders + Holdings)
// ========================================
async function processFillAtomic(data, buyerFullyFilled, sellerFullyFilled, maxRetries = 3) {
    const symbol = data.symbol.toUpperCase();
    const quantity = data.quantity;
    const price = data.price;
    const now = new Date().toISOString();

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            // 1. Holdings 현재 상태 조회 (트랜잭션 구성을 위해)
            const [buyerHolding, sellerHolding] = await Promise.all([
                ddb.send(new GetCommand({
                    TableName: HOLDINGS_TABLE,
                    Key: { user_id: data.buyer.user_id, symbol }
                })),
                ddb.send(new GetCommand({
                    TableName: HOLDINGS_TABLE,
                    Key: { user_id: data.seller.user_id, symbol }
                }))
            ]);

            // 2. Buyer Holdings 계산
            const buyerCurrentQty = buyerHolding.Item?.quantity || 0;
            const buyerCurrentLocked = buyerHolding.Item?.locked || 0;
            const buyerCurrentAvgPrice = buyerHolding.Item?.avg_price || 0;
            const buyerCurrentVersion = buyerHolding.Item?.version || 0;
            const buyerTotalCost = buyerCurrentQty * buyerCurrentAvgPrice;
            const fillCost = quantity * price;
            const buyerNewQty = buyerCurrentQty + quantity;
            const buyerNewAvgPrice = buyerNewQty > 0
                ? Math.round((buyerTotalCost + fillCost) / buyerNewQty * 10) / 10
                : price;

            // 3. Seller Holdings 계산
            const sellerCurrentQty = sellerHolding.Item?.quantity || 0;
            const sellerCurrentLocked = sellerHolding.Item?.locked || 0;
            const sellerCurrentAvgPrice = sellerHolding.Item?.avg_price || 0;
            const sellerCurrentVersion = sellerHolding.Item?.version || 0;
            const sellerNewQty = Math.max(0, sellerCurrentQty - quantity);
            const sellerNewLocked = Math.max(0, sellerCurrentLocked - quantity);
            const sellerNewAvgPrice = sellerNewQty > 0 ? sellerCurrentAvgPrice : 0;

            // 4. TransactWriteItems 구성
            const transactItems = [];

            // 4-1. Buyer Order 업데이트
            transactItems.push({
                Update: {
                    TableName: ORDERS_TABLE,
                    Key: { user_id: data.buyer.user_id, order_id: data.buyer.order_id },
                    UpdateExpression: 'SET filled_qty = if_not_exists(filled_qty, :zero) + :qty, filled_price = :fillPrice, #status = :status, updated_at = :now',
                    ExpressionAttributeNames: { '#status': 'status' },
                    ExpressionAttributeValues: {
                        ':qty': quantity,
                        ':zero': 0,
                        ':fillPrice': price,
                        ':status': buyerFullyFilled ? 'FILLED' : 'PARTIAL',
                        ':now': now
                    }
                }
            });

            // 4-2. Seller Order 업데이트
            transactItems.push({
                Update: {
                    TableName: ORDERS_TABLE,
                    Key: { user_id: data.seller.user_id, order_id: data.seller.order_id },
                    UpdateExpression: 'SET filled_qty = if_not_exists(filled_qty, :zero) + :qty, filled_price = :fillPrice, #status = :status, updated_at = :now',
                    ExpressionAttributeNames: { '#status': 'status' },
                    ExpressionAttributeValues: {
                        ':qty': quantity,
                        ':zero': 0,
                        ':fillPrice': price,
                        ':status': sellerFullyFilled ? 'FILLED' : 'PARTIAL',
                        ':now': now
                    }
                }
            });

            // 4-3. Buyer Holdings 업데이트 (항상 수량 증가)
            if (buyerHolding.Item) {
                transactItems.push({
                    Update: {
                        TableName: HOLDINGS_TABLE,
                        Key: { user_id: data.buyer.user_id, symbol },
                        UpdateExpression: 'SET quantity = :qty, locked = :locked, avg_price = :avgPrice, version = :newVer, updated_at = :now',
                        ConditionExpression: 'version = :ver OR attribute_not_exists(version)',
                        ExpressionAttributeValues: {
                            ':qty': buyerNewQty,
                            ':locked': buyerCurrentLocked,
                            ':avgPrice': buyerNewAvgPrice,
                            ':ver': buyerCurrentVersion,
                            ':newVer': buyerCurrentVersion + 1,
                            ':now': now
                        }
                    }
                });
            } else {
                transactItems.push({
                    Put: {
                        TableName: HOLDINGS_TABLE,
                        Item: {
                            user_id: data.buyer.user_id,
                            symbol,
                            quantity: buyerNewQty,
                            locked: 0,
                            avg_price: buyerNewAvgPrice,
                            version: 1,
                            updated_at: now
                        },
                        ConditionExpression: 'attribute_not_exists(user_id)'
                    }
                });
            }

            // 4-4. Seller Holdings 업데이트 (수량 감소, 0이면 삭제)
            if (sellerNewQty <= 0) {
                transactItems.push({
                    Delete: {
                        TableName: HOLDINGS_TABLE,
                        Key: { user_id: data.seller.user_id, symbol },
                        ConditionExpression: 'version = :ver OR attribute_not_exists(version)',
                        ExpressionAttributeValues: { ':ver': sellerCurrentVersion }
                    }
                });
            } else {
                transactItems.push({
                    Update: {
                        TableName: HOLDINGS_TABLE,
                        Key: { user_id: data.seller.user_id, symbol },
                        UpdateExpression: 'SET quantity = :qty, locked = :locked, avg_price = :avgPrice, version = :newVer, updated_at = :now',
                        ConditionExpression: 'version = :ver OR attribute_not_exists(version)',
                        ExpressionAttributeValues: {
                            ':qty': sellerNewQty,
                            ':locked': sellerNewLocked,
                            ':avgPrice': sellerNewAvgPrice,
                            ':ver': sellerCurrentVersion,
                            ':newVer': sellerCurrentVersion + 1,
                            ':now': now
                        }
                    }
                });
            }

            // 5. 트랜잭션 실행
            await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));

            console.log(`[Atomic] Trade ${data.trade_id}: Orders(buyer=${data.buyer.order_id}, seller=${data.seller.order_id}) + Holdings updated`);
            return;

        } catch (err) {
            if (err.name === 'TransactionCanceledException') {
                const reasons = err.CancellationReasons || [];
                console.warn(`[Atomic] Transaction cancelled (attempt ${attempt + 1}/${maxRetries}):`,
                    reasons.map(r => r.Code).join(', '));

                // ConditionalCheckFailed면 재시도 (optimistic locking 충돌)
                if (reasons.some(r => r.Code === 'ConditionalCheckFailed')) {
                    await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
                    continue;
                }
            }

            // 다른 에러는 로깅 후 throw
            console.error(`[Atomic] Transaction failed for trade ${data.trade_id}:`, err.message);
            throw err;
        }
    }

    throw new Error(`Atomic transaction failed after ${maxRetries} retries for trade ${data.trade_id}`);
}

// Helper: Update order in DynamoDB (레거시 - 개별 호출용)
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
