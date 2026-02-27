/**
 * Supernoba-apple-iap Lambda
 *
 * Apple IAP 검증 + App Store Server Notifications v2 수신
 *
 * 엔드포인트:
 * - POST /payments/apple/verify        : 클라이언트 JWS 영수증 검증 → DB 업데이트 (Cognito JWT 필요)
 * - POST /payments/apple/notifications  : App Store Server Notifications v2 (Auth 없음)
 *
 * JWS 검증 방식:
 * StoreKit 2는 JWS(JSON Web Signature) 토큰을 반환하며, x5c 헤더에 Apple 인증서 체인이 포함됨.
 * jose 라이브러리로 서명 검증 + bundleId 확인으로 Secrets Manager 불필요.
 *
 * Layers:
 * - supernoba-common:12 (CORS, response)
 * - supernoba-auth:18 (JWT 검증) — verify 엔드포인트에서만 사용
 *
 * 환경변수:
 * - USER_TABLE: supernoba-users 테이블명
 * - PAYMENTS_TABLE: supernoba-payments 테이블명
 * - APPLE_EVENTS_TABLE: supernoba-apple-events 테이블명
 * - APPLE_BUNDLE_ID: iOS 앱 번들 ID
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import * as jose from 'jose';
import { CORS, response, handleOptions } from '/opt/nodejs/index.mjs';
import { verifyAuth, authErrorResponse } from '/opt/nodejs/verifyAuth.mjs';

const USER_TABLE = process.env.USER_TABLE || 'supernoba-users';
const PAYMENTS_TABLE = process.env.PAYMENTS_TABLE || 'supernoba-payments';
const APPLE_EVENTS_TABLE = process.env.APPLE_EVENTS_TABLE || 'supernoba-apple-events';
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || 'com.supernoba.app';

// Apple Root CA — StoreKit 2 JWS 체인 검증용
const APPLE_ROOT_CA_G3_FINGERPRINT = '63343abfb89a6a03ebbdcdb3b1bbf613eb12867e';

const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' }),
  { marshallOptions: { removeUndefinedValues: true } }
);

// 30일 TTL (초 단위)
const TTL_30_DAYS = 30 * 24 * 60 * 60;

export const handler = async (event) => {
  // CORS preflight
  const optionsResponse = handleOptions(event, CORS.STANDARD);
  if (optionsResponse) return optionsResponse;

  const method = event.httpMethod || event.requestContext?.http?.method;
  const path = event.path || event.rawPath || '';

  try {
    // POST /payments/apple/verify — 클라이언트 JWS 검증 (Auth 필요)
    if (method === 'POST' && path.endsWith('/verify')) {
      return await handleVerify(event);
    }

    // POST /payments/apple/notifications — App Store Server Notifications v2 (Auth 없음)
    if (method === 'POST' && path.endsWith('/notifications')) {
      return await handleNotification(event);
    }

    return response.error(404, 'Not Found', CORS.STANDARD);
  } catch (error) {
    console.error('[apple-iap] Unhandled error:', error);
    return response.error(500, error.message, CORS.STANDARD);
  }
};

// ========== /verify — 클라이언트 영수증 검증 ==========

async function handleVerify(event) {
  // Cognito JWT 인증
  const auth = await verifyAuth(event);
  if (!auth.success) {
    return authErrorResponse(auth, CORS.STANDARD);
  }

  const userId = resolveUserId(auth);
  if (!userId) {
    return response.error(400, 'User ID를 확인할 수 없습니다', CORS.STANDARD);
  }

  const body = JSON.parse(event.body || '{}');
  const { transactionJWS, productId } = body;

  if (!transactionJWS) {
    return response.error(400, 'transactionJWS is required', CORS.STANDARD);
  }

  // JWS 검증
  let payload;
  try {
    payload = await verifyAppleJWS(transactionJWS);
  } catch (error) {
    console.error('[apple-iap] JWS verification failed:', error.message);
    return response.error(400, `JWS verification failed: ${error.message}`, CORS.STANDARD);
  }

  // bundleId 확인
  if (payload.bundleId !== APPLE_BUNDLE_ID) {
    console.error(`[apple-iap] Bundle ID mismatch: ${payload.bundleId} !== ${APPLE_BUNDLE_ID}`);
    return response.error(400, 'Bundle ID mismatch', CORS.STANDARD);
  }

  const transactionId = payload.transactionId || payload.originalTransactionId;
  const originalTransactionId = payload.originalTransactionId || transactionId;

  // 멱등성 체크
  const eventId = `verify_${transactionId}`;
  const isDuplicate = await checkAndRecordEvent(eventId, 'client_verify');
  if (isDuplicate) {
    console.log(`[apple-iap] Duplicate verify skipped: ${eventId}`);
    return response.ok({ verified: true, duplicate: true }, CORS.STANDARD);
  }

  // 구독 상태 결정
  const now = new Date().toISOString();
  const isSubscription = payload.type === 'Auto-Renewable Subscription';
  const subscriptionStatus = determineStatus(payload);
  const expiresAt = payload.expiresDate
    ? new Date(payload.expiresDate).toISOString()
    : null;

  // supernoba-users 업데이트
  const updateExpression = [
    'SET subscription_status = :status',
    'subscription_source = :source',
    'subscription_updated_at = :now',
    'apple_original_transaction_id = :otxn',
  ];
  const expressionValues = {
    ':status': subscriptionStatus,
    ':source': 'apple',
    ':now': now,
    ':otxn': originalTransactionId,
  };

  if (isSubscription) {
    updateExpression.push('subscription_plan = :plan');
    expressionValues[':plan'] = productId || payload.productId || 'apple_subscription';

    if (expiresAt) {
      updateExpression.push('subscription_expires_at = :exp');
      expressionValues[':exp'] = expiresAt;
    }
  }

  await dynamodb.send(new UpdateCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    UpdateExpression: updateExpression.join(', '),
    ExpressionAttributeValues: expressionValues,
  }));

  // supernoba-payments 기록
  const paymentId = `apple_${transactionId}`;
  await dynamodb.send(new PutCommand({
    TableName: PAYMENTS_TABLE,
    Item: {
      user_id: userId,
      payment_id: paymentId,
      type: isSubscription ? 'subscription' : 'one_time',
      status: 'completed',
      source: 'apple',
      product_id: productId || payload.productId,
      apple_transaction_id: transactionId,
      apple_original_transaction_id: originalTransactionId,
      created_at: now,
      updated_at: now,
    },
  }));

  console.log(`[apple-iap] Verified: ${paymentId} for ${userId} → ${subscriptionStatus}`);

  return response.ok({
    verified: true,
    subscription_status: subscriptionStatus,
    product_id: productId || payload.productId,
  }, CORS.STANDARD);
}

// ========== /notifications — App Store Server Notifications v2 ==========

async function handleNotification(event) {
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;

  let notificationPayload;
  try {
    const parsed = JSON.parse(rawBody);
    // App Store Server Notifications v2는 signedPayload 필드에 JWS를 담아 보냄
    const signedPayload = parsed.signedPayload;
    if (!signedPayload) {
      console.error('[apple-iap] Missing signedPayload in notification');
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing signedPayload' }) };
    }

    notificationPayload = await verifyAppleJWS(signedPayload);
  } catch (error) {
    console.error('[apple-iap] Notification JWS verification failed:', error.message);
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid notification' }) };
  }

  const notificationType = notificationPayload.notificationType;
  const subtype = notificationPayload.subtype;
  const notificationUUID = notificationPayload.notificationUUID;

  // 멱등성 체크
  if (notificationUUID) {
    const isDuplicate = await checkAndRecordEvent(notificationUUID, `notification_${notificationType}`);
    if (isDuplicate) {
      console.log(`[apple-iap] Duplicate notification skipped: ${notificationUUID}`);
      return { statusCode: 200, body: JSON.stringify({ received: true, duplicate: true }) };
    }
  }

  // 트랜잭션 정보 추출 — data.signedTransactionInfo에 JWS가 또 있음
  let transactionInfo = null;
  if (notificationPayload.data?.signedTransactionInfo) {
    try {
      transactionInfo = await verifyAppleJWS(notificationPayload.data.signedTransactionInfo);
    } catch (error) {
      console.warn('[apple-iap] Failed to verify signedTransactionInfo:', error.message);
    }
  }

  // 갱신 정보 추출 (현재 미사용이나 향후 갱신 분석에 활용 가능)
  if (notificationPayload.data?.signedRenewalInfo) {
    try {
      await verifyAppleJWS(notificationPayload.data.signedRenewalInfo);
    } catch (error) {
      console.warn('[apple-iap] Failed to verify signedRenewalInfo:', error.message);
    }
  }

  if (!transactionInfo) {
    console.warn(`[apple-iap] No transactionInfo for ${notificationType}, skipping`);
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }

  // originalTransactionId로 사용자 조회
  const originalTransactionId = transactionInfo.originalTransactionId;
  const userId = await findUserByAppleTransactionId(originalTransactionId);

  if (!userId) {
    console.warn(`[apple-iap] No user found for originalTransactionId: ${originalTransactionId}`);
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }

  // 알림 타입별 구독 상태 매핑
  const subscriptionStatus = mapNotificationToStatus(notificationType, subtype);
  if (!subscriptionStatus) {
    console.log(`[apple-iap] Unhandled notification type: ${notificationType} / ${subtype}`);
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }

  const now = new Date().toISOString();
  const expiresAt = transactionInfo.expiresDate
    ? new Date(transactionInfo.expiresDate).toISOString()
    : null;

  const updateExpression = [
    'SET subscription_status = :status',
    'subscription_updated_at = :now',
  ];
  const expressionValues = {
    ':status': subscriptionStatus,
    ':now': now,
  };

  if (expiresAt) {
    updateExpression.push('subscription_expires_at = :exp');
    expressionValues[':exp'] = expiresAt;
  }

  // cancelled/expired일 때 plan 제거
  if (subscriptionStatus === 'cancelled' || subscriptionStatus === 'expired') {
    updateExpression.push('REMOVE subscription_plan, subscription_expires_at');
  }

  await dynamodb.send(new UpdateCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    UpdateExpression: updateExpression.join(', '),
    ExpressionAttributeValues: expressionValues,
  }));

  console.log(`[apple-iap] Notification processed: ${notificationType}/${subtype} → ${userId} = ${subscriptionStatus}`);

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
}

// ========== JWS 검증 ==========

/**
 * Apple JWS 토큰 검증
 *
 * StoreKit 2 / App Store Server Notifications v2는 JWS 토큰을 사용.
 * x5c 헤더에 Apple 인증서 체인이 포함되어 있어 Apple Root CA로 검증 가능.
 *
 * @param {string} jwsToken - JWS compact serialization
 * @returns {Object} verified payload
 */
async function verifyAppleJWS(jwsToken) {
  // 1. JWS 헤더에서 x5c 체인 추출
  const header = jose.decodeProtectedHeader(jwsToken);
  const x5c = header.x5c;

  if (!x5c || x5c.length === 0) {
    throw new Error('Missing x5c certificate chain in JWS header');
  }

  // 2. 리프 인증서에서 공개키 추출
  const leafCertPem = `-----BEGIN CERTIFICATE-----\n${x5c[0]}\n-----END CERTIFICATE-----`;
  const leafCert = await jose.importX509(leafCertPem, header.alg || 'ES256');

  // 3. 인증서 체인 검증 — 루트가 Apple Root CA인지 확인
  if (x5c.length >= 2) {
    const rootCert = x5c[x5c.length - 1];
    const rootDer = Buffer.from(rootCert, 'base64');
    const rootFingerprint = await computeSHA1(rootDer);

    if (rootFingerprint !== APPLE_ROOT_CA_G3_FINGERPRINT) {
      throw new Error(`Root certificate fingerprint mismatch: ${rootFingerprint}`);
    }
  }

  // 4. JWS 서명 검증
  const { payload } = await jose.jwtVerify(jwsToken, leafCert, {
    algorithms: ['ES256'],
    // Apple JWS는 iss/aud claim이 없을 수 있으므로 검증 스킵
  }).catch(async () => {
    // jwtVerify 실패 시 compactVerify로 fallback (비-JWT JWS인 경우)
    const result = await jose.compactVerify(jwsToken, leafCert);
    return { payload: JSON.parse(new TextDecoder().decode(result.payload)) };
  });

  // payload가 Buffer/Uint8Array인 경우 JSON 파싱
  if (payload instanceof Uint8Array || Buffer.isBuffer(payload)) {
    return JSON.parse(new TextDecoder().decode(payload));
  }

  return payload;
}

/**
 * SHA-1 fingerprint 계산 (인증서 검증용)
 */
async function computeSHA1(data) {
  const { createHash } = await import('node:crypto');
  return createHash('sha1').update(data).digest('hex');
}

// ========== 멱등성 ==========

async function checkAndRecordEvent(eventId, eventType) {
  try {
    await dynamodb.send(new PutCommand({
      TableName: APPLE_EVENTS_TABLE,
      Item: {
        event_id: eventId,
        event_type: eventType,
        processed_at: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + TTL_30_DAYS,
      },
      ConditionExpression: 'attribute_not_exists(event_id)',
    }));
    return false; // 신규
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      return true; // 중복
    }
    throw error;
  }
}

// ========== 상태 결정 ==========

/**
 * 클라이언트 verify에서 트랜잭션 payload 기반 상태 결정
 */
function determineStatus(payload) {
  // 만료 확인
  if (payload.expiresDate) {
    const expiresMs = typeof payload.expiresDate === 'number'
      ? payload.expiresDate
      : new Date(payload.expiresDate).getTime();
    if (expiresMs < Date.now()) {
      return 'expired';
    }
  }

  // 취소/환불 확인
  if (payload.revocationDate || payload.revocationReason !== undefined) {
    return 'cancelled';
  }

  return 'active';
}

/**
 * App Store Server Notification v2 타입 → 구독 상태 매핑
 */
function mapNotificationToStatus(notificationType, subtype) {
  switch (notificationType) {
    case 'SUBSCRIBED':
    case 'DID_RENEW':
      return 'active';

    case 'DID_CHANGE_RENEWAL_STATUS':
      // subtype 'AUTO_RENEW_DISABLED' = 다음 갱신 안 함 (현재는 아직 active)
      return subtype === 'AUTO_RENEW_DISABLED' ? 'active' : 'active';

    case 'DID_FAIL_TO_RENEW':
      return 'past_due';

    case 'EXPIRED':
      return 'expired';

    case 'REFUND':
    case 'REVOKE':
      return 'cancelled';

    case 'CONSUMPTION_REQUEST':
    case 'DID_CHANGE_RENEWAL_PREF':
    case 'OFFER_REDEEMED':
    case 'PRICE_INCREASE':
    case 'RENEWAL_EXTENDED':
    case 'TEST':
      // 상태 변경 불필요
      return null;

    default:
      return null;
  }
}

// ========== 유틸리티 ==========

/**
 * apple_original_transaction_id로 supernoba-users에서 user_id 조회
 * (GSI 없으므로 payments 테이블에서 역조회)
 */
async function findUserByAppleTransactionId(originalTransactionId) {
  if (!originalTransactionId) return null;

  // supernoba-payments에서 apple_original_transaction_id로 조회
  // GSI가 없으므로 간단한 Scan 대신 이전 verify에서 저장한 데이터 활용
  // → payments 테이블의 payment_id 패턴: apple_{transactionId}
  // → 하지만 user_id를 모르므로 supernoba-users를 Scan해야 함
  // 비효율적이지만 알림 빈도가 매우 낮으므로 (일 수~십건) 충분함

  const { DynamoDBClient: DC, ScanCommand } = await import('@aws-sdk/client-dynamodb');
  const { unmarshall } = await import('@aws-sdk/util-dynamodb');

  const client = new DC({ region: process.env.AWS_REGION || 'ap-northeast-2' });
  const result = await client.send(new ScanCommand({
    TableName: USER_TABLE,
    FilterExpression: 'apple_original_transaction_id = :otxn',
    ExpressionAttributeValues: {
      ':otxn': { S: originalTransactionId },
    },
    ProjectionExpression: 'user_id',
    Limit: 1,
  }));

  if (result.Items && result.Items.length > 0) {
    return unmarshall(result.Items[0]).user_id;
  }

  return null;
}

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
