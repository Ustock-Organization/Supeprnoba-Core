/**
 * Supernoba-payments Lambda
 *
 * 사용자 결제 API — Stripe Checkout Session 기반
 * - POST /payments/checkout  : Stripe Checkout Session 생성 → checkout_url 반환
 * - POST /payments/portal    : Stripe Customer Portal 세션 → portal_url 반환
 * - GET  /payments/status    : 사용자 구독 상태 조회
 * - GET  /payments/history   : 결제 이력 조회 (페이지네이션)
 * - GET  /payments/products  : 상품 가격 동적 조회 (Stripe API / 테스트 모드 분기)
 *
 * Layers:
 * - supernoba-common:13 (CORS, response, secretsManager)
 * - supernoba-auth:23 (JWT 검증)
 *
 * 환경변수:
 * - COGNITO_USER_POOL_ID: Cognito User Pool ID
 * - PAYMENTS_TABLE: supernoba-payments 테이블명
 * - USER_TABLE: supernoba-users 테이블명
 * - SUCCESS_URL: 결제 성공 후 리다이렉트 URL
 * - CANCEL_URL: 결제 취소 시 리다이렉트 URL
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import Stripe from 'stripe';
import {
  CORS, response, handleOptions,
  getStripeSecretKey, getStripeTestSecretKey,
  getValkeyClient,
} from '/opt/nodejs/index.mjs';
import { verifyAuth, authErrorResponse } from '/opt/nodejs/verifyAuth.mjs';

const PAYMENTS_TABLE = process.env.PAYMENTS_TABLE || 'supernoba-payments';
const USER_TABLE = process.env.USER_TABLE || 'supernoba-users';
const SUCCESS_URL = process.env.SUCCESS_URL || 'https://supernoba.io/payment/success';
const CANCEL_URL = process.env.CANCEL_URL || 'https://supernoba.io/payment/cancel';

// 라이브 Price IDs
const PRICE_BASIC_M = 'price_1T6Nz4BIFRgItoK2zOPOxFoS';
const PRICE_PREMIUM_M = 'price_1T4vyABIFRgItoK2TOEMb8KN';
const PRICE_BASIC_Y = 'price_1T6NzoBIFRgItoK2ABQvSisw';
const PRICE_PREMIUM_Y = 'price_1T4vykBIFRgItoK2CtBPvoZs';

// 테스트 Price IDs (Stripe 테스트 모드 $1 상품 — basic/premium 분리)
const TEST_PRICE_BASIC_M = 'price_1T7ELJBIFRgItoK2bOdjqVIL';
const TEST_PRICE_PREMIUM_M = 'price_1T7R5QBIFRgItoK2iISYoQi9';
const TEST_PRICE_BASIC_Y = 'price_1T7EKsBIFRgItoK2CsVO2cQn';
const TEST_PRICE_PREMIUM_Y = 'price_1T3DigBIFRgItoK2yBj3xILo';

// Price ID → 내부 키 매핑
const PRICE_TO_KEY = {
  [PRICE_BASIC_M]: 'basic_monthly',
  [PRICE_PREMIUM_M]: 'premium_monthly',
  [PRICE_BASIC_Y]: 'basic_yearly',
  [PRICE_PREMIUM_Y]: 'premium_yearly',
  [TEST_PRICE_BASIC_M]: 'basic_monthly',
  [TEST_PRICE_PREMIUM_M]: 'premium_monthly',
  [TEST_PRICE_BASIC_Y]: 'basic_yearly',
  [TEST_PRICE_PREMIUM_Y]: 'premium_yearly',
};

const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' }),
  { marshallOptions: { removeUndefinedValues: true } }
);

// Stripe clients — 모드별 캐싱 (Lambda warm start 동안 유지)
const stripeClients = {}; // { live: Stripe, test: Stripe }

async function isTestMode() {
  try {
    const cache = getValkeyClient({ type: 'operating', preset: 'admin' });
    const val = await cache.get('platform:beta_mode');
    return val === 'true';
  } catch (err) {
    console.warn('[payments] Failed to check beta_mode from Valkey:', err.message);
    return false;
  }
}

async function getStripe(testMode) {
  const mode = testMode ? 'test' : 'live';
  if (!stripeClients[mode]) {
    const key = testMode ? await getStripeTestSecretKey() : await getStripeSecretKey();
    stripeClients[mode] = new Stripe(key, { apiVersion: '2024-12-18.acacia' });
  }
  return stripeClients[mode];
}

// 환율 캐시 (24시간, Lambda warm start 동안 유지)
let exchangeRateCache = { rate: null, expires: 0 };

async function getUsdToKrw() {
  if (exchangeRateCache.rate && Date.now() < exchangeRateCache.expires) {
    return exchangeRateCache.rate;
  }
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW');
    const data = await res.json();
    exchangeRateCache = { rate: data.rates.KRW, expires: Date.now() + 24 * 60 * 60 * 1000 };
    return data.rates.KRW;
  } catch (err) {
    console.warn('[payments] Exchange rate API failed:', err.message);
    return exchangeRateCache.rate || 1350; // fallback
  }
}

// Stripe 가격 캐시 — 모드별 분리 (5분, Lambda warm start 동안 유지)
let priceCache = {}; // { live: {data, expires}, test: {data, expires} }

/**
 * JWT payload에서 실제 user_id를 추출
 */
function resolveUserId(authResult) {
  let userId = authResult.userId;

  // 1. X 로그인: custom:x_user_id 클레임
  const xUserId = authResult.payload?.['custom:x_user_id'];
  if (xUserId) {
    return `x_${xUserId}`;
  }

  // 2. X 로그인: email 패턴 fallback
  if (authResult.email?.includes('@x.supernoba.com')) {
    return `x_${authResult.email.split('@')[0]}`;
  }

  // 3. Google/Apple 로그인: cognito:username 패턴
  const cognitoUsername = authResult.payload?.['cognito:username'] || '';
  if (cognitoUsername.startsWith('Google_')) {
    return `google_${cognitoUsername.replace('Google_', '')}`;
  }
  if (cognitoUsername.startsWith('SignInWithApple_')) {
    return `apple_${cognitoUsername.replace('SignInWithApple_', '')}`;
  }

  // 4. Google/Apple: identities 배열에서 추출
  try {
    const identities = typeof authResult.payload?.identities === 'string'
      ? JSON.parse(authResult.payload.identities)
      : authResult.payload?.identities;
    if (Array.isArray(identities)) {
      const googleId = identities.find(id => id.providerName === 'Google');
      if (googleId) return `google_${googleId.userId}`;
      const appleId = identities.find(id => id.providerName === 'SignInWithApple');
      if (appleId) return `apple_${appleId.userId}`;
    }
  } catch { /* ignore */ }

  return userId;
}

export const handler = async (event) => {
  // CORS preflight
  const optionsResponse = handleOptions(event, CORS.STANDARD);
  if (optionsResponse) return optionsResponse;

  const method = event.httpMethod || event.requestContext?.http?.method;
  const path = event.path || event.rawPath || '';

  // GET /payments/products — 인증 불필요 (가격 목록은 공개 정보)
  if (method === 'GET' && path.endsWith('/products')) {
    try {
      return await listProducts();
    } catch (error) {
      console.error('[payments] Error in listProducts:', error);
      return response.error(500, error.message, CORS.STANDARD);
    }
  }

  // 그 외 엔드포인트는 인증 필요
  const auth = await verifyAuth(event);
  if (!auth.success) {
    return authErrorResponse(auth, CORS.STANDARD);
  }

  const userId = resolveUserId(auth);
  if (!userId) {
    return response.error(400, 'User ID를 확인할 수 없습니다', CORS.STANDARD);
  }

  try {
    // POST /payments/checkout
    if (method === 'POST' && path.endsWith('/checkout')) {
      return await createCheckoutSession(userId, auth.email, event);
    }

    // POST /payments/portal
    if (method === 'POST' && path.endsWith('/portal')) {
      return await createPortalSession(userId);
    }

    // GET /payments/status
    if (method === 'GET' && path.endsWith('/status')) {
      return await getSubscriptionStatus(userId);
    }

    // GET /payments/history
    if (method === 'GET' && path.endsWith('/history')) {
      return await getPaymentHistory(userId, event);
    }

    return response.error(404, 'Not Found', CORS.STANDARD);
  } catch (error) {
    console.error('[payments] Error:', error);
    return response.error(500, error.message, CORS.STANDARD);
  }
};

// ========== GET /payments/products ==========

/**
 * GET /payments/products — 상품 가격 동적 조회
 * 테스트/라이브 모두 Stripe API에서 실시간 가격 조회 (5분 캐시)
 */
async function listProducts() {
  const testMode = await isTestMode();
  const cacheKey = testMode ? 'test' : 'live';

  if (priceCache[cacheKey]?.data && Date.now() < priceCache[cacheKey].expires) {
    return response.ok({
      test_mode: testMode,
      products: priceCache[cacheKey].data,
      exchange_rates: { usd_krw: await getUsdToKrw() },
    }, CORS.STANDARD);
  }

  const priceIds = testMode
    ? [TEST_PRICE_BASIC_M, TEST_PRICE_PREMIUM_M, TEST_PRICE_BASIC_Y, TEST_PRICE_PREMIUM_Y]
    : [PRICE_BASIC_M, PRICE_PREMIUM_M, PRICE_BASIC_Y, PRICE_PREMIUM_Y];

  const stripe = await getStripe(testMode);
  const prices = await Promise.all(priceIds.map(id => stripe.prices.retrieve(id)));

  const result = {};
  for (const p of prices) {
    const key = PRICE_TO_KEY[p.id];
    if (key) {
      result[key] = { priceId: p.id, price: p.unit_amount, currency: p.currency };
    }
  }

  priceCache[cacheKey] = { data: result, expires: Date.now() + 5 * 60 * 1000 };

  return response.ok({
    test_mode: testMode,
    products: result,
    exchange_rates: { usd_krw: await getUsdToKrw() },
  }, CORS.STANDARD);
}

// ========== Stripe Customer 관리 ==========

/**
 * supernoba-users에서 stripe_customer_id 조회 → 없으면 Stripe Customer 생성 후 저장
 * 테스트/라이브 모드에 따라 별도 필드 사용
 */
async function getOrCreateStripeCustomer(userId, email, testMode) {
  const customerIdField = testMode ? 'stripe_customer_id_test' : 'stripe_customer_id';

  // 1. DynamoDB에서 기존 customer_id 확인
  const { Item: user } = await dynamodb.send(new GetCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    ProjectionExpression: customerIdField,
  }));

  // 2. 기존 customer_id가 있으면 Stripe에서 유효성 검증
  if (user?.[customerIdField]) {
    try {
      const stripe = await getStripe(testMode);
      const existing = await stripe.customers.retrieve(user[customerIdField]);
      if (!existing.deleted) {
        return user[customerIdField];
      }
      console.warn(`[payments] Customer ${user[customerIdField]} is deleted, recreating for ${userId}`);
    } catch (err) {
      console.warn(`[payments] Stale customer ${user[customerIdField]} for ${userId}: ${err.message}`);
    }
  }

  // 3. Stripe Customer 생성
  const stripe = await getStripe(testMode);
  const customer = await stripe.customers.create({
    metadata: { user_id: userId },
    email: email || undefined,
  });

  // 4. supernoba-users에 stripe_customer_id 저장
  await dynamodb.send(new UpdateCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    UpdateExpression: `SET ${customerIdField} = :cid`,
    ExpressionAttributeValues: { ':cid': customer.id },
    ConditionExpression: 'attribute_exists(user_id)',
  }));

  console.log(`[payments] Created Stripe ${testMode ? 'TEST ' : ''}customer ${customer.id} for ${userId}`);
  return customer.id;
}

// ========== 라우트 핸들러 ==========

// ========== 업그레이드 판정 ==========

function getPlanInfo(priceId) {
  const key = PRICE_TO_KEY[priceId];
  if (!key) return null;
  return {
    level: key.startsWith('basic') ? 1 : 2,
    yearly: key.endsWith('yearly'),
    key,
  };
}

function isUpgradePath(currentPriceId, newPriceId) {
  const current = getPlanInfo(currentPriceId);
  const target = getPlanInfo(newPriceId);
  if (!current || !target) return false;
  if (target.level > current.level) return true;  // 레벨 상승 = 항상 업그레이드
  if (current.yearly && !target.yearly) return false;  // 동일·하위 레벨 연→월 = 다운그레이드
  if (target.level === current.level && !current.yearly && target.yearly) return true;
  return false;
}

/**
 * POST /payments/checkout — Stripe Checkout Session 생성 (업그레이드 분기 포함)
 * body: { price_id: string, mode: 'subscription' | 'payment', success_url?: string, cancel_url?: string }
 */
async function createCheckoutSession(userId, email, event) {
  const body = JSON.parse(event.body || '{}');
  const { price_id, mode = 'subscription' } = body;

  if (!price_id) {
    return response.error(400, 'price_id is required', CORS.STANDARD);
  }

  if (!['subscription', 'payment'].includes(mode)) {
    return response.error(400, 'mode must be subscription or payment', CORS.STANDARD);
  }

  const testMode = await isTestMode();

  // 구독 모드: 활성 구독 확인 → 업그레이드 또는 차단
  if (mode === 'subscription') {
    const suffix = testMode ? '_test' : '';
    const { Item: user } = await dynamodb.send(new GetCommand({
      TableName: USER_TABLE,
      Key: { user_id: userId },
      ProjectionExpression: `subscription_status${suffix}, subscription_plan${suffix}, subscription_id${suffix}`,
    }));
    const currentStatus = user?.[`subscription_status${suffix}`];
    const currentPlan = user?.[`subscription_plan${suffix}`];
    const currentSubId = user?.[`subscription_id${suffix}`];

    if (currentStatus === 'active' || currentStatus === 'trialing') {
      if (isUpgradePath(currentPlan, price_id)) {
        // 즉시 업그레이드: 기존 구독의 price 변경 (Stripe proration 자동 처리)
        const stripe = await getStripe(testMode);
        const currentSub = await stripe.subscriptions.retrieve(currentSubId);
        const itemId = currentSub.items.data[0].id;

        // 크로스 인터벌 변경 여부 확인 (yearly ↔ monthly)
        const currentInfo = getPlanInfo(currentPlan);
        const targetInfo = getPlanInfo(price_id);
        const isIntervalChange = currentInfo && targetInfo && currentInfo.yearly !== targetInfo.yearly;

        const updateParams = {
          items: [{ id: itemId, price: price_id }],
          proration_behavior: 'always_invoice',
        };

        if (isIntervalChange) {
          // 빌링 인터벌 변경 시 billing cycle anchor 리셋 필수
          // → 기존 연간 앵커와 새 월간 가격 간 프로레이션 불일치 방지
          updateParams.billing_cycle_anchor = 'now';
        }

        const updatedSub = await stripe.subscriptions.update(currentSubId, updateParams);

        console.log(`[payments] ${testMode ? 'TEST ' : ''}Subscription upgraded: ${userId} ${currentPlan} → ${price_id} (interval change: ${isIntervalChange})`);
        return response.ok({ upgraded: true, subscription_id: updatedSub.id }, CORS.STANDARD);
      }
      // 업그레이드가 아닌 경우 → 차단
      return response.error(409, '이미 활성 구독이 있습니다. 구독 변경은 결제 관리에서 진행해주세요.', CORS.STANDARD);
    }
  }

  // 비활성 → 일반 Checkout Session 생성
  const successBase = body.success_url || SUCCESS_URL;
  const cancelBase = body.cancel_url || CANCEL_URL;

  const customerId = await getOrCreateStripeCustomer(userId, email, testMode);
  const stripe = await getStripe(testMode);

  const sessionParams = {
    customer: customerId,
    line_items: [{ price: price_id, quantity: 1 }],
    mode,
    success_url: `${successBase}${successBase.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelBase,
    metadata: { user_id: userId },
    locale: 'ko',
  };

  if (mode === 'subscription') {
    sessionParams.subscription_data = {
      metadata: { user_id: userId },
    };
  }

  if (mode === 'payment') {
    sessionParams.payment_intent_data = {
      metadata: { user_id: userId },
    };
  }

  const session = await stripe.checkout.sessions.create(sessionParams);

  console.log(`[payments] ${testMode ? 'TEST ' : ''}Checkout session created: ${session.id} for ${userId} (mode: ${mode})`);

  return response.ok({
    checkout_url: session.url,
    session_id: session.id,
  }, CORS.STANDARD);
}

/**
 * POST /payments/portal — Stripe Customer Portal 세션
 * 테스트/라이브 모드에 따라 해당 모드의 Customer Portal 열림
 */
async function createPortalSession(userId) {
  const testMode = await isTestMode();
  const customerIdField = testMode ? 'stripe_customer_id_test' : 'stripe_customer_id';

  const { Item: user } = await dynamodb.send(new GetCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    ProjectionExpression: customerIdField,
  }));

  if (!user?.[customerIdField]) {
    return response.error(404, '결제 정보가 없습니다. 먼저 결제를 진행해주세요.', CORS.STANDARD);
  }

  const stripe = await getStripe(testMode);
  const session = await stripe.billingPortal.sessions.create({
    customer: user[customerIdField],
    return_url: testMode
      ? 'http://localhost:3000'
      : SUCCESS_URL.replace('/payment/success', ''),
  });

  return response.ok({
    portal_url: session.url,
  }, CORS.STANDARD);
}

/**
 * GET /payments/status — 사용자 구독 상태 조회
 * 테스트 모드면 _test 접미사 필드에서 읽되, 응답 키는 동일하게 유지
 */
async function getSubscriptionStatus(userId) {
  const testMode = await isTestMode();
  const suffix = testMode ? '_test' : '';

  const projectionFields = [
    `subscription_status${suffix}`,
    `subscription_plan${suffix}`,
    `subscription_expires_at${suffix}`,
    `subscription_id${suffix}`,
    `stripe_customer_id${suffix}`,
    `subscription_source${suffix}`,
    `subscription_cancel_at_period_end${suffix}`,
  ].join(', ');

  const { Item: user } = await dynamodb.send(new GetCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    ProjectionExpression: projectionFields,
  }));

  return response.ok({
    subscription_status: user?.[`subscription_status${suffix}`] || 'none',
    subscription_plan: user?.[`subscription_plan${suffix}`] || null,
    subscription_expires_at: user?.[`subscription_expires_at${suffix}`] || null,
    subscription_id: user?.[`subscription_id${suffix}`] || null,
    has_payment_method: !!user?.[`stripe_customer_id${suffix}`],
    subscription_source: user?.[`subscription_source${suffix}`] || null,
    cancel_at_period_end: user?.[`subscription_cancel_at_period_end${suffix}`] || false,
    test_mode: testMode,
  }, CORS.STANDARD);
}

/**
 * GET /payments/history — 결제 이력 조회 (페이지네이션)
 */
async function getPaymentHistory(userId, event) {
  const query = event.queryStringParameters || {};
  const limit = Math.min(parseInt(query.limit) || 20, 100);

  const params = {
    TableName: PAYMENTS_TABLE,
    KeyConditionExpression: 'user_id = :uid',
    ExpressionAttributeValues: { ':uid': userId },
    ScanIndexForward: false, // 최신순
    Limit: limit,
  };

  // 페이지네이션 커서
  if (query.cursor) {
    try {
      params.ExclusiveStartKey = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
    } catch { /* invalid cursor — 무시 */ }
  }

  const result = await dynamodb.send(new QueryCommand(params));

  const nextCursor = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url')
    : null;

  return response.ok({
    payments: result.Items || [],
    next_cursor: nextCursor,
    count: result.Items?.length || 0,
  }, CORS.STANDARD);
}
