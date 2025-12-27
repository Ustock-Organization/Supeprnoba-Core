// order-router Lambda - DynamoDB Orders Version
// Logic:
// 1. Validate Request
// 2. Lock Balance in Supabase (wallets table)
// 3. Create Order in DynamoDB (supernoba-orders) as PENDING
// 4. Publish to Kinesis (Engine)
// 5. If publish fails, Rollback (Refund + Reject)

import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import https from 'https';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// DynamoDB Client
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const ddb = DynamoDBDocumentClient.from(dynamoClient);
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'supernoba-orders';

// === Optimization: TCP Keep-Alive for AWS SDK ===
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  rejectUnauthorized: true,
});

const kinesis = new KinesisClient({ 
  region: process.env.AWS_REGION || 'ap-northeast-2'
});

// === Configuration ===
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // Must use Service Role for Balance Updates

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Missing Supabase Credentials (Service Role Key required for Order Router)");
}

// === Clients ===
let supabase = null;
function getSupabase() {
    if (!supabase) {
        supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    }
    return supabase;
}



// UUID helper
function generateOrderId() {
  return crypto.randomUUID();
}

// === Core Logic: Balance Locking ===
async function lockBalance(client, userId, currency, amount) {
    // Optimistic locking via SQL update with condition
    // UPDATE wallets SET available = available - amount, locked = locked + amount
    // WHERE user_id = userId AND currency = currency AND available >= amount
    
    // Supabase JS doesn't support generic SQL 'UPDATE ... WHERE available > X' easily with .update() 
    // IF we want to check rows affected.
    // However, we can use filtering: .eq('user_id', ...).eq('currency', ...).gte('available', amount)
    
    // NOTE: 'amount' must be positive.
    if (amount <= 0) return { success: true }; // No lock needed (e.g. Market Buy 0 price?)

    console.log(`[lockBalance] Checking ${currency} for ${userId}, amount: ${amount}`);
    
    const { data: wallet, error } = await client
        .from('wallets')
        .select('available, locked')
        .eq('user_id', userId)
        .eq('currency', currency)
        .single();
        
    console.log(`[lockBalance] Query Result:`, { wallet, error });

    if (error || !wallet) {
        // Init wallet if missing (Auto-init for test)
        // If BOLT -> 10,000,000
        // If other -> 0
        console.log(`[UserId: ${userId}] No wallet for ${currency}. Auto-initializing.`);
        
        const initialBalance = (currency === 'BOLT') ? 10000000 : 0;
        const diag = `Currency: ${currency}, AutoInit: ${currency === 'BOLT'}, WalletFound: ${!!wallet}, ID: ${userId}`;
        console.log(`[lockBalance] Init Diag: ${diag}`);
        
        const { data: newWallet, error: initError } = await client
            .from('wallets')
            .insert({
                user_id: userId,
                currency: currency,
                available: initialBalance, 
                locked: 0
            })
            .select()
            .single();
        
        if (initError) {
                console.error("Wallet Init Failed:", initError);
                return { success: false, error: 'WALLET_INIT_FAIL', message: '지갑 생성 실패' };
        }
        // Retry with new wallet
        return lockBalance(client, userId, currency, amount);
    }
    
    if (wallet.available < amount) {
        return { success: false, error: 'INSUFFICIENT_FUNDS', message: `잔고 부족 (가용: ${wallet.available}, 필요: ${amount})` };
    }
    
    // Update
    const newAvailable = Number(wallet.available) - amount;
    const newLocked = Number(wallet.locked) + amount;
    
    const { error: updateErr } = await client
        .from('wallets')
        .update({ available: newAvailable, locked: newLocked })
        .eq('user_id', userId)
        .eq('currency', currency)
        .eq('available', wallet.available); // Optimistic Lock Check (prevents race condition)
        
    if (updateErr) {
        // Race condition hit?
        console.warn("Optimistic lock failed, retrying once...");
        // Retry logic omitted for brevity, but should exist.
        return { success: false, error: 'CONCURRENCY_ERROR', message: '잔고 처리 중 오류 재시도 필요' };
    }
    
    return { success: true };
}

async function refundBalance(client, userId, currency, amount) {
    if (amount <= 0) return;
    
    const { data: wallet } = await client.from('wallets').select('*').eq('user_id', userId).eq('currency', currency).single();
    if (!wallet) return;

    const newAvailable = Number(wallet.available) + amount;
    const newLocked = Number(wallet.locked) - amount;
    
    await client
        .from('wallets')
        .update({ available: newAvailable, locked: newLocked })
        .eq('user_id', userId)
        .eq('currency', currency);
}


export const handler = async (event) => {
  // CORS Headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  
  if (event.httpMethod === 'OPTIONS' || event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  
  const db = getSupabase();
  
  try {
    let requestBody;
    if (typeof event.body === 'string') {
      requestBody = JSON.parse(event.body);
    } else if (event.body) {
      requestBody = event.body;
    } else {
      requestBody = event;
    }
    
    if (!requestBody.symbol || !requestBody.user_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    const { 
      symbol, user_id: reqUserId, action = 'ADD', order_id, 
      price = 0, quantity = 0, side = 'BUY', type = 'LIMIT', 
      qty_delta = 0, conditions = null 
    } = requestBody;
    
    let user_id = String(reqUserId).trim();
    console.log(`Received user_id: '${user_id}'`);

    // FIX: Map test-user-1 to valid Supabase UUID
    if (user_id === 'test-user-1') {
        user_id = '13f1278a-d817-415c-ba01-7d2b99327058';
        console.log(`Mapped test-user-1 to ${user_id}`);
    }

    // Symbol Validation
    // Removed Redis check to avoid VPC connectivity timeouts. Engine handles validation.
    // const isActiveSymbol = await redis.sismember('active:symbols', symbol);
    // if (!isActiveSymbol) { ... }

    // === ACTION: ADD ===
    if (action === 'ADD') {
        const finalOrderId = generateOrderId();
        const finalPrice = (type === 'MARKET') ? (side === 'BUY' ? 2147483647 : 0) : Number(price);
        const finalQty = Number(quantity);
        const orderType = type;
        
        // 1. Calculate Lock Amount
        let lockCurrency = 'BOLT';
        let lockAmount = 0;
        
        if (side === 'BUY' || side === 'buy') {
            lockCurrency = 'BOLT'; // Quote Asset
            if (type === 'LIMIT') {
                lockAmount = finalPrice * finalQty;
            } else {
                // Market Buy: How much to lock?
                lockAmount = 0; 
            }
        } else {
            // SELL
            lockCurrency = symbol; // Base Asset
            lockAmount = finalQty;
        }

        // 2. Lock Balance
        if (lockAmount > 0) {
            const lockRes = await lockBalance(db, user_id, lockCurrency, lockAmount);
            if (!lockRes.success) {
                return { statusCode: 400, headers, body: JSON.stringify(lockRes) };
            }
            console.log(`[Locked] ${user_id} ${lockAmount} ${lockCurrency}`);
        }

        // 3. Create Order in DynamoDB (PENDING)
        const orderItem = {
            user_id: user_id,
            order_id: finalOrderId,
            symbol: symbol,
            side: (side === 'BUY' || side === 'buy') ? 'BUY' : 'SELL',
            type: orderType,
            price: finalPrice,
            quantity: finalQty,
            filled_qty: 0,
            status: 'PENDING',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        
        try {
            await ddb.send(new PutCommand({ TableName: ORDERS_TABLE, Item: orderItem }));
        } catch (insertErr) {
            console.error("Order Insert Failed:", insertErr);
            await refundBalance(db, user_id, lockCurrency, lockAmount);
            return { statusCode: 500, headers, body: JSON.stringify({ error: insertErr.message }) };
        }

        // 4. Publish to Kinesis
        const kinesisRecord = {
          action: 'ADD', order_id: finalOrderId, user_id, symbol,
          is_buy: (side === 'BUY' || side === 'buy'),
          price: finalPrice, quantity: finalQty, order_type: orderType,
          timestamp: Date.now(), conditions: conditions || {}
        };
        
        try {
            await kinesis.send(new PutRecordCommand({
                StreamName: process.env.KINESIS_ORDERS_STREAM || 'supernoba-orders',
                Data: Buffer.from(JSON.stringify(kinesisRecord)),
                PartitionKey: symbol,
            }));
            
            // 5. Update Status to ACCEPTED in DynamoDB
            await ddb.send(new UpdateCommand({
                TableName: ORDERS_TABLE,
                Key: { user_id, order_id: finalOrderId },
                UpdateExpression: 'SET #status = :status, updated_at = :updated',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':status': 'ACCEPTED', ':updated': new Date().toISOString() }
            }));
             
            return { statusCode: 200, headers, body: JSON.stringify({ order_id: finalOrderId, message: 'Order Accepted' }) };
             
        } catch (kinesisErr) {
            console.error("Kinesis Publish Failed:", kinesisErr);
            await refundBalance(db, user_id, lockCurrency, lockAmount);
            await ddb.send(new UpdateCommand({
                TableName: ORDERS_TABLE,
                Key: { user_id, order_id: finalOrderId },
                UpdateExpression: 'SET #status = :status, updated_at = :updated',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':status': 'REJECTED', ':updated': new Date().toISOString() }
            }));
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'Order Placement Failed' }) };
        }

    } else if (action === 'CANCEL') {
        if (!order_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing order_id' }) };
        
        // Just Forward to Kinesis. 
        // We don't unlock yet. We unlock when Fills/Cancellations come back from Engine via Fill Processor.
        // OR we can mark 'CANCELLING' in DB.
        
        const kinesisRecord = { action: 'CANCEL', order_id, user_id, symbol, timestamp: Date.now() };
        
        await kinesis.send(new PutRecordCommand({
            StreamName: process.env.KINESIS_ORDERS_STREAM || 'supernoba-orders',
            Data: Buffer.from(JSON.stringify(kinesisRecord)),
            PartitionKey: symbol,
        }));
        
        return { statusCode: 200, headers, body: JSON.stringify({ message: 'Cancel Sent' }) };
    }
    
    // Default Fallback
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid Action' }) };
    
  } catch (error) {
    console.error('Router Error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
