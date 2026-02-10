/**
 * Supernoba-delete-user-phase5 Lambda
 * Phase 5: DELETE_COGNITO
 *
 * supernoba-users 테이블에서 cognito_subs 배열을 읽고,
 * 각 sub에 대해 AdminDeleteUser 호출.
 *
 * Input: { job_id, user_id }
 * Timeout: 60s
 */

import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const cognito = new CognitoIdentityProviderClient({ region: 'ap-northeast-2' });
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));

const USERS_TABLE = process.env.USERS_TABLE || 'supernoba-users';
const JOBS_TABLE = process.env.JOBS_TABLE || 'supernoba-delete-user-jobs';
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || 'ap-northeast-2_dhsiCqgku';

export const handler = async (event) => {
  const { job_id, user_id } = event;
  if (!job_id || !user_id) throw new Error('Missing required fields: job_id, user_id');

  const now = new Date().toISOString();
  console.log(`[delete-user-phase5] Starting DELETE_COGNITO for user=${user_id}, job=${job_id}`);

  // cognito_subs 조회
  let cognitoSubs = [];
  try {
    const { Item } = await dynamodb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { user_id }
    }));
    cognitoSubs = Item?.cognito_subs || [];
  } catch (e) {
    console.warn(`[delete-user-phase5] User lookup failed:`, e.message);
  }

  let deletedCount = 0;
  let errors = [];

  for (const sub of cognitoSubs) {
    try {
      await cognito.send(new AdminDeleteUserCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        Username: sub
      }));
      deletedCount++;
      console.log(`[delete-user-phase5] Deleted Cognito user: ${sub}`);
    } catch (e) {
      if (e.name === 'UserNotFoundException') {
        console.log(`[delete-user-phase5] Cognito user already deleted: ${sub}`);
        deletedCount++; // idempotent
      } else {
        console.error(`[delete-user-phase5] Failed to delete ${sub}: ${e.message}`);
        errors.push({ sub, error: e.message });
      }
    }
  }

  // Job 진행 기록
  try {
    await dynamodb.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { job_id },
      UpdateExpression: 'SET #phase = :phase, updated_at = :now, cognito_deleted = :count, phases_completed = list_append(if_not_exists(phases_completed, :empty), :newPhase)',
      ExpressionAttributeNames: { '#phase': 'phase' },
      ExpressionAttributeValues: {
        ':phase': 'DELETE_COGNITO',
        ':now': now,
        ':count': deletedCount,
        ':newPhase': ['DELETE_COGNITO'],
        ':empty': []
      }
    }));
  } catch (e) {
    console.warn(`[delete-user-phase5] Job update failed (non-fatal):`, e.message);
  }

  if (errors.length > 0) {
    console.error(`[delete-user-phase5] Completed with ${errors.length} errors`);
    // 에러가 있어도 계속 진행 (Step Functions에서 결정)
  }

  console.log(`[delete-user-phase5] Phase 5 completed: ${deletedCount}/${cognitoSubs.length} Cognito users deleted`);
  return { success: true, job_id, user_id, phase: 'DELETE_COGNITO', deleted_count: deletedCount, total: cognitoSubs.length, errors };
};
