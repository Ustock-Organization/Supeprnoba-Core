/**
 * Supernoba-delete-user-phase6 Lambda
 * Phase 6: FINALIZE
 *
 * 1. 감사 로그에 삭제 전 사용자 스냅샷 저장
 * 2. supernoba-users 테이블에서 최종 DeleteItem
 * 3. Valkey 잔여 키 정리 (suspended, deleting, connections)
 *
 * Input: { job_id, user_id }
 * Timeout: 60s
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, DeleteCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getValkeyClient, closeAllValkeyClients } from '/opt/nodejs/index.mjs';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));

const USERS_TABLE = process.env.USERS_TABLE || 'supernoba-users';
const AUDIT_LOGS_TABLE = process.env.AUDIT_LOGS_TABLE || 'supernoba-audit-logs';
const JOBS_TABLE = process.env.JOBS_TABLE || 'supernoba-delete-user-jobs';

function getValkey() {
  return getValkeyClient({ type: 'operating', preset: 'admin' });
}

export const handler = async (event) => {
  const { job_id, user_id } = event;
  if (!job_id || !user_id) throw new Error('Missing required fields: job_id, user_id');

  const now = new Date().toISOString();
  console.log(`[delete-user-phase6] Starting FINALIZE for user=${user_id}, job=${job_id}`);

  // 1. 감사 로그: 삭제 전 사용자 스냅샷 저장
  try {
    const { Item: userSnapshot } = await dynamodb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { user_id }
    }));

    if (userSnapshot) {
      await dynamodb.send(new PutCommand({
        TableName: AUDIT_LOGS_TABLE,
        Item: {
          log_id: `delete_${user_id}_${Date.now()}`,
          action: 'delete_user_snapshot',
          target_user_id: user_id,
          details: {
            job_id,
            snapshot: userSnapshot,
            deleted_at: now
          },
          created_at: now
        }
      }));
      console.log(`[delete-user-phase6] Audit snapshot saved for ${user_id}`);
    }
  } catch (e) {
    console.warn(`[delete-user-phase6] Audit snapshot failed (continuing):`, e.message);
  }

  // 2. supernoba-users 최종 삭제
  try {
    await dynamodb.send(new DeleteCommand({
      TableName: USERS_TABLE,
      Key: { user_id }
    }));
    console.log(`[delete-user-phase6] Deleted user from ${USERS_TABLE}: ${user_id}`);
  } catch (e) {
    console.error(`[delete-user-phase6] User delete failed:`, e.message);
    throw e; // Critical — retry
  }

  // 3. Valkey 잔여 키 정리
  try {
    const valkey = getValkey();
    const keysToDelete = [
      `user:${user_id}:suspended`,
      `user:${user_id}:deleting`,
      `user:${user_id}:connections`
    ];
    for (const key of keysToDelete) {
      await valkey.del(key).catch(() => {});
    }
    console.log(`[delete-user-phase6] Valkey keys cleaned for ${user_id}`);
  } catch (e) {
    console.warn(`[delete-user-phase6] Valkey cleanup failed (non-fatal):`, e.message);
  }

  // 4. Job 최종 완료 기록
  try {
    await dynamodb.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { job_id },
      UpdateExpression: 'SET #phase = :phase, #status = :status, completed_at = :now, updated_at = :now, phases_completed = list_append(if_not_exists(phases_completed, :empty), :newPhase)',
      ExpressionAttributeNames: { '#phase': 'phase', '#status': 'status' },
      ExpressionAttributeValues: {
        ':phase': 'FINALIZE',
        ':status': 'COMPLETED',
        ':now': now,
        ':newPhase': ['FINALIZE'],
        ':empty': []
      }
    }));
  } catch (e) {
    console.warn(`[delete-user-phase6] Job finalize update failed (non-fatal):`, e.message);
  }

  console.log(`[delete-user-phase6] Phase 6 completed: user ${user_id} fully deleted`);
  return { success: true, job_id, user_id, phase: 'FINALIZE', completed_at: now };
};
