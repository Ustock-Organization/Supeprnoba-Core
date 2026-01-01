// order-router Lambda - Lightweight Version
// Core: Lock Balance/Holdings -> Publish to Kinesis
// Removed: Settings check, Symbol validation, User suspension check, Order storage (moved to wrapper)

import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// === Clients (Singleton) ===
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));
const kinesis = new KinesisClient({ region: 'ap-northeast-2' });
let supabase = null;

// === Config ===
const HOLDINGS_TABLE = process.env.HOLDINGS_TABLE || 'supernoba-holdings';
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'supernoba-orders';
const KINESIS_STREAM = process.env.KINESIS_ORDERS_STREAM || 'supernoba-orders';
const HEADERS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

const getSupabase = () => supabase || (supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY));

// === Balance Lock (Supabase - BUY orders) ===
async function lockBalance(db, userId, amount) {
  if (amount <= 0) return { success: true };

  const { data: wallet, error } = await db.from('wallets').select('available, locked').eq('user_id', userId).eq('currency', 'BOLT').single();

  if (error || !wallet) {
    const { error: initErr } = await db.from('wallets').insert({ user_id: userId, currency: 'BOLT', available: 0, locked: 0 });
    if (initErr) return { success: false, error: 'WALLET_INIT_FAIL', message: '지갑 생성 실패' };
    return lockBalance(db, userId, amount);
  }

  if (wallet.available < amount) return { success: false, error: 'INSUFFICIENT_FUNDS', message: `잔고 부족 (가용: ${wallet.available})` };

  const { error: updateErr } = await db.from('wallets')
    .update({ available: wallet.available - amount, locked: wallet.locked + amount })
    .eq('user_id', userId).eq('currency', 'BOLT').eq('available', wallet.available);

  return updateErr ? { success: false, error: 'CONCURRENCY_ERROR', message: '재시도 필요' } : { success: true };
}

async function unlockBalance(db, userId, amount) {
  if (amount <= 0) return;
  const { data } = await db.from('wallets').select('available, locked').eq('user_id', userId).eq('currency', 'BOLT').single();
  if (data) await db.from('wallets').update({ available: data.available + amount, locked: data.locked - amount }).eq('user_id', userId).eq('currency', 'BOLT');
}

// === Holdings Lock (DynamoDB - SELL orders) ===
// Fixed: OCC pattern - read then conditional update (prevents TOCTOU via exact value matching)
async function lockHoldings(userId, symbol, amount) {
  if (amount <= 0) return { success: true };

  try {
    // Step 1: Read current state
    const { Item } = await ddb.send(new GetCommand({
      TableName: HOLDINGS_TABLE,
      Key: { user_id: userId, symbol: symbol.toUpperCase() }
    }));

    if (!Item || !Item.quantity) {
      return { success: false, error: 'NO_HOLDINGS', message: `보유 수량이 없습니다 (${symbol})` };
    }

    const currentQty = Item.quantity || 0;
    const currentLocked = Item.locked || 0;
    const available = currentQty - currentLocked;

    if (available < amount) {
      return { success: false, error: 'INSUFFICIENT_FUNDS', message: `잔고 부족 (${symbol})` };
    }

    // Step 2: Atomic update with OCC (fails if values changed since read)
    await ddb.send(new UpdateCommand({
      TableName: HOLDINGS_TABLE,
      Key: { user_id: userId, symbol: symbol.toUpperCase() },
      UpdateExpression: 'SET locked = :new_locked, updated_at = :now',
      ConditionExpression: 'quantity = :qty AND (attribute_not_exists(locked) OR locked = :current_locked)',
      ExpressionAttributeValues: {
        ':new_locked': currentLocked + amount,
        ':current_locked': currentLocked,
        ':qty': currentQty,
        ':now': new Date().toISOString()
      }
    }));
    return { success: true };
  } catch (e) {
    return e.name === 'ConditionalCheckFailedException'
      ? { success: false, error: 'CONCURRENCY_ERROR', message: '동시성 충돌, 재시도 필요' }
      : { success: false, error: 'LOCK_FAILED', message: e.message };
  }
}

async function unlockHoldings(userId, symbol, amount) {
  if (amount <= 0) return;
  try {
    const { Item } = await ddb.send(new GetCommand({ TableName: HOLDINGS_TABLE, Key: { user_id: userId, symbol: symbol.toUpperCase() } }));
    if (Item) await ddb.send(new UpdateCommand({
      TableName: HOLDINGS_TABLE,
      Key: { user_id: userId, symbol: symbol.toUpperCase() },
      UpdateExpression: 'SET locked = :locked, updated_at = :now',
      ExpressionAttributeValues: { ':locked': Math.max(0, (Item.locked || 0) - amount), ':now': new Date().toISOString() }
    }));
  } catch (e) { console.error('[unlockHoldings]', e.message); }
}

// === Main Handler ===
export const handler = async (event) => {
  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || event;
    const { symbol, user_id, action = 'ADD', order_id, price = 0, quantity = 0, side = 'BUY', type = 'LIMIT', conditions } = body;

    if (!symbol || !user_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing required fields' }) };

    const db = getSupabase();

    // === ADD Order ===
    if (action === 'ADD') {
      // MARKET 주문 임시 비활성화
      if (type === 'MARKET') {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'MARKET_ORDER_DISABLED', message: '시장가 주문은 현재 지원되지 않습니다' }) };
      }

      const orderId = crypto.randomUUID();
      const isBuy = side.toUpperCase() === 'BUY';
      const finalPrice = type === 'MARKET' ? (isBuy ? 2147483647 : 0) : Number(price);
      const finalQty = Number(quantity);

      // 입력 유효성 검증
      if (isNaN(finalQty) || finalQty <= 0) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'INVALID_QUANTITY', message: '수량은 0보다 커야 합니다' }) };
      }
      if (type === 'LIMIT' && (isNaN(finalPrice) || finalPrice <= 0)) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'INVALID_PRICE', message: '가격은 0보다 커야 합니다' }) };
      }
      const lockAmount = isBuy ? (type === 'LIMIT' ? finalPrice * finalQty : 0) : finalQty;

      // 1. Lock Balance/Holdings
      if (lockAmount > 0) {
        const lockRes = isBuy ? await lockBalance(db, user_id, lockAmount) : await lockHoldings(user_id, symbol, lockAmount);
        if (!lockRes.success) return { statusCode: 400, headers: HEADERS, body: JSON.stringify(lockRes) };
      }

      // 2. Publish to Kinesis (wrapper will save to DynamoDB)
      try {
        await kinesis.send(new PutRecordCommand({
          StreamName: KINESIS_STREAM,
          Data: Buffer.from(JSON.stringify({
            action: 'ADD',
            order_id: orderId,
            user_id,
            symbol: symbol.toUpperCase(),
            is_buy: isBuy,
            price: finalPrice,
            quantity: finalQty,
            order_type: type,
            timestamp: Date.now(),
            conditions: conditions || {}
          })),
          PartitionKey: symbol
        }));

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ order_id: orderId, message: 'Order Accepted' }) };
      } catch (e) {
        // Kinesis 발행 실패 시 잔고 해제
        isBuy ? await unlockBalance(db, user_id, lockAmount) : await unlockHoldings(user_id, symbol, lockAmount);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Order placement failed' }) };
      }
    }

    // === CANCEL Order ===
    if (action === 'CANCEL') {
      if (!order_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing order_id' }) };

      try {
        // Fixed: 주문 소유권 및 상태 확인
        const { Item: order } = await ddb.send(new GetCommand({
          TableName: ORDERS_TABLE,
          Key: { user_id, order_id }
        }));

        if (!order) {
          return { statusCode: 404, headers: HEADERS, body: JSON.stringify({
            error: 'ORDER_NOT_FOUND',
            message: '주문을 찾을 수 없거나 권한이 없습니다'
          })};
        }

        // 이미 취소/완료된 주문인지 확인
        if (['CANCELLED', 'FILLED', 'REJECTED'].includes(order.status)) {
          return { statusCode: 400, headers: HEADERS, body: JSON.stringify({
            error: 'ORDER_NOT_CANCELLABLE',
            message: `주문 상태가 ${order.status}입니다`
          })};
        }

        await kinesis.send(new PutRecordCommand({
          StreamName: KINESIS_STREAM,
          Data: Buffer.from(JSON.stringify({ action: 'CANCEL', order_id, user_id, symbol: symbol.toUpperCase(), timestamp: Date.now() })),
          PartitionKey: symbol
        }));
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ message: 'Cancel Sent' }) };
      } catch (e) {
        console.error('[order-router] CANCEL failed:', e.message);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Cancel failed' }) };
      }
    }

    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid Action' }) };
  } catch (e) {
    console.error('[order-router]', e.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: e.message }) };
  }
};
