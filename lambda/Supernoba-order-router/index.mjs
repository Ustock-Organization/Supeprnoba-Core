// order-router Lambda - DynamoDB Version (Supabase Removed)
// Core: Lock Balance/Holdings -> Publish to Kinesis
// Auth: Cognito JWT verification via Lambda Layer

import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import crypto from 'crypto';

// === Common Layer Import (Valkey Client) ===
let getValkeyClient;
let valkey = null;
try {
  ({ getValkeyClient } = await import('/opt/nodejs/index.mjs'));
  valkey = getValkeyClient({ type: 'operating', preset: 'admin' });
} catch (e) {
  console.warn('[order-router] Common layer not available (Valkey disabled):', e.message);
}

// === Auth Layer Import (Strict - No Anonymous Fallback) ===
let auth;
try {
  auth = await import('/opt/nodejs/verifyAuth.mjs');
} catch (e) {
  // SECURITY: Never allow anonymous fallback for order operations
  console.error('[order-router] CRITICAL: Auth layer failed to load:', e.message);
  auth = {
    verifySelf: async () => ({ success: false, error: 'AUTH_LAYER_UNAVAILABLE', message: 'Authentication service unavailable' }),
    verifyAdmin: async () => ({ success: false, error: 'AUTH_LAYER_UNAVAILABLE', message: 'Authentication service unavailable' }),
    authErrorResponse: (r, h) => ({
      statusCode: 503,
      headers: h || { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: r.error || 'AUTH_UNAVAILABLE', message: 'Service temporarily unavailable. Please try again.' })
    })
  };
}
const { verifySelf, verifyAdmin, authErrorResponse } = auth;

// === Clients (Singleton) ===
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));
const kinesis = new KinesisClient({ region: 'ap-northeast-2' });

// === Config ===
const HOLDINGS_TABLE = process.env.HOLDINGS_TABLE || 'supernoba-holdings';
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'supernoba-orders';
const USERS_TABLE = process.env.USERS_TABLE || 'supernoba-users';
const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';
const KINESIS_STREAM = process.env.KINESIS_ORDERS_STREAM || 'supernoba-orders';
// CORS Headers - Allow specific origins in production
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',');
const HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0] || '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS, POST',
  'Content-Type': 'application/json'
};

// === Order Size Limits ===
const MAX_ORDER_VALUE = Number(process.env.MAX_ORDER_VALUE) || 100000000; // 1억 BOLT 최대 주문 금액
const MAX_QUANTITY_PER_ORDER = Number(process.env.MAX_QUANTITY_PER_ORDER) || 1000000; // 최대 100만 주 주문
const MAX_PRICE = Number(process.env.MAX_PRICE) || 1000000000; // 최대 가격 10억
const MIN_PRICE = Number(process.env.MIN_PRICE) || 0.01; // 최소 가격 0.01
const MAX_BALANCE_PERCENT = Number(process.env.MAX_BALANCE_PERCENT) || 100; // 잔고의 최대 %까지 주문 가능 (기본 100%)
const IDEMPOTENCY_TABLE = process.env.IDEMPOTENCY_TABLE || 'supernoba-idempotency';
const IDEMPOTENCY_TTL_SECONDS = 60 * 60; // 1시간 동안 같은 idempotency key 사용 불가

// === Singletons ===
const testerCache = new Map(); // userId -> { isTester: boolean, expiry: timestamp }
const TESTER_CACHE_TTL = 5 * 60 * 1000; // 5분

// === Idempotency Check (Conditional Write to DynamoDB) ===
async function checkIdempotency(idempotencyKey, userId) {
  if (!idempotencyKey) return { success: true }; // 키가 없으면 스킵

  const key = `${userId}:${idempotencyKey}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    // TTL과 함께 조건부 쓰기 시도 (기존 항목이 있으면 실패)
    await ddb.send(new PutCommand({
      TableName: IDEMPOTENCY_TABLE,
      Item: {
        idempotency_key: key,
        created_at: new Date().toISOString(),
        ttl: now + IDEMPOTENCY_TTL_SECONDS
      },
      ConditionExpression: 'attribute_not_exists(idempotency_key)'
    }));
    return { success: true };
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      return { success: false, error: 'DUPLICATE_REQUEST', message: '이미 처리된 요청입니다 (동일한 idempotency key)' };
    }
    // DynamoDB 테이블이 없거나 권한 오류 등은 무시하고 진행 (graceful degradation)
    console.warn('[Idempotency] Check failed (continuing):', e.message);
    return { success: true };
  }
}

// === Symbol Validation Cache ===
const symbolCache = new Map(); // symbol -> { isActive: boolean, data: {...}, expiry: timestamp }
const SYMBOL_CACHE_TTL = 2 * 60 * 1000; // 2분 (심볼은 자주 바뀌지 않음)

// === Symbol Format Validation ===
const SYMBOL_REGEX = /^[A-Z0-9]{2,20}$/;
function isValidSymbolFormat(symbol) {
  if (!symbol || typeof symbol !== 'string') return false;
  return SYMBOL_REGEX.test(symbol.toUpperCase().trim());
}

// === Active Symbol Verification (2분 캐시) ===
// userId 파라미터: 테스트 종목 거래 권한 확인용
async function isActiveSymbol(symbol, userId = null) {
  const normalized = symbol.toUpperCase().trim();

  // 포맷 검증
  if (!isValidSymbolFormat(normalized)) {
    return { valid: false, error: 'INVALID_SYMBOL_FORMAT', message: '잘못된 심볼 형식입니다 (영문 대문자, 숫자 2-20자)' };
  }

  // blocked:symbols 체크 (Valkey Set) - DynamoDB 캐시보다 먼저 실행하여 즉시 차단
  // 상장폐지 진행 중인 종목은 2분 symbolCache TTL 관계없이 즉시 거부
  if (valkey) {
    try {
      const isBlocked = await valkey.sismember('blocked:symbols', normalized);
      if (isBlocked) {
        console.log(`[SymbolCheck] Blocked symbol rejected: ${normalized}`);
        return { valid: false, error: 'SYMBOL_BLOCKED', message: `해당 종목은 상장폐지 진행 중이므로 거래할 수 없습니다 (${normalized})` };
      }
    } catch (e) {
      // Valkey 장애 시 fail-open: DynamoDB 캐시 방식으로 진행
      console.warn(`[SymbolCheck] Valkey blocked:symbols check failed (continuing):`, e.message);
    }
  }

  // 캐시 확인
  const cached = symbolCache.get(normalized);
  if (cached && cached.expiry > Date.now()) {
    if (!cached.isActive) {
      return { valid: false, error: 'SYMBOL_NOT_ACTIVE', message: `거래할 수 없는 심볼입니다 (${normalized})` };
    }
    // 캐시된 데이터가 테스트 종목인 경우 권한 확인
    if (cached.data?.is_test === true && userId) {
      const canTrade = await isAuthorizedTester(userId);
      if (!canTrade) {
        return { valid: false, error: 'TEST_SYMBOL_RESTRICTED', message: `테스트 종목은 관리자/테스터만 거래 가능합니다 (${normalized})` };
      }
    }
    return { valid: true, data: cached.data };
  }

  // DynamoDB에서 조회
  try {
    const { Item } = await ddb.send(new GetCommand({
      TableName: SYMBOLS_TABLE,
      Key: { symbol: normalized }
    }));

    if (!Item) {
      symbolCache.set(normalized, { isActive: false, expiry: Date.now() + SYMBOL_CACHE_TTL });
      return { valid: false, error: 'SYMBOL_NOT_FOUND', message: `존재하지 않는 심볼입니다 (${normalized})` };
    }

    if (Item.status !== 'ACTIVE') {
      symbolCache.set(normalized, { isActive: false, data: Item, expiry: Date.now() + SYMBOL_CACHE_TTL });
      return { valid: false, error: 'SYMBOL_NOT_ACTIVE', message: `거래할 수 없는 심볼입니다 (상태: ${Item.status})` };
    }

    // 테스트 종목인 경우 권한 확인
    if (Item.is_test === true && userId) {
      const canTrade = await isAuthorizedTester(userId);
      if (!canTrade) {
        // 테스트 종목은 캐시하지만, 권한 없는 사용자에게는 거래 불가로 반환
        symbolCache.set(normalized, { isActive: true, data: Item, expiry: Date.now() + SYMBOL_CACHE_TTL });
        return { valid: false, error: 'TEST_SYMBOL_RESTRICTED', message: `테스트 종목은 관리자/테스터만 거래 가능합니다 (${normalized})` };
      }
    }

    symbolCache.set(normalized, { isActive: true, data: Item, expiry: Date.now() + SYMBOL_CACHE_TTL });
    return { valid: true, data: Item };
  } catch (e) {
    console.error('[SymbolCheck] Error:', e.message);
    // 오류 시 거래 차단 (fail-safe)
    return { valid: false, error: 'SYMBOL_CHECK_FAILED', message: '심볼 검증 중 오류가 발생했습니다' };
  }
}

// === Tester Account Verification (5분 캐시) ===
// 베타 모드 OFF → 전체 개방, 베타 모드 ON → is_admin/is_tester만 허용
async function isAuthorizedTester(userId) {
  // 1. 베타 모드 확인 — OFF면 모든 유저 허용
  if (valkey) {
    try {
      const betaMode = await valkey.get('platform:beta_mode');
      if (betaMode !== 'true') {
        return true;  // 베타 모드 OFF 또는 키 소실 → 전체 개방
      }
    } catch (e) {
      // Valkey 장애 시 전체 개방 (안전한 기본값)
      console.warn('[TesterCheck] Beta mode check failed, allowing all users:', e.message);
      return true;
    }
  }

  // 2. 베타 모드 ON (기본) 또는 Valkey 장애 → 기존 테스터 검증
  if (process.env.DISABLE_TESTER_CHECK === 'true') {
    return true;
  }

  // 캐시 확인
  const cached = testerCache.get(userId);
  if (cached && cached.expiry > Date.now()) {
    return cached.isTester;
  }

  // DynamoDB users 테이블에서 조회
  try {
    const { Item } = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { user_id: userId }
    }));

    // is_admin 또는 is_tester 중 하나라도 true면 허용
    const isTester = Item && (Item.is_admin === true || Item.is_tester === true);
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
  const lockAmount = Math.ceil(maxPrice * quantity);

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

// === Balance Lock (DynamoDB - BUY orders) ===
// supernoba-users 테이블의 balances.BOLT 사용 (통합)
async function lockBalanceOnce(userId, amount) {
  try {
    const { Item: user } = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { user_id: userId },
      ProjectionExpression: 'balances, version'
    }));

    const available = Number(user?.balances?.BOLT?.available || 0);
    if (!user || available < amount) {
      return { success: false, error: 'INSUFFICIENT_FUNDS', message: `잔고 부족 (가용: ${available})` };
    }

    await ddb.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { user_id: userId },
      UpdateExpression: 'SET balances.BOLT.available = balances.BOLT.available - :amt, '
                      + 'balances.BOLT.locked = balances.BOLT.locked + :amt, '
                      + 'version = version + :one, updated_at = :now',
      ConditionExpression: 'balances.BOLT.available >= :amt AND version = :ver',
      ExpressionAttributeValues: {
        ':amt': amount,
        ':ver': user.version || 1,
        ':one': 1,
        ':now': new Date().toISOString()
      }
    }));
    return { success: true };
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      return { success: false, error: 'CONCURRENCY_ERROR', message: '재시도 필요' };
    }
    console.error('[lockBalance] Error:', e.message);
    return { success: false, error: 'LOCK_FAILED', message: e.message };
  }
}

// HOF: amount 검사 + retry 래퍼 생성
const withAmountCheck = (onceFn) => async (...args) => {
  const amount = args[args.length - 1];
  if (amount <= 0) return { success: true };
  return withRetry(() => onceFn(...args));
};

const lockBalance = withAmountCheck(lockBalanceOnce);

async function unlockBalanceOnce(userId, amount) {
  try {
    const { Item: user } = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { user_id: userId },
      ProjectionExpression: 'balances, version'
    }));

    if (!user) {
      return { success: false, error: 'WALLET_NOT_FOUND', message: '사용자를 찾을 수 없습니다' };
    }

    await ddb.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { user_id: userId },
      UpdateExpression: 'SET balances.BOLT.available = balances.BOLT.available + :amt, '
                      + 'balances.BOLT.locked = balances.BOLT.locked - :amt, '
                      + 'version = version + :one, updated_at = :now',
      ConditionExpression: 'version = :ver',
      ExpressionAttributeValues: {
        ':amt': amount,
        ':ver': user.version || 1,
        ':one': 1,
        ':now': new Date().toISOString()
      }
    }));
    return { success: true };
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      return { success: false, error: 'CONCURRENCY_ERROR', message: '재시도 필요' };
    }
    console.error('[unlockBalance] Error:', e.message);
    return { success: false, error: 'UNLOCK_FAILED', message: e.message };
  }
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
    const { symbol, user_id, action = 'ADD', order_id, price = 0, quantity = 0, side = 'BUY', type = 'LIMIT', conditions, max_price, idempotency_key } = body;

    if (!symbol || !user_id) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing required fields' }) };

    // === Idempotency Check (Optional - Skip if no key provided) ===
    if (idempotency_key && action === 'ADD') {
      const idempotencyResult = await checkIdempotency(idempotency_key, user_id);
      if (!idempotencyResult.success) {
        return { statusCode: 409, headers: HEADERS, body: JSON.stringify(idempotencyResult) };
      }
    }

    // === JWT Authentication (Admin Bypass Supported) ===
    // 1. 먼저 관리자 인증 시도 (API Key 또는 Admin JWT)
    const adminResult = await verifyAdmin(event);
    let authResult;
    let isAdminOrder = false;

    if (adminResult.success) {
      // 관리자는 모든 user_id로 주문 가능 (제약 없음)
      authResult = { success: true, userId: user_id, isAdmin: true };
      isAdminOrder = true;
      console.log(`[order-router] Admin order: ${adminResult.userId} placing order for ${user_id}`);
    } else {
      // 2. 일반 사용자는 본인 계정으로만 주문 가능
      authResult = await verifySelf(event, user_id);
      if (!authResult.success) {
        console.warn(`[order-router] Auth failed for user ${user_id}: ${authResult.error}`);
        return authErrorResponse(authResult, HEADERS);
      }
    }

    // === ADD Order ===
    if (action === 'ADD') {
      // [0] 정지 사용자 체크 (관리자 주문 바이패스, CANCEL은 허용)
      if (!isAdminOrder) {
        // Valkey에서 정지 상태 확인 (fail-open)
        if (valkey) {
          try {
            const isSuspended = await valkey.get(`user:${user_id}:suspended`);
            if (isSuspended === 'true') {
              console.log(`[order-router] Blocked suspended user: ${user_id}`);
              return { statusCode: 403, headers: HEADERS, body: JSON.stringify({
                error: 'USER_SUSPENDED',
                message: '정지된 계정입니다. 주문을 넣을 수 없습니다.'
              })};
            }
          } catch (e) {
            console.warn(`[order-router] Suspend check failed (fail-open): ${e.message}`);
          }
        }

        // [1] 테스터 계정 검증
        const isTester = await isAuthorizedTester(user_id);
        if (!isTester) {
          return { statusCode: 403, headers: HEADERS, body: JSON.stringify({
            error: 'UNAUTHORIZED_TESTER',
            message: '테스터로 등록된 계정만 거래 가능합니다'
          })};
        }
      } else {
        console.log(`[order-router] Admin bypass: skipping tester check for ${user_id}`);
      }

      // [1.5] 심볼 유효성 검증 (관리자는 테스트 종목 제한 바이패스)
      // 관리자 주문: user_id를 null로 전달하여 테스트 종목 권한 검사 스킵
      const symbolCheck = await isActiveSymbol(symbol, isAdminOrder ? null : user_id);
      if (!symbolCheck.valid) {
        // 테스트 종목 접근 제한은 403, 기타 심볼 오류는 400
        const statusCode = symbolCheck.error === 'TEST_SYMBOL_RESTRICTED' ? 403 : 400;
        return { statusCode, headers: HEADERS, body: JSON.stringify(symbolCheck) };
      }

      const orderId = crypto.randomUUID();
      const isBuy = side.toUpperCase() === 'BUY';
      const finalQty = Number(quantity);

      if (isNaN(finalQty) || finalQty <= 0) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'INVALID_QUANTITY', message: '수량은 0보다 커야 합니다' }) };
      }

      // [2] 수량 제한 검증
      if (finalQty > MAX_QUANTITY_PER_ORDER) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({
          error: 'QUANTITY_EXCEEDS_LIMIT',
          message: `주문 수량이 최대 한도(${MAX_QUANTITY_PER_ORDER.toLocaleString()})를 초과합니다`
        })};
      }

      // [3] 가격 결정 (MARKET BUY: Order Collar - max_price를 LIMIT+IOC로 전송)
      // MARKET SELL: price=0 유지 (주식 잠금, 통화가 아님)
      let finalPrice;
      if (type === 'MARKET') {
        const isBuySide = side.toUpperCase() === 'BUY';
        finalPrice = (isBuySide && max_price) ? Number(max_price) : 0;
      } else {
        finalPrice = Number(price);
      }

      if (type === 'LIMIT' && (isNaN(finalPrice) || finalPrice <= 0)) {
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'INVALID_PRICE', message: '가격은 0보다 커야 합니다' }) };
      }

      // [3.5] 가격 범위 검증 (지정가 주문)
      if (type === 'LIMIT') {
        if (finalPrice < MIN_PRICE) {
          return { statusCode: 400, headers: HEADERS, body: JSON.stringify({
            error: 'PRICE_TOO_LOW',
            message: `가격이 최소 한도(${MIN_PRICE})보다 낮습니다`
          })};
        }
        if (finalPrice > MAX_PRICE) {
          return { statusCode: 400, headers: HEADERS, body: JSON.stringify({
            error: 'PRICE_TOO_HIGH',
            message: `가격이 최대 한도(${MAX_PRICE.toLocaleString()})를 초과합니다`
          })};
        }

        // 주문 금액 검증 (가격 * 수량)
        const orderValue = finalPrice * finalQty;
        if (orderValue > MAX_ORDER_VALUE) {
          return { statusCode: 400, headers: HEADERS, body: JSON.stringify({
            error: 'ORDER_VALUE_EXCEEDS_LIMIT',
            message: `주문 금액(${orderValue.toLocaleString()})이 최대 한도(${MAX_ORDER_VALUE.toLocaleString()})를 초과합니다`
          })};
        }
      }

      // [3] Lock 금액 계산 (관리자 주문은 잔고 잠금 스킵)
      let lockAmount = 0;
      if (isAdminOrder) {
        // 관리자 주문: 잔고/보유량 잠금 없이 직접 Kinesis로 전송
        console.log(`[order-router] Admin bypass: skipping balance/holdings lock for ${user_id}`);
        lockAmount = 0;
      } else if (isBuy) {
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
        const lockRes = isBuy ? await lockBalance(user_id, lockAmount) : await lockHoldings(user_id, symbol, lockAmount);
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

        // [7] ACCEPTED 알림은 stock-processor가 Engine 확인 후 WebSocket으로 발행
        // (GAP 4 fix: premature ACCEPTED 알림 제거 — Engine 처리 전 알림은 REJECTED 시 UI 불일치 유발)

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({
          order_id: orderId,
          message: 'Order Accepted',
          type,
          lock_amount: lockAmount
        }) };
      } catch (e) {
        console.error('[ADD] Error:', {
          error: e.message,
          stack: e.stack,
          user_id,
          symbol,
          side,
          lockAmount
        });

        // Unlock 롤백 (실패 시 별도 로깅)
        try {
          if (isBuy) {
            await unlockBalance(user_id, lockAmount);
          } else {
            await unlockHoldings(user_id, symbol, lockAmount);
          }
          console.log(`[ADD] Rollback unlock success: user=${user_id}, amount=${lockAmount}`);

          // GAP 2 fix: Clean up orphan PENDING order to prevent permanent ghost
          try {
            await ddb.send(new DeleteCommand({
              TableName: ORDERS_TABLE,
              Key: { user_id, order_id: orderId }
            }));
            console.log(`[ADD] Cleaned up PENDING order: ${orderId}`);
          } catch (delErr) {
            console.error('[ADD] PENDING order cleanup failed:', delErr.message);
          }
        } catch (unlockErr) {
          // Critical: 자금 잠금 해제 실패 - 수동 개입 필요
          console.error('[ADD] ❌ CRITICAL: Unlock rollback failed:', {
            user_id,
            symbol,
            lockAmount,
            unlockError: unlockErr.message,
            originalError: e.message
          });
        }

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

        // GAP 3 fix: CANCELLED 알림은 stock-processor가 Engine 확인 후 WebSocket으로 발행
        // (premature CANCELLED 알림 제거 — CANCEL_REJECTED 시 UI 불일치 유발)

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
