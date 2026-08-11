/**
 * Supernoba-delete-user-phase1 Lambda
 * Phase 1: BLOCK_USER
 *
 * 1. DynamoDB supernoba-users에 is_suspended=true, is_deleting=true 설정
 * 2. Valkey user:{userId}:suspended = 'true', user:{userId}:deleting = 'true' 설정
 * 3. WebSocket 강제 종료 (user:{userId}:connections → DeleteConnection)
 * 4. Job 진행 기록
 *
 * Input: { job_id, user_id }
 * Timeout: 30s
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ApiGatewayManagementApiClient, DeleteConnectionCommand, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { getValkeyClient } from '/opt/nodejs/index.mjs';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));

const USERS_TABLE = process.env.USERS_TABLE || 'supernoba-users';
const JOBS_TABLE = process.env.JOBS_TABLE || 'supernoba-delete-user-jobs';
const WS_ENDPOINT = process.env.WEBSOCKET_ENDPOINT || '';

function getValkey() {
  return getValkeyClient({ type: 'operating', preset: 'admin' });
}

export const handler = async (event) => {
  const { job_id, user_id } = event;
  if (!job_id || !user_id) throw new Error('Missing required fields: job_id, user_id');

  const now = new Date().toISOString();
  console.log(`[delete-user-phase1] Starting BLOCK_USER for user=${user_id}, job=${job_id}`);

  // 1. DynamoDB: is_suspended + is_deleting 설정
  try {
    await dynamodb.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { user_id },
      UpdateExpression: 'SET is_suspended = :true, is_deleting = :true, suspended_at = :now, suspended_reason = :reason, updated_at = :now',
      ExpressionAttributeValues: {
        ':true': true,
        ':now': now,
        ':reason': 'Account deletion in progress'
      }
    }));
    console.log(`[delete-user-phase1] DynamoDB flags set for ${user_id}`);
  } catch (e) {
    console.error(`[delete-user-phase1] DynamoDB update failed:`, e.message);
    throw e; // Critical — retry
  }

  // 2. Valkey: suspended + deleting 캐시 설정
  let valkeyWarnings = [];
  try {
    const valkey = getValkey();
    await valkey.set(`user:${user_id}:suspended`, 'true');
    await valkey.set(`user:${user_id}:deleting`, 'true');
    console.log(`[delete-user-phase1] Valkey flags set for ${user_id}`);
  } catch (e) {
    console.warn(`[delete-user-phase1] Valkey flag set failed:`, e.message);
    valkeyWarnings.push(e.message);
  }

  // 3. WebSocket 강제 종료
  if (WS_ENDPOINT) {
    try {
      const valkey = getValkey();
      const connections = await valkey.smembers(`user:${user_id}:connections`);
      if (connections && connections.length > 0) {
        const wsClient = new ApiGatewayManagementApiClient({
          region: 'ap-northeast-2',
          endpoint: WS_ENDPOINT
        });
        for (const connId of connections) {
          try {
            // 1. force_logout 메시지 전송
            await wsClient.send(new PostToConnectionCommand({
              ConnectionId: connId,
              Data: JSON.stringify({
                action: 'error',
                code: 'ACCOUNT_DELETED',
                message: '계정이 차단되었습니다.'
              })
            }));
            // 2. 프론트엔드 메시지 수신 대기
            await new Promise(r => setTimeout(r, 100));
            // 3. 연결 종료
            await wsClient.send(new DeleteConnectionCommand({ ConnectionId: connId }));
            console.log(`[delete-user-phase1] Force-logout + disconnect WS: ${connId}`);
          } catch (wsErr) {
            if (wsErr.$metadata?.httpStatusCode === 410) {
              await valkey.srem(`user:${user_id}:connections`, connId).catch(() => {});
            } else {
              console.warn(`[delete-user-phase1] WS cleanup failed: ${wsErr.message}`);
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[delete-user-phase1] WS cleanup failed:`, e.message);
      valkeyWarnings.push(`WS: ${e.message}`);
    }
  }

  // 4. Job 진행 기록
  try {
    await dynamodb.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { job_id },
      UpdateExpression: 'SET #phase = :phase, updated_at = :now, phases_completed = list_append(if_not_exists(phases_completed, :empty), :newPhase)',
      ExpressionAttributeNames: { '#phase': 'phase' },
      ExpressionAttributeValues: {
        ':phase': 'BLOCK_USER',
        ':now': now,
        ':newPhase': ['BLOCK_USER'],
        ':empty': []
      }
    }));
  } catch (e) {
    console.warn(`[delete-user-phase1] Job update failed (non-fatal):`, e.message);
  }

  const result = { success: true, job_id, user_id, phase: 'BLOCK_USER', blocked_at: now };
  if (valkeyWarnings.length > 0) result.warnings = valkeyWarnings;

  console.log(`[delete-user-phase1] Phase 1 completed for ${user_id}`);
  return result;
};
