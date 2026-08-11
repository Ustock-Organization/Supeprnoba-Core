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
 * 테스트/라이브 모드 분리:
 * - Webhook Signing Secret 이중 검증 (라이브 → 테스트 순)
 * - event.livemode 기반 DB 필드 분기 (_test 접미사)
 *
 * Layers:
 * - supernoba-common:13 (response, secretsManager) — auth 레이어 없음 (Stripe 서명 검증 사용)
 *
 * 환경변수:
 * - PAYMENTS_TABLE: supernoba-payments 테이블명
 * - USER_TABLE: supernoba-users 테이블명
 * - WEBHOOK_EVENTS_TABLE: supernoba-stripe-events 테이블명
 *
 * 주의: API Gateway에서 raw body 전달 필수, Authorizer 없음
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import Stripe from 'stripe';
import {
  getStripeSecretKey, getStripeWebhookSecret,
  getStripeTestSecretKey, getStripeTestWebhookSecret,
} from '/opt/nodejs/index.mjs';

const PAYMENTS_TABLE = process.env.PAYMENTS_TABLE || 'supernoba-payments';
const USER_TABLE = process.env.USER_TABLE || 'supernoba-users';
const WEBHOOK_EVENTS_TABLE = process.env.WEBHOOK_EVENTS_TABLE || 'supernoba-stripe-events';

const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' }),
  { marshallOptions: { removeUndefinedValues: true } }
);

// 30일 TTL (초 단위)
const TTL_30_DAYS = 30 * 24 * 60 * 60;

// Stripe clients — 모드별 캐싱
const stripeClients = {};
async function getStripe(testMode) {
  const mode = testMode ? 'test' : 'live';
  if (!stripeClients[mode]) {
    const key = testMode ? await getStripeTestSecretKey() : await getStripeSecretKey();
    stripeClients[mode] = new Stripe(key, { apiVersion: '2024-12-18.acacia' });
  }
  return stripeClients[mode];
}

// CORS headers (webhook → Stripe 서버가 호출)
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
  let isTestEvent = false;

  try {
    // API Gateway는 body를 string으로 전달 (isBase64Encoded 처리)
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf-8')
      : event.body;

    // 이중 Signing Secret 검증: 라이브 → 테스트 순으로 시도
    const stripe = await getStripe(false); // constructEvent에는 아무 Stripe 인스턴스나 사용 가능
    const secrets = [
      { secret: await getStripeWebhookSecret(), test: false },
      { secret: await getStripeTestWebhookSecret(), test: true },
    ];

    for (const { secret, test } of secrets) {
      try {
        stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, secret);
        isTestEvent = test;
        break;
      } catch { continue; }
    }

    if (!stripeEvent) {
      throw new Error('All signing secrets failed');
    }
  } catch (error) {
    console.error('[webhook] Signature verification failed:', error.message);
    return { statusCode: 400, headers: WEBHOOK_HEADERS, body: JSON.stringify({ error: 'Invalid signature' }) };
  }

  // event.livemode로 최종 확인 (signing secret 결과와 일치해야 함)
  isTestEvent = !stripeEvent.livemode;
  const modeLabel = isTestEvent ? 'TEST' : 'LIVE';

  // 멱등성 체크 — 중복 이벤트 스킵
  const isDuplicate = await checkAndRecordEvent(stripeEvent.id, stripeEvent.type);
  if (isDuplicate) {
    console.log(`[webhook] [${modeLabel}] Duplicate event skipped: ${stripeEvent.id} (${stripeEvent.type})`);
    return { statusCode: 200, headers: WEBHOOK_HEADERS, body: JSON.stringify({ received: true, duplicate: true }) };
  }

  // DB 필드 접미사: 테스트 이벤트 → _test, 라이브 → 빈 문자열
  const suffix = isTestEvent ? '_test' : '';

  // 이벤트 처리
  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(stripeEvent.data.object, suffix, modeLabel);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdate(stripeEvent.data.object, suffix, modeLabel);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(stripeEvent.data.object, suffix, modeLabel);
        break;

      case 'invoice.paid':
        await handleInvoicePaid(stripeEvent.data.object, suffix, modeLabel);
        break;

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(stripeEvent.data.object, suffix, modeLabel);
        break;

      default:
        console.log(`[webhook] [${modeLabel}] Unhandled event type: ${stripeEvent.type}`);
    }

    return { statusCode: 200, headers: WEBHOOK_HEADERS, body: JSON.stringify({ received: true }) };
  } catch (error) {
    console.error(`[webhook] [${modeLabel}] Error processing ${stripeEvent.type}:`, error);
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
async function handleCheckoutCompleted(session, suffix, modeLabel) {
  const userId = session.metadata?.user_id;
  if (!userId) {
    console.warn(`[webhook] [${modeLabel}] checkout.session.completed missing user_id in metadata`);
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
      is_test: suffix === '_test',
      created_at: now,
      updated_at: now,
    },
  }));

  console.log(`[webhook] [${modeLabel}] Payment recorded: ${paymentId} for ${userId} (${session.amount_total} ${session.currency || 'KRW'})`);
}

/**
 * customer.subscription.created/updated — 구독 상태 업데이트
 */
async function handleSubscriptionUpdate(subscription, suffix, modeLabel) {
  const userId = subscription.metadata?.user_id || await findUserByCustomerId(subscription.customer);
  if (!userId) {
    console.warn(`[webhook] [${modeLabel}] subscription.updated: cannot resolve user for customer ${subscription.customer}`);
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
    UpdateExpression: `SET subscription_status${suffix} = :status, subscription_plan${suffix} = :plan, subscription_expires_at${suffix} = :exp, subscription_id${suffix} = :sid, subscription_cancel_at_period_end${suffix} = :cancelEnd, subscription_source${suffix} = :source, subscription_updated_at${suffix} = :now`,
    ExpressionAttributeValues: {
      ':status': subscription.status, // active, past_due, trialing, etc.
      ':plan': planName,
      ':exp': expiresAt,
      ':sid': subscription.id,
      ':cancelEnd': subscription.cancel_at_period_end || false,
      ':source': 'stripe',
      ':now': now,
    },
  }));

  console.log(`[webhook] [${modeLabel}] Subscription updated: ${userId} → ${subscription.status} (${planName}, cancel_at_period_end: ${subscription.cancel_at_period_end})`);
}

/**
 * customer.subscription.deleted — 구독 해지
 * 삭제 대상 subscription.id와 현재 DB의 subscription_id 비교 — 다른 구독이면 무시 (업그레이드 방어)
 */
async function handleSubscriptionDeleted(subscription, suffix, modeLabel) {
  const userId = subscription.metadata?.user_id || await findUserByCustomerId(subscription.customer);
  if (!userId) {
    console.warn(`[webhook] [${modeLabel}] subscription.deleted: cannot resolve user for customer ${subscription.customer}`);
    return;
  }

  // 현재 DB의 subscription_id와 비교 — 다른 구독(업그레이드로 교체된 경우)이면 무시
  const { Item: user } = await dynamodb.send(new GetCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    ProjectionExpression: `subscription_id${suffix}`,
  }));
  if (user?.[`subscription_id${suffix}`] && user[`subscription_id${suffix}`] !== subscription.id) {
    console.log(`[webhook] [${modeLabel}] Ignoring deletion of old subscription ${subscription.id} (current: ${user[`subscription_id${suffix}`]})`);
    return;
  }

  const now = new Date().toISOString();

  await dynamodb.send(new UpdateCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    UpdateExpression: `SET subscription_status${suffix} = :status, subscription_updated_at${suffix} = :now REMOVE subscription_plan${suffix}, subscription_expires_at${suffix}, subscription_id${suffix}, subscription_cancel_at_period_end${suffix}`,
    ExpressionAttributeValues: {
      ':status': 'cancelled',
      ':now': now,
    },
  }));

  console.log(`[webhook] [${modeLabel}] Subscription cancelled: ${userId}`);
}

/**
 * invoice.paid — 결제 성공 기록
 */
async function handleInvoicePaid(invoice, suffix, modeLabel) {
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
      amount: invoice.amount_paid,
      currency: invoice.currency || 'krw',
      invoice_id: invoice.id,
      subscription_id: invoice.subscription || null,
      is_test: suffix === '_test',
      created_at: now,
      updated_at: now,
    },
  }));

  console.log(`[webhook] [${modeLabel}] Invoice paid: ${paymentId} for ${userId} (${invoice.amount_paid} ${invoice.currency || 'KRW'})`);
}

/**
 * invoice.payment_failed — 결제 실패 + 구독 past_due
 */
async function handleInvoicePaymentFailed(invoice, suffix, modeLabel) {
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
      is_test: suffix === '_test',
      created_at: now,
      updated_at: now,
    },
  }));

  // 구독이 있으면 상태를 past_due로 변경
  if (invoice.subscription) {
    await dynamodb.send(new UpdateCommand({
      TableName: USER_TABLE,
      Key: { user_id: userId },
      UpdateExpression: `SET subscription_status${suffix} = :status, subscription_updated_at${suffix} = :now`,
      ExpressionAttributeValues: {
        ':status': 'past_due',
        ':now': now,
      },
    }));
  }

  console.log(`[webhook] [${modeLabel}] Invoice payment failed: ${paymentId} for ${userId}`);
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
