/**
 * Supernoba-push-sender Lambda
 *
 * DynamoDB Streams 트리거: supernoba-orders 테이블 변경 감지
 * 주문 상태가 FILLED로 변경되면 해당 사용자에게 APNs 푸시 알림 전송
 *
 * Trigger: DynamoDB Streams (supernoba-orders, NEW_IMAGE)
 * Layers: supernoba-common:11
 *
 * 환경변수:
 * - APNS_SECRET_NAME: Secrets Manager 키 이름 (default: supernoba/apns-key)
 * - APNS_ENVIRONMENT: sandbox | production (default: sandbox)
 * - BUNDLE_ID: iOS 앱 번들 ID (default: com.supernoba.app)
 * - USER_TABLE: supernoba-users 테이블명
 */

import http2 from 'http2';
import { createSign } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const USER_TABLE = process.env.USER_TABLE || 'supernoba-users';
const BUNDLE_ID = process.env.BUNDLE_ID || 'com.supernoba.app';
const APNS_ENV = process.env.APNS_ENVIRONMENT || 'sandbox';

const APNS_HOST = APNS_ENV === 'production'
  ? 'api.push.apple.com'
  : 'api.sandbox.push.apple.com';

// MM 사용자 ID (알림 제외)
const MM_USER_IDS = new Set(['mm-buyer', 'mm-seller', 'mm-buyer-1', 'mm-seller-1']);

const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' })
);

// APNs 인증 캐시
let apnsCredentials = null;
let apnsJwt = null;
let apnsJwtTime = 0;
const JWT_TTL = 50 * 60 * 1000; // 50분 (APNs JWT 최대 1시간)

/**
 * Secrets Manager에서 APNs 키 로드
 */
async function loadApnsCredentials() {
  if (apnsCredentials) return apnsCredentials;

  try {
    const { getJsonSecret } = await import('/opt/nodejs/index.mjs');
    const secretName = process.env.APNS_SECRET_NAME || 'supernoba/apns-key';
    apnsCredentials = await getJsonSecret(secretName);
    return apnsCredentials;
  } catch (e) {
    console.error('[push-sender] Failed to load APNs credentials:', e.message);
    throw e;
  }
}

/**
 * APNs JWT 생성 (ES256)
 */
function createApnsJwt(key, keyId, teamId) {
  const now = Math.floor(Date.now() / 1000);

  // 캐시된 JWT가 유효하면 재사용
  if (apnsJwt && (Date.now() - apnsJwtTime) < JWT_TTL) {
    return apnsJwt;
  }

  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: teamId, iat: now })).toString('base64url');

  const signer = createSign('SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(key, 'base64url');

  apnsJwt = `${header}.${payload}.${signature}`;
  apnsJwtTime = Date.now();
  return apnsJwt;
}

/**
 * APNs HTTP/2로 푸시 전송
 */
function sendApns(token, payload, jwt) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${APNS_HOST}`);

    client.on('error', (err) => {
      console.error('[push-sender] HTTP/2 connection error:', err.message);
      reject(err);
    });

    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      'authorization': `bearer ${jwt}`,
      'apns-topic': BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': '0',
    };

    const req = client.request(headers);

    let responseData = '';
    let status;
    let apnsId;

    req.on('response', (headers) => {
      status = headers[':status'];
      apnsId = headers['apns-id'];
    });

    req.on('data', (chunk) => {
      responseData += chunk;
    });

    req.on('end', () => {
      client.close();
      if (status === 200) {
        console.log(`[push-sender] APNs OK: apns-id=${apnsId} token=${token.slice(0, 8)}...`);
        resolve({ success: true, apnsId });
      } else {
        const error = responseData ? JSON.parse(responseData) : {};
        console.warn(`[push-sender] APNs error: status=${status} apns-id=${apnsId}`, error);
        resolve({ success: false, status, error });
      }
    });

    req.on('error', (err) => {
      client.close();
      reject(err);
    });

    req.write(JSON.stringify(payload));
    req.end();
  });
}

/**
 * DynamoDB Stream 레코드에서 속성값 추출
 */
function unmarshallValue(attr) {
  if (!attr) return undefined;
  if (attr.S) return attr.S;
  if (attr.N) return Number(attr.N);
  if (attr.BOOL !== undefined) return attr.BOOL;
  if (attr.NULL) return null;
  if (attr.M) {
    const obj = {};
    for (const [k, v] of Object.entries(attr.M)) {
      obj[k] = unmarshallValue(v);
    }
    return obj;
  }
  return undefined;
}

export const handler = async (event) => {
  let sent = 0;
  let skipped = 0;

  // APNs 인증 준비
  let creds;
  try {
    creds = await loadApnsCredentials();
  } catch (e) {
    console.error('[push-sender] Cannot load credentials, aborting batch');
    return { batchItemFailures: [] };
  }

  const jwt = createApnsJwt(creds.key, creds.keyId, creds.teamId);

  for (const record of event.Records) {
    try {
      // MODIFY 이벤트만 처리 (주문 상태 변경)
      if (record.eventName !== 'MODIFY') {
        skipped++;
        continue;
      }

      const newImage = record.dynamodb?.NewImage;
      if (!newImage) {
        skipped++;
        continue;
      }

      const status = newImage.status?.S;
      const userId = newImage.user_id?.S;
      const symbol = newImage.symbol?.S;
      const side = newImage.side?.S;
      const quantity = newImage.filled_qty?.N || newImage.quantity?.N;
      const price = newImage.filled_price?.N || newImage.price?.N;
      const orderId = newImage.order_id?.S;

      // FILLED 상태만 처리
      if (status !== 'FILLED') {
        skipped++;
        continue;
      }

      // MM 사용자 제외
      if (MM_USER_IDS.has(userId)) {
        skipped++;
        continue;
      }

      // 사용자의 push_token 조회
      const userResult = await dynamodb.send(new GetCommand({
        TableName: USER_TABLE,
        Key: { user_id: userId },
        ProjectionExpression: 'push_token, push_platform, username',
      }));

      const pushToken = userResult.Item?.push_token;
      if (!pushToken) {
        console.log(`[push-sender] No push token for user: ${userId}`);
        skipped++;
        continue;
      }

      // symbol 이름 조회
      const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';
      let symbolName = symbol; // fallback
      try {
        const symResult = await dynamodb.send(new GetCommand({
          TableName: SYMBOLS_TABLE,
          Key: { symbol },
          ProjectionExpression: '#n',
          ExpressionAttributeNames: { '#n': 'name' },
        }));
        if (symResult.Item?.name) symbolName = symResult.Item.name;
      } catch {}

      // APNs 페이로드 구성
      const sideText = side?.toUpperCase() === 'BUY' ? '🔴 매수' : '🔵 매도';
      const apnsPayload = {
        aps: {
          alert: {
            title: '체결 완료',
            body: `${symbolName} ${quantity}주 ${sideText} 체결`,
          },
          sound: 'default',
          'thread-id': `fill-${symbol}`,
        },
        // 앱에서 사용할 커스텀 데이터
        type: 'fill',
        symbol,
        side,
        quantity: Number(quantity),
        price: Number(price),
        orderId,
      };

      const result = await sendApns(pushToken, apnsPayload, jwt);

      if (result.success) {
        console.log(`[push-sender] Sent: ${userId} ${symbol} ${sideText} ${quantity}주 apns-id=${result.apnsId} token=${pushToken.slice(0, 8)}...${pushToken.slice(-4)} host=${APNS_HOST}`);
        sent++;
      } else {
        // 410 Gone = 토큰 만료 (앱 삭제 등)
        if (result.status === 410) {
          console.log(`[push-sender] Token expired for ${userId}, should clean up`);
        }
        skipped++;
      }

    } catch (e) {
      console.error('[push-sender] Record error:', e.message);
      skipped++;
    }
  }

  console.log(`[push-sender] Batch done: ${sent} sent, ${skipped} skipped, ${event.Records.length} total`);
  return { batchItemFailures: [] };
};
