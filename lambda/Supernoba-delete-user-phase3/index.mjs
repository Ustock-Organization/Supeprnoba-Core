/**
 * Supernoba-delete-user-phase3 Lambda
 * Phase 3: DELETE_DYNAMODB
 *
 * 5개 테이블에서 user_id 관련 데이터 삭제:
 * - supernoba-holdings (PK: user_id, SK: symbol)
 * - supernoba-orders (PK: user_id, SK: order_id)
 * - supernoba-favorites (PK: user_id, SK: symbol)
 * - supernoba-creator-requests (PK: user_id)
 * - supernoba-ipo-orders (PK: user_id, SK: ipo_id)
 *
 * audit-logs는 건드리지 않음 (감사 추적용)
 *
 * Input: { job_id, user_id }
 * Timeout: 900s (15분)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand, DeleteCommand, UpdateCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));

const JOBS_TABLE = process.env.JOBS_TABLE || 'supernoba-delete-user-jobs';

// 삭제 대상 테이블 목록 (PK: user_id)
const TABLES_WITH_SK = [
  // supernoba-wallets 제거됨 (supernoba-users.balances.BOLT로 통합)
  { table: 'supernoba-holdings', sk: 'symbol' },
  { table: 'supernoba-orders', sk: 'order_id' },
  { table: 'supernoba-favorites', sk: 'symbol' },
];

// PK가 user_id가 아닌 테이블 → Scan + FilterExpression 필요
const TABLES_SCAN_BY_USER = [
  { table: 'supernoba-ipo-orders', pk: 'order_id', userField: 'user_id' },
  { table: 'supernoba-creator-requests', pk: 'request_id', userField: 'user_id' },
];

/**
 * BatchWrite로 25개씩 삭제 (DynamoDB 제한)
 */
async function batchDelete(tableName, keys) {
  const BATCH_SIZE = 25;
  let totalDeleted = 0;

  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE);
    const requestItems = {
      [tableName]: batch.map(key => ({ DeleteRequest: { Key: key } }))
    };

    try {
      await dynamodb.send(new BatchWriteCommand({ RequestItems: requestItems }));
      totalDeleted += batch.length;
    } catch (e) {
      console.error(`[delete-user-phase3] BatchWrite failed for ${tableName}: ${e.message}`);
      // 개별 삭제로 폴백
      for (const key of batch) {
        try {
          await dynamodb.send(new DeleteCommand({ TableName: tableName, Key: key }));
          totalDeleted++;
        } catch (delErr) {
          console.error(`[delete-user-phase3] Individual delete failed: ${delErr.message}`);
        }
      }
    }
  }

  return totalDeleted;
}

export const handler = async (event) => {
  const { job_id, user_id } = event;
  if (!job_id || !user_id) throw new Error('Missing required fields: job_id, user_id');

  const now = new Date().toISOString();
  console.log(`[delete-user-phase3] Starting DELETE_DYNAMODB for user=${user_id}, job=${job_id}`);

  const deletionResults = {};

  // SK가 있는 테이블들: Query → BatchDelete
  for (const { table, sk } of TABLES_WITH_SK) {
    try {
      // 페이지네이션 필수 — Query는 1MB에서 잘린다. 아래 Scan 경로는 이미 순회하고
      // 있는데 이쪽만 누락되어, 주문·보유가 많은 유저는 일부만 삭제되고 잔여가 남았다.
      const items = [];
      let ExclusiveStartKey;
      do {
        const result = await dynamodb.send(new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'user_id = :uid',
          ExpressionAttributeValues: { ':uid': user_id },
          ProjectionExpression: `user_id, ${sk}`,
          ExclusiveStartKey,
        }));
        items.push(...(result.Items || []));
        ExclusiveStartKey = result.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      if (items.length > 0) {
        const keys = items.map(item => ({ user_id: item.user_id, [sk]: item[sk] }));
        const deleted = await batchDelete(table, keys);
        deletionResults[table] = deleted;
        console.log(`[delete-user-phase3] ${table}: deleted ${deleted}/${items.length}`);
      } else {
        deletionResults[table] = 0;
        console.log(`[delete-user-phase3] ${table}: no items found`);
      }
    } catch (e) {
      console.error(`[delete-user-phase3] ${table} query/delete failed: ${e.message}`);
      deletionResults[table] = `ERROR: ${e.message}`;
    }
  }

  // PK가 user_id가 아닌 테이블: Scan → BatchDelete
  for (const { table, pk, userField } of TABLES_SCAN_BY_USER) {
    try {
      let items = [];
      let lastKey = undefined;
      do {
        const scanResult = await dynamodb.send(new ScanCommand({
          TableName: table,
          FilterExpression: `${userField} = :uid`,
          ExpressionAttributeValues: { ':uid': user_id },
          ProjectionExpression: pk,
          ExclusiveStartKey: lastKey
        }));
        items.push(...(scanResult.Items || []));
        lastKey = scanResult.LastEvaluatedKey;
      } while (lastKey);

      if (items.length > 0) {
        const keys = items.map(item => ({ [pk]: item[pk] }));
        const deleted = await batchDelete(table, keys);
        deletionResults[table] = deleted;
        console.log(`[delete-user-phase3] ${table}: scanned and deleted ${deleted}/${items.length}`);
      } else {
        deletionResults[table] = 0;
        console.log(`[delete-user-phase3] ${table}: no items found for user`);
      }
    } catch (e) {
      console.error(`[delete-user-phase3] ${table} scan/delete failed: ${e.message}`);
      deletionResults[table] = `ERROR: ${e.message}`;
    }
  }

  // Job 진행 기록
  try {
    await dynamodb.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { job_id },
      UpdateExpression: 'SET #phase = :phase, updated_at = :now, deletion_results = :results, phases_completed = list_append(if_not_exists(phases_completed, :empty), :newPhase)',
      ExpressionAttributeNames: { '#phase': 'phase' },
      ExpressionAttributeValues: {
        ':phase': 'DELETE_DYNAMODB',
        ':now': now,
        ':results': deletionResults,
        ':newPhase': ['DELETE_DYNAMODB'],
        ':empty': []
      }
    }));
  } catch (e) {
    console.warn(`[delete-user-phase3] Job update failed (non-fatal):`, e.message);
  }

  console.log(`[delete-user-phase3] Phase 3 completed:`, deletionResults);
  return { success: true, job_id, user_id, phase: 'DELETE_DYNAMODB', deletion_results: deletionResults };
};
