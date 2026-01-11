/**
 * @deprecated 2026-01-12 - stock-processor (C++)로 이전됨
 * 이전 위치: Supernoba-back/src/processors/fill_processor.cpp
 * AWS Lambda 트리거를 비활성화하고, 이 파일은 참조용으로만 보존
 */
// Supernoba-fill-processor - DynamoDB Version (Supabase Removed)
// Trigger: Kinesis Stream (supernoba-fills)
// Logic:
//   1. 원자적 트랜잭션: DynamoDB TransactWriteItems
//      - Buyer/Seller Orders 업데이트 (filled_qty, status)
//      - Buyer/Seller Holdings 업데이트 (quantity, locked, avg_price)
//      - Buyer/Seller Wallets 업데이트 (locked 감소, available 증가)
//
// 원자성 보장:
//   - Orders, Holdings, Wallets 모두 단일 트랜잭션으로 처리 (all-or-nothing)
//   - Optimistic locking (version 필드) + 자동 재시도

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';

// === Configuration ===
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'supernoba-orders';
const NOTIFICATION_STREAM = process.env.NOTIFICATION_STREAM || 'supernoba-order-status';
const HOLDINGS_TABLE = process.env.HOLDINGS_TABLE || 'supernoba-holdings';
const WALLETS_TABLE = process.env.WALLETS_TABLE || 'supernoba-wallets';
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

// Kinesis Client (for notifications after DB update)
const kinesisClient = new KinesisClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });

// Publish FILL notification to Kinesis (after DynamoDB update completes)
async function publishFillNotification(data, buyerFullyFilled, sellerFullyFilled) {
    const timestamp = Date.now();

    // FILL notification with source marker (notifier only processes events with source: 'fill-processor')
    const fillEvent = {
        event: 'FILL',
        source: 'fill-processor',  // 중요: notifier가 이 필드를 체크하여 중복 처리 방지
        trade_id: data.trade_id,
        symbol: data.symbol,
        price: data.price,
        quantity: data.quantity,
        timestamp,
        buyer: {
            user_id: data.buyer.user_id,
            order_id: data.buyer.order_id,
            fully_filled: buyerFullyFilled
        },
        seller: {
            user_id: data.seller.user_id,
            order_id: data.seller.order_id,
            fully_filled: sellerFullyFilled
        }
    };

    // 알림 전송 (재시도 포함)
    let notificationSent = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await kinesisClient.send(new PutRecordCommand({
                StreamName: NOTIFICATION_STREAM,
                Data: Buffer.from(JSON.stringify(fillEvent)),
                PartitionKey: data.buyer.user_id
            }));
            console.log(`[fill-processor] ✅ Published FILL notification for ${data.trade_id}`);
            notificationSent = true;
            break;
        } catch (err) {
            console.warn(`[fill-processor] Notification attempt ${attempt}/3 failed:`, err.message);
            if (attempt < 3) {
                await new Promise(r => setTimeout(r, 100 * attempt));
            }
        }
    }

    if (!notificationSent) {
        // 구조화된 에러 로그 (CloudWatch 알람용)
        console.error(JSON.stringify({
            level: 'ERROR',
            type: 'NOTIFICATION_FAILED',
            trade_id: data.trade_id,
            buyer_id: data.buyer.user_id,
            seller_id: data.seller.user_id,
            symbol: data.symbol,
            timestamp: Date.now(),
            message: 'Failed to publish fill notification after 3 attempts'
        }));
    }
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

            // Market Maker 체크 (MM은 wallet 업데이트 스킵)
            const [buyerIsMarketMaker, sellerIsMarketMaker] = await Promise.all([
                isMarketMaker(data.buyer.user_id),
                isMarketMaker(data.seller.user_id)
            ]);

            // 원자적 트랜잭션: Orders + Holdings + Wallets 모두 한번에 처리
            const buyerFullyFilled = data.buyer?.fully_filled === true;
            const sellerFullyFilled = data.seller?.fully_filled === true;

            await processFillAtomic(data, buyerFullyFilled, sellerFullyFilled, buyerIsMarketMaker, sellerIsMarketMaker);
            console.log(`[DynamoDB] Atomic transaction completed: orders, holdings, wallets updated`);

            // DynamoDB 업데이트 완료 후 알림 발행 (순서 보장)
            await publishFillNotification(data, buyerFullyFilled, sellerFullyFilled);

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
// 원자적 트랜잭션 처리 (Orders + Holdings + Wallets)
// ========================================
async function processFillAtomic(data, buyerFullyFilled, sellerFullyFilled, buyerIsMarketMaker = false, sellerIsMarketMaker = false, maxRetries = 3) {
    const symbol = data.symbol.toUpperCase();
    const quantity = data.quantity;
    const price = data.price;
    const tradeValue = price * quantity;
    const now = new Date().toISOString();

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            // 1. Holdings 및 Wallets 현재 상태 조회 (트랜잭션 구성을 위해)
            const queries = [
                ddb.send(new GetCommand({
                    TableName: HOLDINGS_TABLE,
                    Key: { user_id: data.buyer.user_id, symbol }
                })),
                ddb.send(new GetCommand({
                    TableName: HOLDINGS_TABLE,
                    Key: { user_id: data.seller.user_id, symbol }
                }))
            ];

            // MM이 아닌 경우에만 wallet 조회 추가
            if (!buyerIsMarketMaker) {
                queries.push(ddb.send(new GetCommand({
                    TableName: WALLETS_TABLE,
                    Key: { user_id: data.buyer.user_id, currency: 'BOLT' }
                })));
            }
            if (!sellerIsMarketMaker) {
                queries.push(ddb.send(new GetCommand({
                    TableName: WALLETS_TABLE,
                    Key: { user_id: data.seller.user_id, currency: 'BOLT' }
                })));
            }

            const results = await Promise.all(queries);
            const [buyerHolding, sellerHolding] = results;
            let buyerWallet = null, sellerWallet = null;
            let walletIndex = 2;
            if (!buyerIsMarketMaker) buyerWallet = results[walletIndex++];
            if (!sellerIsMarketMaker) sellerWallet = results[walletIndex];

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

            // 4-5. Buyer Wallet 업데이트 (locked 차감 - 체결된 금액만큼 locked 감소)
            if (!buyerIsMarketMaker && buyerWallet?.Item) {
                const bwCurrent = buyerWallet.Item;
                const bwNewLocked = Math.max(0, (bwCurrent.locked || 0) - tradeValue);
                const bwVersion = bwCurrent.version || 0;

                transactItems.push({
                    Update: {
                        TableName: WALLETS_TABLE,
                        Key: { user_id: data.buyer.user_id, currency: 'BOLT' },
                        UpdateExpression: 'SET locked = :locked, version = :newVer, updated_at = :now',
                        ConditionExpression: 'version = :ver OR attribute_not_exists(version)',
                        ExpressionAttributeValues: {
                            ':locked': bwNewLocked,
                            ':ver': bwVersion,
                            ':newVer': bwVersion + 1,
                            ':now': now
                        }
                    }
                });
            }

            // 4-6. Seller Wallet 업데이트 (available 증가 - 판매 대금 수령)
            if (!sellerIsMarketMaker && sellerWallet?.Item) {
                const swCurrent = sellerWallet.Item;
                const swNewAvailable = (swCurrent.available || 0) + tradeValue;
                const swVersion = swCurrent.version || 0;

                transactItems.push({
                    Update: {
                        TableName: WALLETS_TABLE,
                        Key: { user_id: data.seller.user_id, currency: 'BOLT' },
                        UpdateExpression: 'SET available = :available, version = :newVer, updated_at = :now',
                        ConditionExpression: 'version = :ver OR attribute_not_exists(version)',
                        ExpressionAttributeValues: {
                            ':available': swNewAvailable,
                            ':ver': swVersion,
                            ':newVer': swVersion + 1,
                            ':now': now
                        }
                    }
                });
            }

            // 5. 트랜잭션 실행
            await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));

            console.log(`[Atomic] Trade ${data.trade_id}: Orders + Holdings + Wallets updated atomically`);
            return;

        } catch (err) {
            if (err.name === 'TransactionCanceledException') {
                const reasons = err.CancellationReasons || [];
                console.warn(`[Atomic] Transaction cancelled (attempt ${attempt + 1}/${maxRetries}):`,
                    reasons.map(r => r.Code).join(', '));

                // ConditionalCheckFailed 또는 TransactionConflict면 재시도
                if (reasons.some(r => r.Code === 'ConditionalCheckFailed' || r.Code === 'TransactionConflict')) {
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
