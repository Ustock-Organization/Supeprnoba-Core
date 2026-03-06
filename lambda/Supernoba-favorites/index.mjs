/**
 * Supernoba-favorites Lambda
 * DynamoDB 기반 즐겨찾기 CRUD API
 *
 * Layers: supernoba-common, supernoba-auth
 *
 * Endpoints:
 *   GET  /favorites/{userId}         — 즐겨찾기 목록 조회
 *   PUT  /favorites/{userId}         — 즐겨찾기 저장 (구독 필수)
 *   POST /favorites/{userId}/add     — 즐겨찾기 추가 (구독 필수)
 *   POST /favorites/{userId}/remove  — 즐겨찾기 삭제
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { CORS, response, handleOptions } from '/opt/nodejs/index.mjs';
import { verifyAuth, authErrorResponse } from '/opt/nodejs/verifyAuth.mjs';

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const ddb = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.TABLE_NAME || 'supernoba-favorites';
const USER_TABLE = process.env.USER_TABLE || 'supernoba-users';

// ── Helpers ─────────────────────────────────────────────

/** Cognito JWT → userId 변환 (point-claim 패턴) */
function resolveUserId(authResult) {
  let userId = authResult.userId;

  // 1. X 로그인: custom:x_user_id 클레임
  const xUserId = authResult.payload?.['custom:x_user_id'];
  if (xUserId) return `x_${xUserId}`;

  // 2. X 로그인: email 패턴 fallback
  if (authResult.email?.includes('@x.supernoba.com')) {
    return `x_${authResult.email.split('@')[0]}`;
  }

  // 3. Google/Apple 로그인: cognito:username 패턴
  const cognitoUsername = authResult.payload?.['cognito:username'] || '';
  if (cognitoUsername.startsWith('Google_')) return `google_${cognitoUsername.replace('Google_', '')}`;
  if (cognitoUsername.startsWith('SignInWithApple_')) return `apple_${cognitoUsername.replace('SignInWithApple_', '')}`;

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

/** supernoba-users 구독 상태 확인 (Basic+, level ≥ 1) */
async function checkSubscription(userId) {
  const { Item } = await ddb.send(new GetCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    ProjectionExpression: 'subscription_status',
  }));

  const status = Item?.subscription_status;
  return status === 'active' || status === 'trialing';
}

// ── Handler ─────────────────────────────────────────────

export const handler = async (event) => {
  const method = event.httpMethod || event.requestContext?.http?.method;
  const path = event.path || event.rawPath || '';

  // CORS preflight
  if (method === 'OPTIONS') {
    return handleOptions(event, CORS.FULL);
  }

  try {
    // 1. 인증 검증
    const auth = await verifyAuth(event);
    if (!auth.success) return authErrorResponse(auth);

    const authenticatedUserId = resolveUserId(auth);

    // 2. Extract userId from path: /favorites/{userId} or /favorites/{userId}/add
    const pathParts = path.split('/').filter(Boolean);
    const favoritesIndex = pathParts.indexOf('favorites');
    const userId = pathParts[favoritesIndex + 1];
    const action = pathParts[favoritesIndex + 2]; // 'add' or 'remove'

    if (!userId) {
      return response.error(400, 'userId is required', CORS.FULL);
    }

    // 3. 본인 확인 — 다른 사용자의 즐겨찾기 수정 방지
    if (method !== 'GET' && userId !== authenticatedUserId) {
      console.warn('[favorites] userId mismatch:', { path: userId, auth: authenticatedUserId });
      return response.error(403, 'Cannot modify other user\'s favorites', CORS.FULL);
    }

    // GET /favorites/{userId}
    if (method === 'GET') {
      return await getFavorites(userId);
    }

    // PUT /favorites/{userId} - Save/Update favorites (구독 필수)
    if (method === 'PUT') {
      const isSubscribed = await checkSubscription(authenticatedUserId);
      if (!isSubscribed) {
        return response.error(403, 'Subscription required', CORS.FULL);
      }
      const body = JSON.parse(event.body || '{}');
      return await saveFavorites(userId, body.symbols || []);
    }

    // POST /favorites/{userId}/add (구독 필수)
    if (method === 'POST' && action === 'add') {
      const isSubscribed = await checkSubscription(authenticatedUserId);
      if (!isSubscribed) {
        return response.error(403, 'Subscription required', CORS.FULL);
      }
      const body = JSON.parse(event.body || '{}');
      return await addFavorite(userId, body.symbol);
    }

    // POST /favorites/{userId}/remove (구독 불필요 — 정리 허용)
    if (method === 'POST' && action === 'remove') {
      const body = JSON.parse(event.body || '{}');
      return await removeFavorite(userId, body.symbol);
    }

    return response.error(404, 'Not Found', CORS.FULL);

  } catch (error) {
    console.error('[favorites] Error:', error);
    return response.error(500, error.message, CORS.FULL);
  }
};

// ── CRUD Operations ─────────────────────────────────────

async function getFavorites(userId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { user_id: userId },
  }));

  return response.ok({
    user_id: userId,
    symbols: result.Item?.symbols || [],
  }, CORS.FULL);
}

async function saveFavorites(userId, symbols) {
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      user_id: userId,
      symbols: symbols,
      updated_at: new Date().toISOString(),
    },
  }));

  return response.ok({
    user_id: userId,
    symbols: symbols,
  }, CORS.FULL);
}

async function addFavorite(userId, symbol) {
  if (!symbol) {
    return response.error(400, 'symbol is required', CORS.FULL);
  }

  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { user_id: userId },
  }));

  const current = result.Item?.symbols || [];

  if (!current.includes(symbol)) {
    const updated = [...current, symbol];
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        user_id: userId,
        symbols: updated,
        updated_at: new Date().toISOString(),
      },
    }));
    return response.ok({ user_id: userId, symbols: updated }, CORS.FULL);
  }

  return response.ok({ user_id: userId, symbols: current }, CORS.FULL);
}

async function removeFavorite(userId, symbol) {
  if (!symbol) {
    return response.error(400, 'symbol is required', CORS.FULL);
  }

  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { user_id: userId },
  }));

  const current = result.Item?.symbols || [];
  const updated = current.filter(s => s !== symbol);

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      user_id: userId,
      symbols: updated,
      updated_at: new Date().toISOString(),
    },
  }));

  return response.ok({ user_id: userId, symbols: updated }, CORS.FULL);
}
