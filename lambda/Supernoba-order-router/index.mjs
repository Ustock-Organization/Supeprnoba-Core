// order-router Lambda - Lightweight Version with Authentication
// Core: Lock Balance/Holdings -> Publish to Kinesis
// Auth: Supabase JWT verification via Lambda Layer

import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// === Auth Layer Import (Simplified) ===
let auth;
try {
  auth = await import('/opt/nodejs/verifyAuth.mjs');
} catch {
  const { createFallbackAuth } = await import('/opt/nodejs/verifyAuth.mjs').catch(() => ({}));
  auth = createFallbackAuth?.('order-router') || {
    verifyAuth: async () => ({ success: true, anonymous: true }),
    verifySelf: async () => ({ success: true, anonymous: true }),
    authErrorResponse: (r) => ({ statusCode: 401, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(r) })
  };
}
const { verifySelf, authErrorResponse } = auth;

// === Clients (Singleton) ===
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));
const kinesis = new KinesisClient({ region: 'ap-northeast-2' });
let supabase = null;

// === Config ===
const HOLDINGS_TABLE = process.env.HOLDINGS_TABLE || 'supernoba-holdings';
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'supernoba-orders';
const KINESIS_STREAM = process.env.KINESIS_ORDERS_STREAM || 'supernoba-orders';
const HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };

// === Singletons ===
const testerCache = new Map(); // userId -> { isTester: boolean, expiry: timestamp }
const TESTER_CACHE_TTL = 5 * 60 * 1000; // 5분

const getSupabase = () => supabase || (supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY));

// === Tester Account Verification (5분 캐시) ===
// is_admin 또는 is_tester 컬럼 중 하나라도 true면 거래 허용
async function isAuthorizedTester(db, userId) {
  // 환경변수로 테스터 검증 비활성화 가능
  if (process.env.DISABLE_TESTER_CHECK === 'true') {
    return true;
  }

  // 캐시 확인
  const cached = testerCache.get(userId);
  if (cached && cached.expiry > Date.now()) {
    return cached.isTester;
  }

  // Supabase에서 조회 (is_admin 또는 is_tester)
  try {
    const { data, error } = await db.from('user_profiles')
      .select('is_admin, is_tester')
      .eq('id', userId)
      .single();

    // is_admin 또는 is_tester 중 하나라도 true면 허용
    const isTester = !error && (data?.is_admin === true || data?.is_tester === true);
    testerCache.set(userId, { isTester, expiry: Date.now() + TESTER_CACHE_TTL });
    return isTester;
  } catch (e) {
    console.error('[TesterCheck] Error:', e.message);
    return false;
  }
}

// === Market Buy Lock 계산 ===
// max_price 파라미터 필수 (프론트엔드에서 오더북 기반으로 계산)
async function calculateMarketBuyLock(quantity, maxPrice) {
  if (!maxPrice || maxPrice <= 0) {
    return { success: false, error: 'NO_MAX_PRICE', message: '시장가 매수 시 max_price(예상 최대 체결가) 필수' };
  }

  // 사용자 제공 max_price 기반으로 lock (10% 버퍼)
  const lockAmount = Math.ceil(maxPrice * quantity * 1.1);

  console.log(`[MarketBuyLock] qty=${quantity}, maxPrice=${maxPrice}, lockAmount=${lockAmount}`);
  return { success: true, lockAmount };
}

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

// HOF: amount 검사 + retry 래퍼 생성
const withAmountCheck = (onceFn) => async (...args) => {
  const amount = args[args.length - 1];
  if (amount <= 0) return { success: true };
  return withRetry(() => onceFn(...args));
};

const lockBalance = withAmountCheck(lockBalanceOnce);

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

const unlockBalance = withAmountCheck(unlockBalanceOnce);

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

const lockHoldings = withAmountCheck(lockHoldingsOnce);

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

const unlockHoldings = withAmountCheck(unlockHoldingsOnce);

// === Main Handler ===
export const handler = async (event) => {
  // CORS Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }

  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || event;
    const { symbol, user_id, action = 'ADD', order_id, price = 0, quantity = 0, side = 'BUY', type = 'LIMIT', conditions, max_price } = body;

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
      // [1] 테스터 계정 검증 (관리자 등록 계정만 거래 가능)
      const isTester = await isAuthorizedTester(db, user_id);
      if (!isTester) {
        return { statusCode: 403, headers: HEADERS, body: JSON.stringify({
          error: 'UNAUTHORIZED_TESTER',
          message: '테스터로 등록된 계정만 거래 가능합니다'
        })};
      }

      const orderId = crypto.randomUUID();
      const isBuy = side.toUpperCase() === 'BUY';
      const finalQty = Number(quantity);

      if (isNaN(finalQty) || finalQty <= 0) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'INVALID_QUANTITY', message: '수량은 0보다 커야 합니다' }) };
      }

      // [2] 가격 결정 (MARKET: price=0, 엔진에서 시장가로 처리)
      const finalPrice = type === 'MARKET' ? 0 : Number(price);

      if (type === 'LIMIT' && (isNaN(finalPrice) || finalPrice <= 0)) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'INVALID_PRICE', message: '가격은 0보다 커야 합니다' }) };
      }

      // [3] Lock 금액 계산
      let lockAmount = 0;
      if (isBuy) {
        if (type === 'MARKET') {
          // 시장가 매수: max_price 파라미터 필수 (프론트엔드에서 오더북 기반 계산)
          const lockCalc = await calculateMarketBuyLock(finalQty, Number(max_price));
          if (!lockCalc.success) {
            return { statusCode: 400, headers: HEADERS, body: JSON.stringify(lockCalc) };
          }
          lockAmount = lockCalc.lockAmount;
          console.log(`[ADD] MARKET BUY lock: ${lockAmount} (max_price=${max_price})`);
        } else {
          // 지정가 매수: 가격 * 수량
          lockAmount = finalPrice * finalQty;
        }
      } else {
        // 매도: 수량만큼 보유량 lock
        lockAmount = finalQty;
      }

      if (lockAmount > 0) {
        const lockRes = isBuy ? await lockBalance(db, user_id, lockAmount) : await lockHoldings(user_id, symbol, lockAmount);
        if (!lockRes.success) return { statusCode: 400, headers: HEADERS, body: JSON.stringify(lockRes) };
      }

      // [4] 시장가 주문은 IOC (Immediate-Or-Cancel) 자동 설정
      // 미체결 수량은 자동 취소되어 주문목록에 표시되지 않음
      const finalConditions = { ...(conditions || {}) };
      if (type === 'MARKET') {
        finalConditions.immediate_or_cancel = true;
      }

      try {
        // [5] DynamoDB에 주문 저장 (lock_amount 포함) - 환불 시 필요
        const now = new Date().toISOString();
        await ddb.send(new UpdateCommand({
          TableName: ORDERS_TABLE,
          Key: { user_id, order_id: orderId },
          UpdateExpression: 'SET symbol = :symbol, side = :side, #type = :type, price = :price, quantity = :qty, filled_qty = :zero, #status = :status, lock_amount = :lock, created_at = :now, updated_at = :now',
          ExpressionAttributeNames: { '#type': 'type', '#status': 'status' },
          ExpressionAttributeValues: {
            ':symbol': symbol.toUpperCase(),
            ':side': isBuy ? 'BUY' : 'SELL',
            ':type': type,
            ':price': finalPrice,
            ':qty': finalQty,
            ':zero': 0,
            ':status': 'PENDING',
            ':lock': lockAmount,
            ':now': now
          }
        }));

        // [6] Kinesis로 전송
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
            conditions: finalConditions,
            lock_amount: lockAmount
          })),
          PartitionKey: symbol
        }));

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
          order_id: orderId,
          message: 'Order Accepted',
          type,
          lock_amount: lockAmount
        }) };
      } catch (e) {
        console.error('[ADD] Error:', e.message);
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
