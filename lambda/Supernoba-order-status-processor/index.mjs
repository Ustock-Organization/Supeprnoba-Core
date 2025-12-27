// Supernoba-order-status-processor
// Trigger: Kinesis Stream (supernoba-order-status)
// Logic: 
//   1. Update DynamoDB orders (status)
//   2. Handle balance unlocking for CANCELLED orders
//   3. Send WebSocket notifications for FILLED orders

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import Redis from 'ioredis';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const WS_ENDPOINT = process.env.WS_ENDPOINT;
const REDIS_HOST = process.env.VALKEY_HOST;
const REDIS_PORT = process.env.VALKEY_PORT || 6379;
const VALKEY_TLS = process.env.VALKEY_TLS === 'true';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'supernoba-orders';

// DynamoDB Client
const dynamoClient = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(dynamoClient);

// API Gateway Client
let endpoint = WS_ENDPOINT ? WS_ENDPOINT.replace('wss://', 'https://') : null;
if (endpoint && endpoint.endsWith('/')) {
    endpoint = endpoint.slice(0, -1);
}
const apiClient = endpoint ? new ApiGatewayManagementApiClient({ 
    region: REGION, 
    endpoint: endpoint
}) : null;

// Redis Client
const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    tls: VALKEY_TLS ? {} : undefined,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
});

redis.on('error', (err) => console.error('Redis Error:', err.message));

// Supabase Client (lazy import)
let supabaseClient = null;
let createSupabaseClient = null;

async function getSupabase() {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return null;
    }
    
    if (!supabaseClient && !createSupabaseClient) {
        try {
            const supabaseModule = await import('@supabase/supabase-js');
            createSupabaseClient = supabaseModule.createClient;
            supabaseClient = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
                auth: { persistSession: false }
            });
        } catch (err) {
            console.warn(`[Supabase] Failed to import or initialize Supabase client:`, err.message);
            return null;
        }
    }
    
    return supabaseClient;
}

export const handler = async (event) => {
    const records = event.Records || [];
    console.log(`[order-status-processor] Processing ${records.length} records...`);

    const results = await Promise.allSettled(records.map(async (record) => {
        try {
            // 1. Parse Data (Base64 -> JSON)
            const payload = Buffer.from(record.kinesis.data, 'base64').toString('utf-8');
            const data = JSON.parse(payload);
            
            if (data.event !== 'ORDER_STATUS') {
                console.log(`[order-status-processor] Skipping non-ORDER_STATUS event: ${data.event}`);
                return;
            }

            console.log(`[order-status-processor] Processing ORDER_STATUS: ${data.order_id} (${data.symbol}) status=${data.status}`);

            // 2. Update DynamoDB order status
            await updateOrderStatusInDynamoDB(
                data.user_id,
                data.order_id,
                data.status
            );
            console.log(`[order-status-processor] [DynamoDB] Updated order status to ${data.status}: ${data.order_id}`);

            // 3. Handle specific status types
            if (data.status === 'CANCELLED') {
                // Cancel 시 잔고 해제
                await handleCancel(data);
            } else if (data.status === 'FILLED') {
                // FILLED 시 WebSocket 알림 전송
                await handleFilled(data);
            }

        } catch (e) {
            console.error("[order-status-processor] Record Processing Error:", e.message);
            throw e; // Kinesis will retry the batch if we throw
        }
    }));

    // Check failures
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
        console.error(`[order-status-processor] Batch completed with ${failures.length} errors.`);
    } else {
        console.log("[order-status-processor] Batch processed successfully.");
    }

    return { statusCode: 200, body: 'Processed' };
};

// Helper: Update order status in DynamoDB
async function updateOrderStatusInDynamoDB(userId, orderId, status) {
    try {
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
    } catch (err) {
        console.error(`[order-status-processor] DynamoDB status update failed for ${orderId}:`, err.message);
        throw err;
    }
}

// Helper: Handle CANCELLED status (unlock balance)
async function handleCancel(data) {
    const client = await getSupabase();
    if (!client || !data.symbol) {
        return;
    }

    try {
        const orderResult = await ddb.send(new GetCommand({
            TableName: ORDERS_TABLE,
            Key: { user_id: data.user_id, order_id: data.order_id }
        }));
        
        if (orderResult.Item) {
            const order = orderResult.Item;
            const remainingQty = Number(order.quantity) - Number(order.filled_qty || 0);
            const lockAmount = Number(order.price) * remainingQty;
            
            if (lockAmount > 0 && order.side === 'BUY') {
                const { data: wallet, error: walletError } = await client
                    .from('wallets')
                    .select('available, locked')
                    .eq('user_id', data.user_id)
                    .eq('currency', data.symbol)
                    .single();
                
                if (!walletError && wallet) {
                    const newAvailable = Number(wallet.available) + lockAmount;
                    const newLocked = Math.max(0, Number(wallet.locked) - lockAmount);
                    
                    const { error: updateError } = await client
                        .from('wallets')
                        .update({ available: newAvailable, locked: newLocked })
                        .eq('user_id', data.user_id)
                        .eq('currency', data.symbol);
                    
                    if (updateError) {
                        console.error(`[order-status-processor] Failed to unlock balance for ${data.order_id}:`, updateError.message);
                    } else {
                        console.log(`[order-status-processor] Unlocked balance for ${data.order_id}: ${lockAmount} ${data.symbol}`);
                    }
                }
            }
        }
    } catch (unlockErr) {
        console.error(`[order-status-processor] Unlock balance exception for ${data.order_id}:`, unlockErr.message);
    }
}

// Helper: Handle FILLED status (send WebSocket notification)
async function handleFilled(data) {
    if (!apiClient) {
        console.warn(`[order-status-processor] API Gateway client not initialized, cannot send FILLED notification`);
        return;
    }

    // Get connections from Redis
    const key = `user:${data.user_id}:connections`;
    const connections = await redis.smembers(key);
    
    if (!connections || connections.length === 0) {
        console.log(`[order-status-processor] No connections found for user ${data.user_id}`);
        return;
    }

    // Get order details from DynamoDB
    const orderResult = await ddb.send(new GetCommand({
        TableName: ORDERS_TABLE,
        Key: { user_id: data.user_id, order_id: data.order_id }
    }));

    if (!orderResult.Item) {
        console.warn(`[order-status-processor] Order not found: ${data.order_id}`);
        return;
    }

    const order = orderResult.Item;

    // Construct message
    const message = {
        type: 'ORDER_STATUS',
        data: {
            order_id: data.order_id,
            symbol: data.symbol,
            side: order.side || 'BUY',
            price: order.price,
            quantity: order.quantity,
            type: order.type || 'LIMIT',
            filled_qty: order.filled_qty || order.quantity,
            filled_price: order.filled_price || order.price,
            status: 'FILLED',
            timestamp: data.timestamp || Date.now()
        }
    };

    const msgString = JSON.stringify(message);
    const msgBuffer = Buffer.from(msgString);

    // Send to all connections
    const sendPromises = connections.map(async (connId) => {
        const startTime = Date.now();
        try {
            const command = new PostToConnectionCommand({
                ConnectionId: connId,
                Data: msgBuffer
            });
            
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('PostToConnection timeout')), 5000)
            );
            
            await Promise.race([apiClient.send(command), timeoutPromise]);
            const duration = Date.now() - startTime;
            console.log(`[order-status-processor] ✅ Sent FILLED notification to ${connId} (${duration}ms)`);
            return { success: true, connId };
        } catch (err) {
            const duration = Date.now() - startTime;
            if (err.message === 'PostToConnection timeout') {
                console.error(`[order-status-processor] ⏱️ Connection ${connId} timeout (5s)`);
            } else if (err.statusCode === 410 || err.$metadata?.httpStatusCode === 410) {
                console.log(`[order-status-processor] ⚠️ Connection ${connId} gone (410), removing.`);
                await redis.srem(key, connId);
            } else {
                console.error(`[order-status-processor] ❌ Failed to send to ${connId}:`, err.message);
            }
            return { success: false, connId, error: err.message };
        }
    });
    
    const results = await Promise.all(sendPromises);
    const successCount = results.filter(r => r.success).length;
    console.log(`[order-status-processor] Notified user ${data.user_id}: ${successCount}/${connections.length} connections succeeded.`);
}
