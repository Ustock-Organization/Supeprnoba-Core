/**
 * Supernoba-favorites Lambda
 * DynamoDB 기반 즐겨찾기 그룹 CRUD API
 *
 * Layers: supernoba-common, supernoba-auth
 *
 * Endpoints:
 *   GET    /favorites/{userId}                — 즐겨찾기 그룹 목록 조회
 *   PUT    /favorites/{userId}                — 그룹 내 즐겨찾기 순서 저장
 *   POST   /favorites/{userId}/add            — 그룹에 종목 추가
 *   POST   /favorites/{userId}/remove         — 그룹에서 종목 제거
 *   POST   /favorites/{userId}/groups         — 새 그룹 생성
 *   DELETE /favorites/{userId}/groups/{name}   — 그룹 삭제 (종목은 기본으로 이동)
 *   PATCH  /favorites/{userId}/groups/{name}   — 그룹 이름 변경
 *   PUT    /favorites/{userId}/group-order     — 탭 순서 저장
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { CORS, response, handleOptions } from '/opt/nodejs/index.mjs';
import { verifyAuth, authErrorResponse } from '/opt/nodejs/verifyAuth.mjs';

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const ddb = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.TABLE_NAME || 'supernoba-favorites';
const DEFAULT_GROUP = '기본';

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

/**
 * 구 형식(symbols 배열) → 신 형식(groups 맵) 마이그레이션.
 * 구 형식이면 변환하고 DynamoDB에 저장한 뒤 반환한다.
 * 신 형식이면 그대로 반환한다.
 */
async function migrateIfNeeded(item) {
  if (!item) return null;

  // 이미 신 형식이면 그대로
  if (item.groups) return item;

  // 구 형식: symbols 배열이 있고 groups가 없는 경우
  const symbols = item.symbols || [];
  const migrated = {
    user_id: item.user_id,
    groups: { [DEFAULT_GROUP]: symbols },
    group_order: [DEFAULT_GROUP],
    updated_at: new Date().toISOString(),
  };

  // DynamoDB에 마이그레이션 결과 저장
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: migrated,
  }));

  console.log('[favorites] Migrated old format for user:', item.user_id, '| symbols:', symbols.length);
  return migrated;
}

/**
 * 사용자 레코드 조회. 없으면 기본 레코드 생성.
 * 구 형식이면 자동 마이그레이션.
 */
async function ensureRecord(userId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { user_id: userId },
  }));

  if (result.Item) {
    return await migrateIfNeeded(result.Item);
  }

  // 레코드가 없으면 기본 생성
  const defaultRecord = {
    user_id: userId,
    groups: { [DEFAULT_GROUP]: [] },
    group_order: [DEFAULT_GROUP],
    updated_at: new Date().toISOString(),
  };

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: defaultRecord,
  }));

  return defaultRecord;
}

/**
 * 레코드를 DynamoDB에 저장 (updated_at 자동 갱신).
 */
async function saveRecord(record) {
  record.updated_at = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: record,
  }));
  return record;
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

    // 2. Extract path parts
    const pathParts = path.split('/').filter(Boolean);
    const favoritesIndex = pathParts.indexOf('favorites');
    const userId = pathParts[favoritesIndex + 1];
    const action = pathParts[favoritesIndex + 2]; // 'add', 'remove', 'groups', 'group-order'
    const subParam = pathParts[favoritesIndex + 3]; // group name for DELETE/PATCH

    if (!userId) {
      return response.error(400, 'userId is required', CORS.FULL);
    }

    // 3. JWT 기반 userId 사용 — URL path userId 대신 JWT에서 추출한 authenticatedUserId를 신뢰
    const effectiveUserId = authenticatedUserId || userId;
    if (!authenticatedUserId) {
      console.warn('[favorites] authenticatedUserId is null (auth devMode or missing claims), falling back to path userId:', userId);
    } else if (userId !== authenticatedUserId) {
      console.info('[favorites] userId resolved from JWT (path differs):', {
        pathUserId: userId, jwtUserId: authenticatedUserId
      });
    }

    // ── GET /favorites/{userId} ──
    if (method === 'GET' && !action) {
      return await getFavorites(effectiveUserId);
    }

    // ── PUT /favorites/{userId} ── 그룹 내 종목 순서 저장
    if (method === 'PUT' && !action) {
      const body = JSON.parse(event.body || '{}');
      return await saveFavorites(effectiveUserId, body.symbols || [], body.group);
    }

    // ── PUT /favorites/{userId}/group-order ── 탭 순서 저장
    if (method === 'PUT' && action === 'group-order') {
      const body = JSON.parse(event.body || '{}');
      return await saveGroupOrder(effectiveUserId, body.order);
    }

    // ── POST /favorites/{userId}/add ──
    if (method === 'POST' && action === 'add') {
      const body = JSON.parse(event.body || '{}');
      return await addFavorite(effectiveUserId, body.symbol, body.group);
    }

    // ── POST /favorites/{userId}/remove ──
    if (method === 'POST' && action === 'remove') {
      const body = JSON.parse(event.body || '{}');
      return await removeFavorite(effectiveUserId, body.symbol, body.group);
    }

    // ── POST /favorites/{userId}/groups ── 새 그룹 생성
    if (method === 'POST' && action === 'groups' && !subParam) {
      const body = JSON.parse(event.body || '{}');
      return await createGroup(effectiveUserId, body.name);
    }

    // ── DELETE /favorites/{userId}/groups/{name} ── 그룹 삭제
    if (method === 'DELETE' && action === 'groups' && subParam) {
      const groupName = decodeURIComponent(subParam);
      return await deleteGroup(effectiveUserId, groupName);
    }

    // ── PATCH /favorites/{userId}/groups/{name} ── 그룹 이름 변경
    if (method === 'PATCH' && action === 'groups' && subParam) {
      const groupName = decodeURIComponent(subParam);
      const body = JSON.parse(event.body || '{}');
      return await renameGroup(effectiveUserId, groupName, body.newName);
    }

    return response.error(404, 'Not Found', CORS.FULL);

  } catch (error) {
    console.error('[favorites] Error:', error);
    return response.error(500, error.message, CORS.FULL);
  }
};

// ── CRUD Operations ─────────────────────────────────────

/**
 * GET /favorites/{userId}
 * 즐겨찾기 그룹 목록 조회. 구 형식이면 자동 마이그레이션.
 */
async function getFavorites(userId) {
  const record = await ensureRecord(userId);

  return response.ok({
    user_id: record.user_id,
    groups: record.groups,
    group_order: record.group_order,
  }, CORS.FULL);
}

/**
 * PUT /favorites/{userId}
 * 특정 그룹의 종목 순서 저장 (전체 교체).
 * body: { symbols: [...], group: "기본" }
 */
async function saveFavorites(userId, symbols, group) {
  const groupName = group || DEFAULT_GROUP;
  const record = await ensureRecord(userId);

  if (!record.groups[groupName]) {
    return response.error(404, `Group "${groupName}" does not exist`, CORS.FULL);
  }

  record.groups[groupName] = symbols;
  await saveRecord(record);

  return response.ok({
    user_id: record.user_id,
    groups: record.groups,
    group_order: record.group_order,
  }, CORS.FULL);
}

/**
 * POST /favorites/{userId}/add
 * 특정 그룹에 종목 추가.
 * body: { symbol: "AAPL", group: "기본" }
 */
async function addFavorite(userId, symbol, group) {
  if (!symbol) {
    return response.error(400, 'symbol is required', CORS.FULL);
  }

  const groupName = group || DEFAULT_GROUP;
  const record = await ensureRecord(userId);

  if (!record.groups[groupName]) {
    return response.error(404, `Group "${groupName}" does not exist`, CORS.FULL);
  }

  const current = record.groups[groupName];
  if (!current.includes(symbol)) {
    record.groups[groupName] = [...current, symbol];
    await saveRecord(record);
  }

  return response.ok({
    user_id: record.user_id,
    groups: record.groups,
    group_order: record.group_order,
  }, CORS.FULL);
}

/**
 * POST /favorites/{userId}/remove
 * 특정 그룹에서 종목 제거.
 * body: { symbol: "AAPL", group: "기본" }
 */
async function removeFavorite(userId, symbol, group) {
  if (!symbol) {
    return response.error(400, 'symbol is required', CORS.FULL);
  }

  const groupName = group || DEFAULT_GROUP;
  const record = await ensureRecord(userId);

  if (!record.groups[groupName]) {
    return response.error(404, `Group "${groupName}" does not exist`, CORS.FULL);
  }

  record.groups[groupName] = record.groups[groupName].filter(s => s !== symbol);
  await saveRecord(record);

  return response.ok({
    user_id: record.user_id,
    groups: record.groups,
    group_order: record.group_order,
  }, CORS.FULL);
}

/**
 * POST /favorites/{userId}/groups
 * 새 그룹 생성.
 * body: { name: "관심" }
 */
async function createGroup(userId, name) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    return response.error(400, 'Group name is required', CORS.FULL);
  }

  const groupName = name.trim();
  const record = await ensureRecord(userId);

  if (record.groups[groupName] !== undefined) {
    return response.error(409, `Group "${groupName}" already exists`, CORS.FULL);
  }

  record.groups[groupName] = [];
  record.group_order.push(groupName);
  await saveRecord(record);

  return response.ok({
    user_id: record.user_id,
    groups: record.groups,
    group_order: record.group_order,
  }, CORS.FULL);
}

/**
 * DELETE /favorites/{userId}/groups/{name}
 * 그룹 삭제. 해당 그룹의 종목은 "기본" 그룹으로 이동.
 * "기본" 그룹은 삭제 불가.
 */
async function deleteGroup(userId, groupName) {
  if (groupName === DEFAULT_GROUP) {
    return response.error(400, `Cannot delete the "${DEFAULT_GROUP}" group`, CORS.FULL);
  }

  const record = await ensureRecord(userId);

  if (record.groups[groupName] === undefined) {
    return response.error(404, `Group "${groupName}" does not exist`, CORS.FULL);
  }

  // 삭제되는 그룹의 종목을 기본 그룹으로 이동 (중복 제거)
  const movingSymbols = record.groups[groupName] || [];
  const defaultSymbols = record.groups[DEFAULT_GROUP] || [];
  const merged = [...defaultSymbols];
  for (const sym of movingSymbols) {
    if (!merged.includes(sym)) {
      merged.push(sym);
    }
  }
  record.groups[DEFAULT_GROUP] = merged;

  // 그룹 삭제
  delete record.groups[groupName];
  record.group_order = record.group_order.filter(g => g !== groupName);

  await saveRecord(record);

  return response.ok({
    user_id: record.user_id,
    groups: record.groups,
    group_order: record.group_order,
  }, CORS.FULL);
}

/**
 * PATCH /favorites/{userId}/groups/{name}
 * 그룹 이름 변경. "기본" 그룹은 이름 변경 불가.
 * body: { newName: "새 이름" }
 */
async function renameGroup(userId, groupName, newName) {
  if (groupName === DEFAULT_GROUP) {
    return response.error(400, `Cannot rename the "${DEFAULT_GROUP}" group`, CORS.FULL);
  }

  if (!newName || typeof newName !== 'string' || !newName.trim()) {
    return response.error(400, 'newName is required', CORS.FULL);
  }

  const trimmedNewName = newName.trim();

  if (trimmedNewName === DEFAULT_GROUP) {
    return response.error(400, `Cannot rename to "${DEFAULT_GROUP}"`, CORS.FULL);
  }

  const record = await ensureRecord(userId);

  if (record.groups[groupName] === undefined) {
    return response.error(404, `Group "${groupName}" does not exist`, CORS.FULL);
  }

  if (record.groups[trimmedNewName] !== undefined) {
    return response.error(409, `Group "${trimmedNewName}" already exists`, CORS.FULL);
  }

  // 그룹 이름 변경: 종목 이동 + group_order 업데이트
  record.groups[trimmedNewName] = record.groups[groupName];
  delete record.groups[groupName];
  record.group_order = record.group_order.map(g => g === groupName ? trimmedNewName : g);

  await saveRecord(record);

  return response.ok({
    user_id: record.user_id,
    groups: record.groups,
    group_order: record.group_order,
  }, CORS.FULL);
}

/**
 * PUT /favorites/{userId}/group-order
 * 탭 순서 저장.
 * body: { order: ["기본", "관심", ...] }
 */
async function saveGroupOrder(userId, order) {
  if (!Array.isArray(order) || order.length === 0) {
    return response.error(400, 'order must be a non-empty array', CORS.FULL);
  }

  const record = await ensureRecord(userId);

  // 모든 그룹이 존재하는지 검증
  const existingGroups = Object.keys(record.groups);
  const missingInOrder = existingGroups.filter(g => !order.includes(g));
  const unknownInOrder = order.filter(g => !existingGroups.includes(g));

  if (unknownInOrder.length > 0) {
    return response.error(400, `Unknown groups: ${unknownInOrder.join(', ')}`, CORS.FULL);
  }

  if (missingInOrder.length > 0) {
    return response.error(400, `Missing groups in order: ${missingInOrder.join(', ')}`, CORS.FULL);
  }

  record.group_order = order;
  await saveRecord(record);

  return response.ok({
    user_id: record.user_id,
    groups: record.groups,
    group_order: record.group_order,
  }, CORS.FULL);
}
