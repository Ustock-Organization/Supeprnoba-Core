/**
 * Supernoba-stripe-webhook Lambda
 *
 * Stripe Webhook 수신 — 결제 이벤트 처리 + 멱등성 보장
 *
 * 처리 이벤트:
 * - checkout.session.completed    : 결제 기록 저장
 * - customer.subscription.created : 구독 상태 업데이트
 * - customer.subscription.updated : 구독 상태 업데이트
 * - customer.subscription.deleted : 구독 해지 반영
 * - invoice.paid                  : 결제 성공 기록
 * - invoice.payment_failed        : 결제 실패 + 구독 past_due
 *
 * Layers:
 * - supernoba-common:12 (response, secretsManager) — auth 레이어 없음 (Stripe 서명 검증 사용)
 *
 * 환경변수:
 * - PAYMENTS_TABLE: supernoba-payments 테이블명
 * - USER_TABLE: supernoba-users 테이블명
 * - WEBHOOK_EVENTS_TABLE: supernoba-stripe-events 테이블명
 *
 * 주의: API Gateway에서 raw body 전달 필수, Authorizer 없음
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import Stripe from 'stripe';
import { response, getStripeSecretKey, getStripeWebhookSecret } from '/opt/nodejs/index.mjs';

const PAYMENTS_TABLE = process.env.PAYMENTS_TABLE || 'supernoba-payments';
const USER_TABLE = process.env.USER_TABLE || 'supernoba-users';
const WEBHOOK_EVENTS_TABLE = process.env.WEBHOOK_EVENTS_TABLE || 'supernoba-stripe-events';

const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' }),
  { marshallOptions: { removeUndefinedValues: true } }
);

// 30일 TTL (초 단위)
const TTL_30_DAYS = 30 * 24 * 60 * 60;

// Stripe client — lazy init
let stripeClient = null;
async function getStripe() {
  if (!stripeClient) {
    const secretKey = await getStripeSecretKey();
    stripeClient = new Stripe(secretKey, { apiVersion: '2024-12-18.acacia' });
  }
  return stripeClient;
}

// CORS headers (webhook → 외부에서 호출하지만 Stripe 서버가 호출)
const WEBHOOK_HEADERS = {
  'Content-Type': 'application/json',
};

export const handler = async (event) => {
  // Stripe 서명 검증
  const signature = event.headers?.['Stripe-Signature'] || event.headers?.['stripe-signature'];
  if (!signature) {
    console.error('[webhook] Missing Stripe-Signature header');
    return { statusCode: 400, headers: WEBHOOK_HEADERS, body: JSON.stringify({ error: 'Missing signature' }) };
  }

  let stripeEvent;
  try {
    const stripe = await getStripe();
    const webhookSecret = await getStripeWebhookSecret();
    // API Gateway는 body를 string으로 전달 (isBase64Encoded 처리)
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf-8')
      : event.body;
    stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    console.error('[webhook] Signature verification failed:', error.message);
    return { statusCode: 400, headers: WEBHOOK_HEADERS, body: JSON.stringify({ error: 'Invalid signature' }) };
  }

  // 멱등성 체크 — 중복 이벤트 스킵
  const isDuplicate = await checkAndRecordEvent(stripeEvent.id, stripeEvent.type);
  if (isDuplicate) {
    console.log(`[webhook] Duplicate event skipped: ${stripeEvent.id} (${stripeEvent.type})`);
    return { statusCode: 200, headers: WEBHOOK_HEADERS, body: JSON.stringify({ received: true, duplicate: true }) };
  }

  // 이벤트 처리
  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(stripeEvent.data.object);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdate(stripeEvent.data.object);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(stripeEvent.data.object);
        break;

      case 'invoice.paid':
        await handleInvoicePaid(stripeEvent.data.object);
        break;

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(stripeEvent.data.object);
        break;

      default:
        console.log(`[webhook] Unhandled event type: ${stripeEvent.type}`);
    }

    return { statusCode: 200, headers: WEBHOOK_HEADERS, body: JSON.stringify({ received: true }) };
  } catch (error) {
    console.error(`[webhook] Error processing ${stripeEvent.type}:`, error);
    // 500 → Stripe가 재시도
    return { statusCode: 500, headers: WEBHOOK_HEADERS, body: JSON.stringify({ error: 'Processing failed' }) };
  }
};

// ========== 멱등성 ==========

/**
 * 이벤트 ID를 supernoba-stripe-events에 기록. 이미 존재하면 true (중복)
 */
async function checkAndRecordEvent(eventId, eventType) {
  try {
    await dynamodb.send(new PutCommand({
      TableName: WEBHOOK_EVENTS_TABLE,
      Item: {
        event_id: eventId,
        event_type: eventType,
        processed_at: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + TTL_30_DAYS,
      },
      ConditionExpression: 'attribute_not_exists(event_id)',
    }));
    return false; // 신규 이벤트
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      return true; // 중복
    }
    throw error;
  }
}

// ========== 이벤트 핸들러 ==========

/**
 * checkout.session.completed — 결제 기록 저장
 */
async function handleCheckoutCompleted(session) {
  const userId = session.metadata?.user_id;
  if (!userId) {
    console.warn('[webhook] checkout.session.completed missing user_id in metadata');
    return;
  }

  const now = new Date().toISOString();
  const paymentId = `pay_${session.id}`;

  await dynamodb.send(new PutCommand({
    TableName: PAYMENTS_TABLE,
    Item: {
      user_id: userId,
      payment_id: paymentId,
      stripe_customer_id: session.customer,
      type: session.mode === 'subscription' ? 'subscription' : 'one_time',
      status: 'completed',
      amount: session.amount_total, // KRW 정수
      currency: session.currency || 'krw',
      product_name: session.metadata?.product_name || null,
      subscription_id: session.subscription || null,
      created_at: now,
      updated_at: now,
    },
  }));

  console.log(`[webhook] Payment recorded: ${paymentId} for ${userId} (${session.amount_total} KRW)`);
}

/**
 * customer.subscription.created/updated — 구독 상태 업데이트
 */
async function handleSubscriptionUpdate(subscription) {
  const userId = subscription.metadata?.user_id || await findUserByCustomerId(subscription.customer);
  if (!userId) {
    console.warn(`[webhook] subscription.updated: cannot resolve user for customer ${subscription.customer}`);
    return;
  }

  const now = new Date().toISOString();
  const expiresAt = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;

  // Plan 이름 추출 (첫 번째 line item)
  const planName = subscription.items?.data?.[0]?.price?.lookup_key
    || subscription.items?.data?.[0]?.price?.id
    || 'unknown';

  await dynamodb.send(new UpdateCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    UpdateExpression: 'SET subscription_status = :status, subscription_plan = :plan, subscription_expires_at = :exp, subscription_id = :sid, subscription_updated_at = :now',
    ExpressionAttributeValues: {
      ':status': subscription.status, // active, past_due, trialing, etc.
      ':plan': planName,
      ':exp': expiresAt,
      ':sid': subscription.id,
      ':now': now,
    },
  }));

  console.log(`[webhook] Subscription updated: ${userId} → ${subscription.status} (${planName})`);
}

/**
 * customer.subscription.deleted — 구독 해지
 */
async function handleSubscriptionDeleted(subscription) {
  const userId = subscription.metadata?.user_id || await findUserByCustomerId(subscription.customer);
  if (!userId) {
    console.warn(`[webhook] subscription.deleted: cannot resolve user for customer ${subscription.customer}`);
    return;
  }

  const now = new Date().toISOString();

  await dynamodb.send(new UpdateCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    UpdateExpression: 'SET subscription_status = :status, subscription_updated_at = :now REMOVE subscription_plan, subscription_expires_at, subscription_id',
    ExpressionAttributeValues: {
      ':status': 'cancelled',
      ':now': now,
    },
  }));

  console.log(`[webhook] Subscription cancelled: ${userId}`);
}

/**
 * invoice.paid — 결제 성공 기록
 */
async function handleInvoicePaid(invoice) {
  const userId = invoice.subscription_details?.metadata?.user_id || await findUserByCustomerId(invoice.customer);
  if (!userId) return;

  const now = new Date().toISOString();
  const paymentId = `inv_${invoice.id}`;

  await dynamodb.send(new PutCommand({
    TableName: PAYMENTS_TABLE,
    Item: {
      user_id: userId,
      payment_id: paymentId,
      stripe_customer_id: invoice.customer,
      type: invoice.subscription ? 'subscription' : 'one_time',
      status: 'completed',
      amount: invoice.amount_paid, // KRW 정수
      currency: invoice.currency || 'krw',
      invoice_id: invoice.id,
      subscription_id: invoice.subscription || null,
      created_at: now,
      updated_at: now,
    },
  }));

  console.log(`[webhook] Invoice paid: ${paymentId} for ${userId} (${invoice.amount_paid} KRW)`);
}

/**
 * invoice.payment_failed — 결제 실패 + 구독 past_due
 */
async function handleInvoicePaymentFailed(invoice) {
  const userId = invoice.subscription_details?.metadata?.user_id || await findUserByCustomerId(invoice.customer);
  if (!userId) return;

  const now = new Date().toISOString();
  const paymentId = `inv_${invoice.id}`;

  // 결제 실패 기록
  await dynamodb.send(new PutCommand({
    TableName: PAYMENTS_TABLE,
    Item: {
      user_id: userId,
      payment_id: paymentId,
      stripe_customer_id: invoice.customer,
      type: invoice.subscription ? 'subscription' : 'one_time',
      status: 'failed',
      amount: invoice.amount_due,
      currency: invoice.currency || 'krw',
      invoice_id: invoice.id,
      subscription_id: invoice.subscription || null,
      created_at: now,
      updated_at: now,
    },
  }));

  // 구독이 있으면 상태를 past_due로 변경
  if (invoice.subscription) {
    await dynamodb.send(new UpdateCommand({
      TableName: USER_TABLE,
      Key: { user_id: userId },
      UpdateExpression: 'SET subscription_status = :status, subscription_updated_at = :now',
      ExpressionAttributeValues: {
        ':status': 'past_due',
        ':now': now,
      },
    }));
  }

  console.log(`[webhook] Invoice payment failed: ${paymentId} for ${userId}`);
}

// ========== 유틸리티 ==========

/**
 * stripe_customer_id로 supernoba-users에서 user_id 조회
 * (metadata에 user_id가 없는 경우 fallback)
 */
async function findUserByCustomerId(customerId) {
  if (!customerId) return null;

  // GSI로 조회할 수 없으므로 (users 테이블에 GSI 없음), payments 테이블의 GSI 활용
  const result = await dynamodb.send(new QueryCommand({
    TableName: PAYMENTS_TABLE,
    IndexName: 'stripe-customer-index',
    KeyConditionExpression: 'stripe_customer_id = :cid',
    ExpressionAttributeValues: { ':cid': customerId },
    Limit: 1,
    ScanIndexForward: false,
  }));

  return result.Items?.[0]?.user_id || null;
}
