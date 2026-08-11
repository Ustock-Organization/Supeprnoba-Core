/**
 * Supernoba-admin-payments Lambda
 *
 * 관리자 결제 관리 API
 * - GET  /payments              : 전체 결제 목록 (페이지네이션)
 * - GET  /payments/stats        : 결제 통계 (총 매출, 활성 구독 수)
 * - POST /payments/refund       : 환불 처리
 * - GET  /payments/subscriptions: 활성 구독 목록
 *
 * Layers:
 * - supernoba-common:12 (CORS, response)
 * - supernoba-auth:18 (JWT + admin 검증)
 *
 * 환경변수:
 * - PAYMENTS_TABLE: supernoba-payments 테이블명
 * - USER_TABLE: supernoba-users 테이블명
 * - COGNITO_USER_POOL_ID: Cognito User Pool ID
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import Stripe from 'stripe';
import {
  CORS, response, handleOptions,
  getStripeSecretKey, getStripeTestSecretKey,
  getValkeyClient,
} from '/opt/nodejs/index.mjs';
import { verifyAuth, authErrorResponse } from '/opt/nodejs/verifyAuth.mjs';

const PAYMENTS_TABLE = process.env.PAYMENTS_TABLE || 'supernoba-payments';
const USER_TABLE = process.env.USER_TABLE || 'supernoba-users';

const H = CORS.FULL;
const ok = (d) => response.ok(d, H);
const err = (c, m) => response.error(c, m, H);

const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' }),
  { marshallOptions: { removeUndefinedValues: true } }
);

// Stripe clients — 모드별 캐싱
const stripeClients = {};

async function isTestMode() {
  try {
    const cache = getValkeyClient({ type: 'operating', preset: 'admin' });
    const val = await cache.get('platform:beta_mode');
    return val === 'true';
  } catch (err) {
    console.warn('[admin-payments] Failed to check beta_mode:', err.message);
    return false;
  }
}

async function getStripe() {
  const testMode = await isTestMode();
  const mode = testMode ? 'test' : 'live';
  if (!stripeClients[mode]) {
    const key = testMode ? await getStripeTestSecretKey() : await getStripeSecretKey();
    stripeClients[mode] = new Stripe(key, { apiVersion: '2024-12-18.acacia' });
  }
  return stripeClients[mode];
}

export const handler = async (event) => {
  // CORS preflight
  const optionsResponse = handleOptions(event, H);
  if (optionsResponse) return optionsResponse;

  // 관리자 인증
  const auth = await verifyAuth(event);
  if (!auth.success) {
    return authErrorResponse(auth, H);
  }
  if (!auth.isAdmin) {
    return err(403, 'Admin access required');
  }

  const method = event.httpMethod || event.requestContext?.http?.method;
  const path = event.path || event.rawPath || '';
  const query = event.queryStringParameters || {};

  try {
    // GET /payments/stats
    if (method === 'GET' && path.endsWith('/stats')) {
      return await getPaymentStats();
    }

    // GET /payments/subscriptions
    if (method === 'GET' && path.endsWith('/subscriptions')) {
      return await getActiveSubscriptions(query);
    }

    // POST /payments/refund
    if (method === 'POST' && path.endsWith('/refund')) {
      return await processRefund(event);
    }

    // GET /payments — 전체 결제 목록
    if (method === 'GET') {
      return await listPayments(query);
    }

    return err(404, 'Not Found');
  } catch (error) {
    console.error('[admin-payments] Error:', error);
    return err(500, error.message);
  }
};

/**
 * GET /payments — 전체 결제 목록 (status-index GSI)
 */
async function listPayments(query) {
  const status = query.status || 'completed';
  const limit = Math.min(parseInt(query.limit) || 50, 200);

  const params = {
    TableName: PAYMENTS_TABLE,
    IndexName: 'status-index',
    KeyConditionExpression: '#s = :status',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':status': status },
    ScanIndexForward: false,
    Limit: limit,
  };

  if (query.cursor) {
    try {
      params.ExclusiveStartKey = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
    } catch { /* invalid cursor */ }
  }

  const result = await dynamodb.send(new QueryCommand(params));
  const nextCursor = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url')
    : null;

  return ok({
    payments: result.Items || [],
    next_cursor: nextCursor,
    count: result.Items?.length || 0,
  });
}

/**
 * GET /payments/stats — 결제 통계
 */
async function getPaymentStats() {
  // 완료된 결제 스캔 (status-index)
  const completedResult = await dynamodb.send(new QueryCommand({
    TableName: PAYMENTS_TABLE,
    IndexName: 'status-index',
    KeyConditionExpression: '#s = :status',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':status': 'completed' },
    Select: 'ALL_ATTRIBUTES',
  }));

  const payments = completedResult.Items || [];
  const totalRevenue = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  const subscriptionPayments = payments.filter(p => p.type === 'subscription');
  const oneTimePayments = payments.filter(p => p.type === 'one_time');

  // source별 분류 (apple vs stripe)
  const applePayments = payments.filter(p => p.source === 'apple');
  const stripePayments = payments.filter(p => p.source !== 'apple');

  // 활성 구독 수 (supernoba-users에서 scan — 소규모 테이블이므로 OK)
  const activeSubsResult = await dynamodb.send(new ScanCommand({
    TableName: USER_TABLE,
    FilterExpression: 'subscription_status = :active',
    ExpressionAttributeValues: { ':active': 'active' },
    Select: 'COUNT',
  }));

  return ok({
    total_revenue: totalRevenue,
    total_payments: payments.length,
    subscription_revenue: subscriptionPayments.reduce((sum, p) => sum + (p.amount || 0), 0),
    one_time_revenue: oneTimePayments.reduce((sum, p) => sum + (p.amount || 0), 0),
    subscription_count: subscriptionPayments.length,
    one_time_count: oneTimePayments.length,
    // source별 매출 분류
    apple_count: applePayments.length,
    apple_revenue: applePayments.reduce((sum, p) => sum + (p.amount || 0), 0),
    stripe_count: stripePayments.length,
    stripe_revenue: stripePayments.reduce((sum, p) => sum + (p.amount || 0), 0),
    active_subscriptions: activeSubsResult.Count || 0,
    currency: 'KRW',
  });
}

/**
 * POST /payments/refund — 환불 처리
 * body: { user_id, payment_id, reason? }
 */
async function processRefund(event) {
  const body = JSON.parse(event.body || '{}');
  const { user_id, payment_id, reason } = body;

  if (!user_id || !payment_id) {
    return err(400, 'user_id and payment_id are required');
  }

  // 결제 기록 조회
  const { Item: payment } = await dynamodb.send(new QueryCommand({
    TableName: PAYMENTS_TABLE,
    KeyConditionExpression: 'user_id = :uid AND payment_id = :pid',
    ExpressionAttributeValues: { ':uid': user_id, ':pid': payment_id },
    Limit: 1,
  }).then(r => ({ Item: r.Items?.[0] })));

  if (!payment) {
    return err(404, 'Payment not found');
  }

  if (payment.status === 'refunded') {
    return err(409, 'Already refunded');
  }

  // Apple 결제는 App Store Connect에서만 환불 가능
  if (payment.source === 'apple') {
    return err(400, 'Apple 결제는 App Store Connect에서만 환불 가능합니다.');
  }

  // Stripe 환불 요청 (invoice_id 또는 payment_intent에서)
  const stripe = await getStripe();
  let refund;

  if (payment.invoice_id) {
    // Invoice 기반 환불
    const invoice = await stripe.invoices.retrieve(payment.invoice_id);
    if (invoice.payment_intent) {
      refund = await stripe.refunds.create({
        payment_intent: invoice.payment_intent,
        reason: reason || 'requested_by_customer',
      });
    }
  }

  // 결제 상태 업데이트
  const now = new Date().toISOString();
  await dynamodb.send(new UpdateCommand({
    TableName: PAYMENTS_TABLE,
    Key: { user_id, payment_id },
    UpdateExpression: 'SET #s = :status, refund_id = :rid, refund_reason = :reason, updated_at = :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':status': 'refunded',
      ':rid': refund?.id || 'manual',
      ':reason': reason || null,
      ':now': now,
    },
  }));

  console.log(`[admin-payments] Refund processed: ${payment_id} for ${user_id}`);

  return ok({
    success: true,
    refund_id: refund?.id || 'manual',
    payment_id,
    user_id,
  });
}

/**
 * GET /payments/subscriptions — 활성 구독 목록
 */
async function getActiveSubscriptions(query) {
  const limit = Math.min(parseInt(query.limit) || 50, 200);

  const result = await dynamodb.send(new ScanCommand({
    TableName: USER_TABLE,
    FilterExpression: 'attribute_exists(subscription_status) AND subscription_status <> :none',
    ExpressionAttributeValues: { ':none': 'none' },
    ProjectionExpression: 'user_id, subscription_status, subscription_plan, subscription_expires_at, subscription_id, stripe_customer_id, subscription_source, apple_original_transaction_id, subscription_cancel_at_period_end',
    Limit: limit,
  }));

  return ok({
    subscriptions: result.Items || [],
    count: result.Items?.length || 0,
  });
}
