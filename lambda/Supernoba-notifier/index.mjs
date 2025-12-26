import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import Redis from 'ioredis';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const WS_ENDPOINT = process.env.WS_ENDPOINT; // e.g. https://xyz.execute-api.ap-northeast-2.amazonaws.com/production
const REDIS_HOST = process.env.VALKEY_HOST;
const REDIS_PORT = process.env.VALKEY_PORT || 6379;

// API Gateway Client (initialized once)
// Endpoint MUST NOT have wss://, map to https://
const endpoint = WS_ENDPOINT.replace('wss://', 'https://');
const apiClient = new ApiGatewayManagementApiClient({ 
    region: REGION, 
    endpoint: endpoint 
});

// Redis Client
const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    tls: {}, // Elasticache usually requires TLS if encryption in transit is on. Assuming yes or permissive.
    connectTimeout: 3000
});

redis.on('error', (err) => console.error('Redis Error:', err));

export const handler = async (event) => {
    console.log(`Received ${event.Records.length} records.`);
    
    // Batch process records
    const promises = event.Records.map(async (record) => {
        try {
            // Kinesis data is base64 encoded
            const payloadStr = Buffer.from(record.kinesis.data, 'base64').toString('utf-8');
            const data = JSON.parse(payloadStr);
            
            // We only care about FILL events for now (Engine publishes only Fills via publishFill)
            // Format from KinesisProducer::publishFill:
            // { event: "FILL", symbol, trade_id, buyer: {user_id, order_id}, seller: {...}, quantity, price, timestamp }
            
            if (data.event !== 'FILL') return;

            await notifyUser(data.buyer.user_id, data, 'BUY');
            await notifyUser(data.seller.user_id, data, 'SELL');
            
        } catch (err) {
            console.error('Failed to process record:', err);
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
    
    if (!connections || connections.length === 0) return;

    // 2. Construct Message (Frontend Format)
    // The frontend expects "ORDER_STATUS" type.
    // Based on NotificationClient::workerLoop logic I removed:
    // payload: { type: "ORDER_STATUS", data: { order_id, symbol, side, ... filled_qty, filled_price ... } }
    
    const mySideData = (side === 'BUY') ? fillData.buyer : fillData.seller;
    const orderId = mySideData.order_id;
    
    const message = {
        type: 'ORDER_STATUS',
        data: {
            order_id: orderId,
            symbol: fillData.symbol,
            side: side, // 'BUY' or 'SELL'
            price: fillData.price, // Fill Price
            quantity: fillData.quantity, // Fill Qty
            type: 'LIMIT', // Engine doesn't send type in publishFill JSON yet, assuming LIMIT or omitting.
                           // Actually Frontend might treat missing type gracefully.
            filled_qty: fillData.quantity, // This fill's qty
            filled_price: fillData.price,
            status: 'FILLED',
            timestamp: fillData.timestamp
        }
    };
    
    const msgString = JSON.stringify(message);
    const msgBuffer = Buffer.from(msgString);

    // 3. Fan-out to all connections
    const sendPromises = connections.map(async (connId) => {
        try {
            const command = new PostToConnectionCommand({
                ConnectionId: connId,
                Data: msgBuffer
            });
            await apiClient.send(command);
        } catch (err) {
            if (err.statusCode === 410) { // Gone
                console.log(`Connection ${connId} gone, removing.`);
                await redis.srem(key, connId);
            } else {
                console.error(`Failed to send to ${connId}:`, err.message);
            }
        }
    });
    
    await Promise.all(sendPromises);
    console.log(`Notified user ${userId} on ${connections.length} connections.`);
}
