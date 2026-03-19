/**
 * Supernoba-user-preferences Lambda
 *
 * 사용자 설정 조회/저장 API
 * - GET  /users/preferences       : 사용자 전체 설정 조회
 * - POST /users/preferences/theme : 테마 저장 { platform: 'web'|'mobile', theme: 'light'|'dark' }
 *
 * Layers:
 * - supernoba-auth (JWT 검증)
 * - supernoba-common (CORS, response)
 *
 * 환경변수:
 * - COGNITO_USER_POOL_ID: Cognito User Pool ID
 * - USER_TABLE: supernoba-users 테이블명
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CORS, response, handleOptions } from '/opt/nodejs/index.mjs';
import { verifyAuth, authErrorResponse, resolveUserId } from '/opt/nodejs/verifyAuth.mjs';

const USER_TABLE = process.env.USER_TABLE || 'supernoba-users';
const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' })
);

const DEFAULT_PREFERENCES = {
  theme_web: 'light',
  theme_mobile: 'light',
};

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
    // POST /users/preferences/theme
    if (method === 'POST' && path.endsWith('/theme')) {
      return await saveTheme(userId, event);
    }

    // GET /users/preferences
    if (method === 'GET') {
      return await getPreferences(userId);
    }

    return response.error(405, 'Method Not Allowed', CORS.STANDARD);

  } catch (error) {
    console.error('[user-preferences] Error:', error);
    return response.error(500, error.message, CORS.STANDARD);
  }
};

/**
 * 사용자 설정 조회
 */
async function getPreferences(userId) {
  const result = await dynamodb.send(new GetCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    ProjectionExpression: 'preferences',
  }));

  const preferences = result.Item?.preferences || DEFAULT_PREFERENCES;

  return response.ok({
    success: true,
    user_id: userId,
    preferences: {
      ...DEFAULT_PREFERENCES,
      ...preferences,
    },
  }, CORS.STANDARD);
}

/**
 * 테마 저장
 * body: { platform: 'web'|'mobile', theme: 'light'|'dark' }
 */
async function saveTheme(userId, event) {
  const body = JSON.parse(event.body || '{}');
  const { platform, theme } = body;

  if (!platform || !['web', 'mobile'].includes(platform)) {
    return response.error(400, 'platform must be web or mobile', CORS.STANDARD);
  }

  if (!theme || !['light', 'dark'].includes(theme)) {
    return response.error(400, 'theme must be light or dark', CORS.STANDARD);
  }

  const fieldName = `theme_${platform}`;
  const now = new Date().toISOString();

  // preferences 맵이 없는 기존 사용자를 위해 먼저 빈 맵 초기화
  await dynamodb.send(new UpdateCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    UpdateExpression: 'SET preferences = if_not_exists(preferences, :empty_map)',
    ExpressionAttributeValues: { ':empty_map': {} },
    ConditionExpression: 'attribute_exists(user_id)',
  }));

  // 중첩 필드 업데이트 (preferences 맵 존재 보장됨)
  await dynamodb.send(new UpdateCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    UpdateExpression: `SET preferences.${fieldName} = :theme, preferences.theme_updated_at = :now`,
    ExpressionAttributeValues: {
      ':theme': theme,
      ':now': now,
    },
  }));

  console.log(`[user-preferences] Theme saved: ${userId} ${fieldName}=${theme}`);

  return response.ok({
    success: true,
    user_id: userId,
    platform,
    theme,
    updated_at: now,
  }, CORS.STANDARD);
}
