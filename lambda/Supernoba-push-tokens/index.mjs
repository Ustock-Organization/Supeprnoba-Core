/**
 * Supernoba-push-tokens Lambda
 *
 * 모바일 푸시 알림 토큰 등록/삭제 API
 * - POST /users/push-token : 토큰 등록/갱신
 * - DELETE /users/push-token : 토큰 삭제 (로그아웃 시)
 *
 * Layers:
 * - supernoba-auth:18 (JWT 검증)
 * - supernoba-common:11 (CORS, response)
 *
 * 환경변수:
 * - COGNITO_USER_POOL_ID: Cognito User Pool ID
 * - USER_TABLE: supernoba-users 테이블명
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CORS, response, handleOptions } from '/opt/nodejs/index.mjs';
import { verifyAuth, authErrorResponse, resolveUserId } from '/opt/nodejs/verifyAuth.mjs';

const USER_TABLE = process.env.USER_TABLE || 'supernoba-users';
const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' })
);

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

  try {
    if (method === 'POST') {
      return await registerToken(userId, event);
    }

    if (method === 'DELETE') {
      return await removeToken(userId);
    }

    return response.error(405, 'Method Not Allowed', CORS.STANDARD);

  } catch (error) {
    console.error('[push-tokens] Error:', error);
    return response.error(500, error.message, CORS.STANDARD);
  }
};

/**
 * 푸시 토큰 등록/갱신
 * body: { token: string, platform: 'ios' | 'android' | 'web' }
 */
async function registerToken(userId, event) {
  const body = JSON.parse(event.body || '{}');
  const { token, platform } = body;

  if (!token) {
    return response.error(400, 'token is required', CORS.STANDARD);
  }

  if (!platform || !['ios', 'android', 'web'].includes(platform)) {
    return response.error(400, 'platform must be ios, android, or web', CORS.STANDARD);
  }

  const now = new Date().toISOString();

  await dynamodb.send(new UpdateCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    UpdateExpression: 'SET push_token = :token, push_platform = :platform, push_updated_at = :now',
    ExpressionAttributeValues: {
      ':token': token,
      ':platform': platform,
      ':now': now,
    },
    ConditionExpression: 'attribute_exists(user_id)',
  }));

  console.log(`[push-tokens] Registered: ${userId} (${platform})`);

  return response.ok({
    success: true,
    user_id: userId,
    platform,
    registered_at: now,
  }, CORS.STANDARD);
}

/**
 * 푸시 토큰 삭제 (로그아웃 시)
 */
async function removeToken(userId) {
  await dynamodb.send(new UpdateCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    UpdateExpression: 'REMOVE push_token, push_platform, push_updated_at',
    ConditionExpression: 'attribute_exists(user_id)',
  }));

  console.log(`[push-tokens] Removed: ${userId}`);

  return response.ok({
    success: true,
    user_id: userId,
    message: 'Push token removed',
  }, CORS.STANDARD);
}
