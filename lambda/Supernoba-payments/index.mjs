/**
 * Supernoba-payments Lambda
 *
 * 사용자 결제 API — Stripe Checkout Session 기반
 * - POST /payments/checkout  : Stripe Checkout Session 생성 → checkout_url 반환
 * - POST /payments/portal    : Stripe Customer Portal 세션 → portal_url 반환
 * - GET  /payments/status    : 사용자 구독 상태 조회
 * - GET  /payments/history   : 결제 이력 조회 (페이지네이션)
 *
 * Layers:
 * - supernoba-common:12 (CORS, response, secretsManager)
 * - supernoba-auth:18 (JWT 검증)
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
import { CORS, response, handleOptions, getStripeSecretKey } from '/opt/nodejs/index.mjs';
import { verifyAuth, authErrorResponse } from '/opt/nodejs/verifyAuth.mjs';

const PAYMENTS_TABLE = process.env.PAYMENTS_TABLE || 'supernoba-payments';
const USER_TABLE = process.env.USER_TABLE || 'supernoba-users';
const SUCCESS_URL = process.env.SUCCESS_URL || 'https://supernoba.io/payment/success';
const CANCEL_URL = process.env.CANCEL_URL || 'https://supernoba.io/payment/cancel';

const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' }),
  { marshallOptions: { removeUndefinedValues: true } }
);

// Stripe client — lazy init (secret key from Secrets Manager)
let stripeClient = null;
async function getStripe() {
  if (!stripeClient) {
    const secretKey = await getStripeSecretKey();
    stripeClient = new Stripe(secretKey, { apiVersion: '2024-12-18.acacia' });
  }
  return stripeClient;
}

/**
 * JWT payload에서 실제 user_id를 추출
 */
function resolveUserId(authResult) {
  const xUserId = authResult.payload?.['custom:x_user_id'];
  if (xUserId) return `x_${xUserId}`;
  if (authResult.email?.includes('@x.supernoba.com')) {
    return `x_${authResult.email.split('@')[0]}`;
  }
  return authResult.userId;
}

export const handler = async (event) => {
  // CORS preflight
  const optionsResponse = handleOptions(event, CORS.STANDARD);
  if (optionsResponse) return optionsResponse;

  // 인증 검증
  const auth = await verifyAuth(event);
  if (!auth.success) {
    return authErrorResponse(auth, CORS.STANDARD);
  }

  const userId = resolveUserId(auth);
  if (!userId) {
    return response.error(400, 'User ID를 확인할 수 없습니다', CORS.STANDARD);
  }

  const method = event.httpMethod || event.requestContext?.http?.method;
  const path = event.path || event.rawPath || '';

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

// ========== Stripe Customer 관리 ==========

/**
 * supernoba-users에서 stripe_customer_id 조회 → 없으면 Stripe Customer 생성 후 저장
 */
async function getOrCreateStripeCustomer(userId, email) {
  // 1. DynamoDB에서 기존 customer_id 확인
  const { Item: user } = await dynamodb.send(new GetCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    ProjectionExpression: 'stripe_customer_id',
  }));

  if (user?.stripe_customer_id) {
    return user.stripe_customer_id;
  }

  // 2. Stripe Customer 생성
  const stripe = await getStripe();
  const customer = await stripe.customers.create({
    metadata: { user_id: userId },
    email: email || undefined,
  });

  // 3. supernoba-users에 stripe_customer_id 저장
  await dynamodb.send(new UpdateCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    UpdateExpression: 'SET stripe_customer_id = :cid',
    ExpressionAttributeValues: { ':cid': customer.id },
    ConditionExpression: 'attribute_exists(user_id)',
  }));

  console.log(`[payments] Created Stripe customer ${customer.id} for ${userId}`);
  return customer.id;
}

// ========== 라우트 핸들러 ==========

/**
 * POST /payments/checkout — Stripe Checkout Session 생성
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

  // 클라이언트가 보낸 return URL 우선 사용 (개발/프로덕션 환경 자동 대응)
  const successBase = body.success_url || SUCCESS_URL;
  const cancelBase = body.cancel_url || CANCEL_URL;

  const customerId = await getOrCreateStripeCustomer(userId, email);
  const stripe = await getStripe();

  const sessionParams = {
    customer: customerId,
    payment_method_types: ['card'],
    line_items: [{ price: price_id, quantity: 1 }],
    mode,
    success_url: `${successBase}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelBase,
    metadata: { user_id: userId },
    locale: 'ko',
  };

  // 구독인 경우 subscription_data에 metadata 추가
  if (mode === 'subscription') {
    sessionParams.subscription_data = {
      metadata: { user_id: userId },
    };
  }

  // 일회성 결제인 경우 payment_intent_data에 metadata 추가
  if (mode === 'payment') {
    sessionParams.payment_intent_data = {
      metadata: { user_id: userId },
    };
  }

  const session = await stripe.checkout.sessions.create(sessionParams);

  console.log(`[payments] Checkout session created: ${session.id} for ${userId} (mode: ${mode})`);

  return response.ok({
    checkout_url: session.url,
    session_id: session.id,
  }, CORS.STANDARD);
}

/**
 * POST /payments/portal — Stripe Customer Portal 세션
 */
async function createPortalSession(userId) {
  // stripe_customer_id 필수
  const { Item: user } = await dynamodb.send(new GetCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    ProjectionExpression: 'stripe_customer_id',
  }));

  if (!user?.stripe_customer_id) {
    return response.error(404, '결제 정보가 없습니다. 먼저 결제를 진행해주세요.', CORS.STANDARD);
  }

  const stripe = await getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: SUCCESS_URL.replace('/payment/success', '/mobile'),
  });

  return response.ok({
    portal_url: session.url,
  }, CORS.STANDARD);
}

/**
 * GET /payments/status — 사용자 구독 상태 조회
 */
async function getSubscriptionStatus(userId) {
  const { Item: user } = await dynamodb.send(new GetCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    ProjectionExpression: 'subscription_status, subscription_plan, subscription_expires_at, subscription_id, stripe_customer_id, subscription_source',
  }));

  return response.ok({
    subscription_status: user?.subscription_status || 'none',
    subscription_plan: user?.subscription_plan || null,
    subscription_expires_at: user?.subscription_expires_at || null,
    subscription_id: user?.subscription_id || null,
    has_payment_method: !!user?.stripe_customer_id,
    subscription_source: user?.subscription_source || null,
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
