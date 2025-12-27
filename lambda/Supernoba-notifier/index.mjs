import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import Redis from 'ioredis';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const WS_ENDPOINT = process.env.WS_ENDPOINT; // e.g. https://xyz.execute-api.ap-northeast-2.amazonaws.com/production
const REDIS_HOST = process.env.VALKEY_HOST;
const REDIS_PORT = process.env.VALKEY_PORT || 6379;
const VALKEY_TLS = process.env.VALKEY_TLS === 'true';

// API Gateway Client (initialized once)
// Endpoint MUST NOT have wss://, map to https://
// Also remove trailing slash if present
// Note: VPC Endpoint (vpce-086450e209ed87b06) is available for execute-api service
// AWS SDK should automatically route through VPC Endpoint when Lambda is in VPC
let endpoint = WS_ENDPOINT ? WS_ENDPOINT.replace('wss://', 'https://') : null;
if (endpoint && endpoint.endsWith('/')) {
    endpoint = endpoint.slice(0, -1);
}
if (!endpoint) {
    console.error('[notifier] WS_ENDPOINT environment variable is not set!');
}

console.log(`[notifier] API Gateway endpoint: ${endpoint}`);

// API Gateway Management API Client
// IMPORTANT: API Gateway Management API does NOT support VPC Endpoints
// Management API must be accessed via public internet through NAT Gateway
// VPC Endpoint (vpce-086450e209ed87b06) has been deleted to prevent SDK from using it
const apiClient = endpoint ? new ApiGatewayManagementApiClient({ 
    region: REGION, 
    endpoint: endpoint
}) : null;

// Redis Client (match connect-handler pattern)
const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    tls: VALKEY_TLS ? {} : undefined,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
});

redis.on('error', (err) => console.error('Redis Error:', err.message));


export const handler = async (event) => {
    console.log(`[notifier] Received ${event.Records.length} records.`);
    
    // Batch process records
    const promises = event.Records.map(async (record) => {
        try {
            // Kinesis data is base64 encoded
            const payloadStr = Buffer.from(record.kinesis.data, 'base64').toString('utf-8');
            const data = JSON.parse(payloadStr);
            
            console.log(`[notifier] Parsed data:`, JSON.stringify(data));
            
            // We only care about FILL events (ORDER_STATUS는 order-status-processor가 처리)
            // Format from KinesisProducer::publishFill:
            // { event: "FILL", symbol, trade_id, buyer: {user_id, order_id, fully_filled}, seller: {...}, quantity, price, timestamp }
            
            if (data.event !== 'FILL') {
                console.log(`[notifier] Skipping non-FILL event: ${data.event}`);
                return;
            }

            console.log(`[notifier] Processing FILL event: buyer_fully_filled=${data.buyer?.fully_filled}, seller_fully_filled=${data.seller?.fully_filled}`);

            // 전량 체결된 주문만 알림 전송 (부분 체결은 엔진에서 직접 알림)
            // NOTE: FILLED 상태 알림은 order-status-processor가 처리하므로 여기서는 제거
            // 이 Lambda는 레거시로 유지하되, 실제로는 사용하지 않음
            console.log(`[notifier] FILL event received but FILLED notifications are handled by order-status-processor`);
            
        } catch (err) {
            console.error('[notifier] Failed to process record:', err);
        }
    });

    await Promise.all(promises);
    return { statusCode: 200, body: 'Processed' };
};

// Notify a single user (Buyer or Seller)
async function notifyUser(userId, fillData, side) {
    // 1. Get Connections from Redis
    const key = `user:${userId}:connections`;
    const connections = await redis.smembers(key);
    
    console.log(`[notifier] Notifying user ${userId} (side: ${side}), connections: ${connections.length}`);
    
    if (!connections || connections.length === 0) {
        console.log(`[notifier] No connections found for user ${userId}`);
        return;
    }

    // 2. Construct Message (Frontend Format)
    // The frontend expects "ORDER_STATUS" type.
    // Based on NotificationClient::workerLoop logic I removed:
    // payload: { type: "ORDER_STATUS", data: { order_id, symbol, side, ... filled_qty, filled_price ... } }
    
    const mySideData = (side === 'BUY') ? fillData.buyer : fillData.seller;
    const orderId = mySideData.order_id;
    
    // filled_qty는 누적값이어야 함 (이번 fill의 수량이 아니라 전체 체결 수량)
    // 하지만 notifier는 각 fill마다 호출되므로, 현재는 이번 fill의 수량만 전달
    // Frontend에서 누적값을 계산하거나, fill-processor에서 업데이트된 값을 전달해야 함
    // 일단 이번 fill의 수량을 전달하고, Frontend에서 누적값으로 처리하도록 함
    const message = {
        type: 'ORDER_STATUS',
        data: {
            order_id: orderId,
            symbol: fillData.symbol,
            side: side, // 'BUY' or 'SELL'
            price: fillData.price, // Fill Price
            quantity: fillData.quantity, // Original order quantity
            type: 'LIMIT', // Engine doesn't send type in publishFill JSON yet, assuming LIMIT or omitting.
                           // Actually Frontend might treat missing type gracefully.
            filled_qty: fillData.quantity, // This fill's qty (누적값이 아님, Frontend에서 처리 필요)
            filled_price: fillData.price,
            status: mySideData.fully_filled ? 'FILLED' : 'PARTIALLY_FILLED',
            timestamp: fillData.timestamp
        }
    };
    
    console.log(`[notifier] Message payload:`, JSON.stringify(message));
    
    const msgString = JSON.stringify(message);
    const msgBuffer = Buffer.from(msgString);

    // 3. Fan-out to all connections (with timeout)
    if (!apiClient) {
        console.error('[notifier] API Gateway client not initialized, cannot send messages');
        return;
    }
    
    const sendPromises = connections.map(async (connId) => {
        const startTime = Date.now();
        try {
            console.log(`[notifier] Attempting to send to connection ${connId}...`);
            const command = new PostToConnectionCommand({
                ConnectionId: connId,
                Data: msgBuffer
            });
            
            // 타임아웃 설정 (5초)
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('PostToConnection timeout')), 5000)
            );
            
            await Promise.race([apiClient.send(command), timeoutPromise]);
            const duration = Date.now() - startTime;
            console.log(`[notifier] ✅ Sent to connection ${connId} successfully (${duration}ms)`);
            return { success: true, connId };
        } catch (err) {
            const duration = Date.now() - startTime;
            if (err.message === 'PostToConnection timeout') {
                console.error(`[notifier] ⏱️ Connection ${connId} timeout (5s, ${duration}ms elapsed)`);
            } else if (err.statusCode === 410 || err.$metadata?.httpStatusCode === 410) { // Gone
                console.log(`[notifier] ⚠️ Connection ${connId} gone (410), removing.`);
                await redis.srem(key, connId);
            } else {
                console.error(`[notifier] ❌ Failed to send to ${connId} (${duration}ms):`, err.message, err.statusCode || err.$metadata?.httpStatusCode, err.code, err.name, err.stack?.substring(0, 500));
            }
            return { success: false, connId, error: err.message };
        }
    });
    
    const results = await Promise.all(sendPromises);
    const successCount = results.filter(r => r.success).length;
    console.log(`[notifier] Notified user ${userId}: ${successCount}/${connections.length} connections succeeded.`);
}
