/**
 * @deprecated 2026-01-12 - stock-processor (C++)로 이전됨
 * 이전 위치: Supernoba-back/src/processors/order_status_processor.cpp
 * AWS Lambda 트리거를 비활성화하고, 이 파일은 참조용으로만 보존
 */
// Supernoba-order-status-processor - DynamoDB Version (Supabase Removed)
// Trigger: Kinesis Stream (supernoba-order-status)
// Logic:
//   1. ACCEPTED: Create order in DynamoDB (주문 저장)
//   2. Update DynamoDB orders (status)
//   3. CANCELLED: Unlock balance/holdings (DynamoDB)
// Note: WebSocket notifications moved to Supernoba-notifier

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'supernoba-orders';
const WALLETS_TABLE = process.env.WALLETS_TABLE || 'supernoba-wallets';
const HOLDINGS_TABLE = process.env.HOLDINGS_TABLE || 'supernoba-holdings';

// DynamoDB Client
const dynamoClient = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(dynamoClient);

export const handler = async (event) => {
    const records = event.Records || [];
    console.log(`[order-status-processor] Processing ${records.length} records...`);

    const results = await Promise.allSettled(records.map(async (record) => {
        try {
            const payload = Buffer.from(record.kinesis.data, 'base64').toString('utf-8');
            const data = JSON.parse(payload);

            if (data.event !== 'ORDER_STATUS') {
                return;
            }

            console.log(`[order-status-processor] Processing: ${data.order_id} status=${data.status}`);

            // ACCEPTED: Create order in DynamoDB (wrapper에서 주문 정보 포함)
            if (data.status === 'ACCEPTED' && data.price !== undefined && data.quantity !== undefined) {
                await createOrderInDynamoDB(data);
            } else {
                // 기타 상태: Update status only
                await updateOrderStatusInDynamoDB(data.user_id, data.order_id, data.status);
            }

            // CANCELLED: Unlock balance
            if (data.status === 'CANCELLED') {
                await handleCancel(data);
            }

        } catch (e) {
            console.error("[order-status-processor] Error:", e.message);
            throw e;
        }
    }));

    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
        console.error(`Batch completed with ${failures.length} errors.`);
        // Kinesis partial batch failure response
        const failedRecords = [];
        let failIdx = 0;
        results.forEach((r, i) => {
            if (r.status === 'rejected') {
                failedRecords.push({ itemIdentifier: records[i].kinesis.sequenceNumber });
            }
        });
        return { batchItemFailures: failedRecords };
    }

    return { statusCode: 200, body: 'Processed' };
};

// Helper: Create order in DynamoDB (ACCEPTED)
async function createOrderInDynamoDB(data) {
    const orderItem = {
        user_id: data.user_id,
        order_id: data.order_id,
        symbol: data.symbol.toUpperCase(),
        side: data.side || 'BUY',
        type: data.type || 'LIMIT',
        price: Number(data.price),
        quantity: Number(data.quantity),
        filled_qty: 0,
        status: 'ACCEPTED',
        // 시장가 주문을 위한 lock_amount 저장 (환불 시 사용)
        lock_amount: data.lock_amount ? Number(data.lock_amount) : null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    try {
        await ddb.send(new PutCommand({
            TableName: ORDERS_TABLE,
            Item: orderItem,
            ConditionExpression: 'attribute_not_exists(order_id)'
        }));
        console.log(`[order-status-processor] Created order: ${data.order_id}`);
    } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') {
            // 이미 존재하면 상태만 업데이트
            await updateOrderStatusInDynamoDB(data.user_id, data.order_id, 'ACCEPTED');
        } else {
            throw err;
        }
    }
}

// Helper: Update order status in DynamoDB
async function updateOrderStatusInDynamoDB(userId, orderId, status) {
    await ddb.send(new UpdateCommand({
        TableName: ORDERS_TABLE,
        Key: { user_id: userId, order_id: orderId },
        UpdateExpression: 'SET #status = :status, updated_at = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
            ':status': status,
            ':now': new Date().toISOString()
        }
    }));
}

// Helper: Handle CANCELLED status (unlock balance/holdings)
async function handleCancel(data) {
    try {
        const orderResult = await ddb.send(new GetCommand({
            TableName: ORDERS_TABLE,
            Key: { user_id: data.user_id, order_id: data.order_id }
        }));

        if (!orderResult.Item) return;

        const order = orderResult.Item;

        // Idempotency check: 이미 처리된 취소인지 확인
        if (order.cancel_processed === true) {
            console.log(`[order-status-processor] Cancel already processed: ${data.order_id}`);
            return;
        }

        const remainingQty = Number(order.quantity) - Number(order.filled_qty || 0);

        if (remainingQty <= 0) return;

        // 먼저 cancel_processed 플래그 설정 (원자적)
        try {
            await ddb.send(new UpdateCommand({
                TableName: ORDERS_TABLE,
                Key: { user_id: data.user_id, order_id: data.order_id },
                UpdateExpression: 'SET cancel_processed = :true',
                ConditionExpression: 'attribute_not_exists(cancel_processed) OR cancel_processed = :false',
                ExpressionAttributeValues: { ':true': true, ':false': false }
            }));
        } catch (e) {
            if (e.name === 'ConditionalCheckFailedException') {
                console.log(`[order-status-processor] Cancel already being processed: ${data.order_id}`);
                return;
            }
            throw e;
        }

        if (order.side === 'BUY') {
            // BUY 취소: DynamoDB wallet 언락
            // 시장가 주문의 경우 lock_amount 사용 (price가 2147483647이므로)
            // 지정가 주문의 경우 price * remainingQty 사용
            let lockAmount;
            if (order.lock_amount && order.type === 'MARKET') {
                // 시장가 주문: 비례 계산 (이미 체결된 수량 제외)
                const originalQty = Number(order.quantity);
                lockAmount = Math.ceil(Number(order.lock_amount) * (remainingQty / originalQty));
                console.log(`[handleCancel] MARKET order unlock: ${lockAmount} (lock_amount=${order.lock_amount}, remaining=${remainingQty}/${originalQty})`);
            } else {
                // 지정가 주문: 기존 방식
                lockAmount = Number(order.price) * remainingQty;
            }

            if (lockAmount <= 0) return;

            // DynamoDB wallet에서 locked → available 이동
            const walletResult = await ddb.send(new GetCommand({
                TableName: WALLETS_TABLE,
                Key: { user_id: data.user_id, currency: 'BOLT' }
            }));

            if (walletResult.Item) {
                const wallet = walletResult.Item;
                const newAvailable = Number(wallet.available || 0) + lockAmount;
                const newLocked = Math.max(0, Number(wallet.locked || 0) - lockAmount);
                const version = wallet.version || 0;

                await ddb.send(new UpdateCommand({
                    TableName: WALLETS_TABLE,
                    Key: { user_id: data.user_id, currency: 'BOLT' },
                    UpdateExpression: 'SET available = :available, locked = :locked, version = :newVer, updated_at = :now',
                    ConditionExpression: 'version = :ver OR attribute_not_exists(version)',
                    ExpressionAttributeValues: {
                        ':available': newAvailable,
                        ':locked': newLocked,
                        ':ver': version,
                        ':newVer': version + 1,
                        ':now': new Date().toISOString()
                    }
                }));
                console.log(`[order-status-processor] Unlocked ${lockAmount} BOLT for ${data.order_id}`);
            }
        } else if (order.side === 'SELL') {
            // SELL 취소: DynamoDB Holdings 언락
            const symbol = order.symbol || data.symbol;

            if (!symbol) return;

            const holdingsResult = await ddb.send(new GetCommand({
                TableName: HOLDINGS_TABLE,
                Key: { user_id: data.user_id, symbol: symbol.toUpperCase() }
            }));

            if (holdingsResult.Item) {
                const holding = holdingsResult.Item;
                const currentLocked = Number(holding.locked || 0);
                const newLocked = Math.max(0, currentLocked - remainingQty);
                const version = holding.version || 0;

                await ddb.send(new UpdateCommand({
                    TableName: HOLDINGS_TABLE,
                    Key: { user_id: data.user_id, symbol: symbol.toUpperCase() },
                    UpdateExpression: 'SET locked = :locked, version = :newVer, updated_at = :now',
                    ConditionExpression: 'version = :ver OR attribute_not_exists(version)',
                    ExpressionAttributeValues: {
                        ':locked': newLocked,
                        ':ver': version,
                        ':newVer': version + 1,
                        ':now': new Date().toISOString()
                    }
                }));
                console.log(`[order-status-processor] Unlocked ${remainingQty} ${symbol} holdings for ${data.order_id}`);
            }
        }
    } catch (unlockErr) {
        console.error(`[order-status-processor] Unlock error:`, unlockErr.message);
    }
}
