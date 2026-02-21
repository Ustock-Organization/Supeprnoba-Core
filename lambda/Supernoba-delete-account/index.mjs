/**
 * Supernoba-delete-account Lambda
 *
 * 사용자 자체 계정 삭제 API (Apple Guideline 5.1.1v 준수)
 * POST /users/delete-account
 *
 * 기존 6-Phase Step Functions를 재사용하여 계정 삭제를 비동기 처리.
 * 관리자 버전(admin-users deleteUser)과 동일한 파이프라인이지만,
 * 일반 사용자 인증으로 자기 계정만 삭제 가능.
 *
 * 환경변수:
 * - DELETE_USER_STATE_MACHINE_ARN: Step Functions ARN
 * - DELETE_JOBS_TABLE: 삭제 작업 테이블
 * - USERS_TABLE: 사용자 테이블 (존재 확인용)
 *
 * 레이어:
 * - supernoba-common (CORS, response, handleOptions)
 * - supernoba-auth (verifyAuth, authErrorResponse)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

import { CORS, response, handleOptions } from '/opt/nodejs/index.mjs';
import { verifyAuth, authErrorResponse } from '/opt/nodejs/verifyAuth.mjs';

const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' })
);
const sfn = new SFNClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });

const DELETE_USER_STATE_MACHINE_ARN = process.env.DELETE_USER_STATE_MACHINE_ARN
  || 'arn:aws:states:ap-northeast-2:264520158196:stateMachine:supernoba-user-deletion';
const DELETE_JOBS_TABLE = process.env.DELETE_JOBS_TABLE || 'supernoba-delete-user-jobs';
const USERS_TABLE = process.env.USERS_TABLE || 'supernoba-users';

/**
 * JWT payload에서 실제 user_id를 추출
 * X/Google/Apple 로그인 사용자의 Cognito sub → 플랫폼 user_id 변환
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

export const handler = async (event) => {
  // CORS preflight
  const optionsResponse = handleOptions(event, CORS.STANDARD);
  if (optionsResponse) return optionsResponse;

  // 인증 검증 (일반 사용자)
  const auth = await verifyAuth(event);
  if (!auth.success) {
    return authErrorResponse(auth, CORS.STANDARD);
  }

  const userId = resolveUserId(auth);
  if (!userId) {
    return response.error(400, 'User ID를 확인할 수 없습니다', CORS.STANDARD);
  }

  const method = event.httpMethod || event.requestContext?.http?.method;

  if (method !== 'POST') {
    return response.error(405, 'Method Not Allowed', CORS.STANDARD);
  }

  try {
    // 요청 바디 검증
    const body = JSON.parse(event.body || '{}');
    const { confirmation } = body;

    if (confirmation !== 'DELETE_MY_ACCOUNT') {
      return response.error(400, '삭제 확인 텍스트가 올바르지 않습니다', CORS.STANDARD);
    }

    // 사용자 존재 확인
    const { Item: user } = await dynamodb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { user_id: userId },
    }));

    if (!user) {
      return response.error(404, '사용자를 찾을 수 없습니다', CORS.STANDARD);
    }

    // 삭제 작업 생성
    const jobId = `delete-${userId}-${Date.now()}`;
    const now = new Date().toISOString();

    await dynamodb.send(new PutCommand({
      TableName: DELETE_JOBS_TABLE,
      Item: {
        job_id: jobId,
        user_id: userId,
        status: 'IN_PROGRESS',
        phase: 'STARTING',
        phases_completed: [],
        started_at: now,
        started_by: userId, // 자기 자신
        self_delete: true,  // 사용자 자체 삭제 표시
        updated_at: now,
      },
    }));

    // Step Functions 실행
    const execution = await sfn.send(new StartExecutionCommand({
      stateMachineArn: DELETE_USER_STATE_MACHINE_ARN,
      name: jobId,
      input: JSON.stringify({ job_id: jobId, user_id: userId }),
    }));

    // Job에 execution ARN 저장
    await dynamodb.send(new UpdateCommand({
      TableName: DELETE_JOBS_TABLE,
      Key: { job_id: jobId },
      UpdateExpression: 'SET execution_arn = :arn, updated_at = :now',
      ExpressionAttributeValues: {
        ':arn': execution.executionArn,
        ':now': now,
      },
    }));

    console.log(`[delete-account] User self-deletion started: ${userId}, job: ${jobId}`);

    return response.ok({
      success: true,
      job_id: jobId,
      message: '계정 삭제가 시작되었습니다. 잠시 후 자동으로 로그아웃됩니다.',
    }, CORS.STANDARD);

  } catch (error) {
    console.error('[delete-account] Error:', error);
    return response.error(500, error.message, CORS.STANDARD);
  }
};
