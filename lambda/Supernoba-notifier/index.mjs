/**
 * @deprecated 2026-01-12 - stock-processor (C++)로 이전됨
 * 이전 위치: Supernoba-back/src/processors/notification_processor.cpp
 * AWS Lambda 트리거를 비활성화하고, 이 파일은 참조용으로만 보존
 */
// Supernoba-notifier
// Trigger: Kinesis Streams (supernoba-fills, supernoba-order-status)
// Logic: Send WebSocket notifications to users for order updates

import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import Redis from 'ioredis';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const WS_ENDPOINT = process.env.WS_ENDPOINT;
const REDIS_HOST = process.env.VALKEY_HOST;
const REDIS_PORT = process.env.VALKEY_PORT || 6379;
const VALKEY_TLS = process.env.VALKEY_TLS === 'true';

// API Gateway Client
let endpoint = WS_ENDPOINT ? WS_ENDPOINT.replace('wss://', 'https://') : null;
if (endpoint && endpoint.endsWith('/')) endpoint = endpoint.slice(0, -1);

const apiClient = endpoint ? new ApiGatewayManagementApiClient({
    region: REGION,
    endpoint: endpoint
}) : null;

// Redis Client (Fixed: lazyConnect for cold start optimization)
const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    tls: VALKEY_TLS ? {} : undefined,
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => times <= 2 ? 1000 : null,
});

redis.on('error', (err) => console.error('Redis Error:', err.message));

// Ensure Redis connection before operations
async function ensureConnected() {
    if (redis.status === 'ready') return true;
    try {
        if (redis.status === 'wait') await redis.connect();
        return redis.status === 'ready';
    } catch (err) {
        console.error('[notifier] Redis connect error:', err.message);
        return false;
    }
}

export const handler = async (event) => {
    console.log(`[notifier] Received ${event.Records.length} records.`);

    // Ensure Redis is connected
    await ensureConnected();

    const failedRecords = [];

    for (let i = 0; i < event.Records.length; i++) {
        const record = event.Records[i];
        try {
            const payloadStr = Buffer.from(record.kinesis.data, 'base64').toString('utf-8');
            const data = JSON.parse(payloadStr);

            // Handle FILL events (체결 알림)
            // 중요: fill-processor에서 발행한 이벤트만 처리 (DynamoDB 업데이트 완료 후)
            // source가 없는 FILL 이벤트는 C++에서 직접 발행한 것이므로 무시 (race condition 방지)
            if (data.event === 'FILL' && data.source === 'fill-processor') {
                await handleFillEvent(data);
            }
            // Handle ORDER_STATUS events (상태 변경 알림)
            else if (data.event === 'ORDER_STATUS') {
                await handleOrderStatusEvent(data);
            }

        } catch (err) {
            console.error('[notifier] Error:', err.message);
            failedRecords.push({ itemIdentifier: record.kinesis.sequenceNumber });
        }
    }

    if (failedRecords.length > 0) {
        console.error(`[notifier] ${failedRecords.length} records failed`);
        return { batchItemFailures: failedRecords };
    }
    return { statusCode: 200, body: 'Processed' };
};

// Handle FILL event - notify both buyer and seller
async function handleFillEvent(data) {
    console.log(`[notifier] FILL: ${data.trade_id} (${data.symbol})`);

    // Notify buyer
    if (data.buyer?.user_id) {
        const message = {
            type: 'ORDER_STATUS',
            data: {
                order_id: data.buyer.order_id,
                symbol: data.symbol,
                side: 'BUY',
                price: data.price,
                quantity: data.quantity,
                filled_qty: data.quantity,
                filled_price: data.price,
                status: data.buyer.fully_filled ? 'FILLED' : 'PARTIAL',
                timestamp: data.timestamp
            }
        };
        await notifyUser(data.buyer.user_id, message);
    }

    // Notify seller
    if (data.seller?.user_id) {
        const message = {
            type: 'ORDER_STATUS',
            data: {
                order_id: data.seller.order_id,
                symbol: data.symbol,
                side: 'SELL',
                price: data.price,
                quantity: data.quantity,
                filled_qty: data.quantity,
                filled_price: data.price,
                status: data.seller.fully_filled ? 'FILLED' : 'PARTIAL',
                timestamp: data.timestamp
            }
        };
        await notifyUser(data.seller.user_id, message);
    }
}

// Handle ORDER_STATUS event - notify the user
async function handleOrderStatusEvent(data) {
    console.log(`[notifier] ORDER_STATUS: ${data.order_id} status=${data.status}`);

    if (!data.user_id) return;

    const message = {
        type: 'ORDER_STATUS',
        data: {
            order_id: data.order_id,
            symbol: data.symbol,
            status: data.status,
            timestamp: data.timestamp || Date.now()
        }
    };

    await notifyUser(data.user_id, message);
}

// Send WebSocket message to all user connections
async function notifyUser(userId, message) {
    if (!apiClient) {
        console.error('[notifier] API Gateway client not initialized');
        return;
    }

    const key = `user:${userId}:connections`;
    const connections = await redis.smembers(key);

    if (!connections || connections.length === 0) {
        console.log(`[notifier] No connections for user ${userId}`);
        return;
    }

    const msgBuffer = Buffer.from(JSON.stringify(message));

    const sendPromises = connections.map(async (connId) => {
        try {
            const command = new PostToConnectionCommand({
                ConnectionId: connId,
                Data: msgBuffer
            });

            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout')), 5000)
            );

            await Promise.race([apiClient.send(command), timeoutPromise]);
            return { success: true, connId };
        } catch (err) {
            if (err.statusCode === 410 || err.$metadata?.httpStatusCode === 410) {
                await redis.srem(key, connId);
                console.log(`[notifier] Removed stale connection: ${connId}`);
            }
            return { success: false, connId };
        }
    });

    const results = await Promise.all(sendPromises);
    const successCount = results.filter(r => r.success).length;
    console.log(`[notifier] Notified ${userId}: ${successCount}/${connections.length}`);
}
