// order-router Lambda - Lightweight Version with Authentication
// Core: Lock Balance/Holdings -> Publish to Kinesis
// Auth: Supabase JWT verification via Lambda Layer

import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// === Auth Layer Import ===
// Layer에서 import하거나 로컬 fallback
let verifyAuth, verifySelf, authErrorResponse;
try {
  const authModule = await import('/opt/nodejs/verifyAuth.mjs');
  verifyAuth = authModule.verifyAuth;
  verifySelf = authModule.verifySelf;
  authErrorResponse = authModule.authErrorResponse;
} catch (e) {
  // Layer가 없을 경우 인증 스킵 (개발 환경용)
  console.warn('[order-router] Auth layer not available, authentication disabled');
  verifyAuth = async () => ({ success: true, userId: null, anonymous: true });
  verifySelf = async () => ({ success: true, userId: null, anonymous: true });
  authErrorResponse = (result) => ({
    statusCode: 401,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: result.error, message: result.message })
  });
}

// === Clients (Singleton) ===
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));
const kinesis = new KinesisClient({ region: 'ap-northeast-2' });
let supabase = null;

// === Config ===
const HOLDINGS_TABLE = process.env.HOLDINGS_TABLE || 'supernoba-holdings';
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'supernoba-orders';
const KINESIS_STREAM = process.env.KINESIS_ORDERS_STREAM || 'supernoba-orders';
const HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

const getSupabase = () => supabase || (supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY));

// === Retry Wrapper for OCC (Optimistic Concurrency Control) ===
async function withRetry(fn, maxRetries = 3, baseDelay = 50) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await fn();
    if (result.success || result.error !== 'CONCURRENCY_ERROR') {
      return result;
    }
    if (attempt < maxRetries) {
      const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 20;
      await new Promise(r => setTimeout(r, delay));
      console.log(`[OCC] Retry ${attempt + 1}/${maxRetries}`);
    }
  }
  return { success: false, error: 'MAX_RETRIES', message: '동시성 충돌 재시도 한도 초과' };
}

// === Balance Lock (Supabase - BUY orders) ===
async function lockBalanceOnce(db, userId, amount) {
  const { data: wallet, error } = await db.from('wallets').select('available, locked').eq('user_id', userId).eq('currency', 'BOLT').single();

  if (error || !wallet) {
    const { error: initErr } = await db.from('wallets').insert({ user_id: userId, currency: 'BOLT', available: 0, locked: 0 });
    if (initErr) return { success: false, error: 'WALLET_INIT_FAIL', message: '지갑 생성 실패' };
    return lockBalanceOnce(db, userId, amount);
  }

  if (wallet.available < amount) return { success: false, error: 'INSUFFICIENT_FUNDS', message: `잔고 부족 (가용: ${wallet.available})` };

  const { error: updateErr } = await db.from('wallets')
    .update({ available: wallet.available - amount, locked: wallet.locked + amount })
    .eq('user_id', userId).eq('currency', 'BOLT').eq('available', wallet.available);

  return updateErr ? { success: false, error: 'CONCURRENCY_ERROR', message: '재시도 필요' } : { success: true };
}

async function lockBalance(db, userId, amount) {
  if (amount <= 0) return { success: true };
  return withRetry(() => lockBalanceOnce(db, userId, amount));
}

async function unlockBalanceOnce(db, userId, amount) {
  const { data: wallet, error } = await db.from('wallets').select('available, locked').eq('user_id', userId).eq('currency', 'BOLT').single();

  if (error || !wallet) {
    return { success: false, error: 'WALLET_NOT_FOUND', message: '지갑을 찾을 수 없습니다' };
  }

  const { error: updateErr } = await db.from('wallets')
    .update({ available: wallet.available + amount, locked: Math.max(0, wallet.locked - amount) })
    .eq('user_id', userId).eq('currency', 'BOLT').eq('locked', wallet.locked);

  return updateErr ? { success: false, error: 'CONCURRENCY_ERROR', message: '재시도 필요' } : { success: true };
}

async function unlockBalance(db, userId, amount) {
  if (amount <= 0) return { success: true };
  return withRetry(() => unlockBalanceOnce(db, userId, amount));
}

// === Holdings Lock (DynamoDB - SELL orders) ===
async function lockHoldingsOnce(userId, symbol, amount) {
  try {
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

async function lockHoldings(userId, symbol, amount) {
  if (amount <= 0) return { success: true };
  return withRetry(() => lockHoldingsOnce(userId, symbol, amount));
}

async function unlockHoldingsOnce(userId, symbol, amount) {
  try {
    const { Item } = await ddb.send(new GetCommand({
      TableName: HOLDINGS_TABLE,
      Key: { user_id: userId, symbol: symbol.toUpperCase() }
    }));

    if (!Item) {
      return { success: false, error: 'NO_HOLDINGS', message: `보유 내역이 없습니다 (${symbol})` };
    }

    const currentLocked = Item.locked || 0;

    await ddb.send(new UpdateCommand({
      TableName: HOLDINGS_TABLE,
      Key: { user_id: userId, symbol: symbol.toUpperCase() },
      UpdateExpression: 'SET locked = :new_locked, updated_at = :now',
      ConditionExpression: 'attribute_not_exists(locked) OR locked = :current_locked',
      ExpressionAttributeValues: {
        ':new_locked': Math.max(0, currentLocked - amount),
        ':current_locked': currentLocked,
        ':now': new Date().toISOString()
      }
    }));
    return { success: true };
  } catch (e) {
    return e.name === 'ConditionalCheckFailedException'
      ? { success: false, error: 'CONCURRENCY_ERROR', message: '동시성 충돌, 재시도 필요' }
      : { success: false, error: 'UNLOCK_FAILED', message: e.message };
  }
}

async function unlockHoldings(userId, symbol, amount) {
  if (amount <= 0) return { success: true };
  return withRetry(() => unlockHoldingsOnce(userId, symbol, amount));
}

// === Main Handler ===
export const handler = async (event) => {
  // CORS Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }

  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || event;
    const { symbol, user_id, action = 'ADD', order_id, price = 0, quantity = 0, side = 'BUY', type = 'LIMIT', conditions } = body;

    if (!symbol || !user_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing required fields' }) };

    // === JWT Authentication ===
    // 요청한 user_id가 토큰의 사용자와 일치하는지 확인
    const authResult = await verifySelf(event, user_id);
    if (!authResult.success) {
      // anonymous 모드(레이어 없음)가 아닌 경우만 에러 반환
      if (!authResult.anonymous) {
        return authErrorResponse(authResult, HEADERS);
      }
    }

    const db = getSupabase();

    // === ADD Order ===
    if (action === 'ADD') {
      if (type === 'MARKET') {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'MARKET_ORDER_DISABLED', message: '시장가 주문은 현재 지원되지 않습니다' }) };
      }

      const orderId = crypto.randomUUID();
      const isBuy = side.toUpperCase() === 'BUY';
      const finalPrice = type === 'MARKET' ? (isBuy ? 2147483647 : 0) : Number(price);
      const finalQty = Number(quantity);

      if (isNaN(finalQty) || finalQty <= 0) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'INVALID_QUANTITY', message: '수량은 0보다 커야 합니다' }) };
      }
      if (type === 'LIMIT' && (isNaN(finalPrice) || finalPrice <= 0)) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'INVALID_PRICE', message: '가격은 0보다 커야 합니다' }) };
      }
      const lockAmount = isBuy ? (type === 'LIMIT' ? finalPrice * finalQty : 0) : finalQty;

      if (lockAmount > 0) {
        const lockRes = isBuy ? await lockBalance(db, user_id, lockAmount) : await lockHoldings(user_id, symbol, lockAmount);
        if (!lockRes.success) return { statusCode: 400, headers: HEADERS, body: JSON.stringify(lockRes) };
      }

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
        isBuy ? await unlockBalance(db, user_id, lockAmount) : await unlockHoldings(user_id, symbol, lockAmount);
        return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: 'Order placement failed' }) };
      }
    }

    // === CANCEL Order ===
    if (action === 'CANCEL') {
      if (!order_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing order_id' }) };

      try {
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
