/**
 * Supernoba-delete-user-phase4 Lambda
 * Phase 4: ANONYMIZE_RDS
 *
 * trade_history 테이블에서 해당 사용자의 buyer_user_id, seller_user_id를 '[deleted]'로 UPDATE.
 * 캔들/차트 데이터는 건드리지 않음.
 *
 * Input: { job_id, user_id }
 * Timeout: 300s
 */

import pg from 'pg';

const { Pool } = pg;

const JOBS_TABLE = process.env.JOBS_TABLE || 'supernoba-delete-user-jobs';

// RDS 연결 (환경변수 우선)
const pool = new Pool({
  host: process.env.RDS_ENDPOINT || process.env.RDS_HOST || process.env.DB_HOST,
  port: parseInt(process.env.RDS_PORT || process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || process.env.RDS_DATABASE || 'supernoba',
  user: process.env.DB_USERNAME || process.env.RDS_USERNAME || process.env.DB_USER || 'supernoba',
  password: process.env.DB_PASSWORD || process.env.RDS_PASSWORD,
  ssl: { rejectUnauthorized: false },
  max: 2,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 5000
});

// DynamoDB for job tracking
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));

export const handler = async (event) => {
  const { job_id, user_id } = event;
  if (!job_id || !user_id) throw new Error('Missing required fields: job_id, user_id');

  const now = new Date().toISOString();
  console.log(`[delete-user-phase4] Starting ANONYMIZE_RDS for user=${user_id}, job=${job_id}`);

  let totalUpdated = 0;
  let client;

  try {
    client = await pool.connect();

    // buyer_user_id 익명화
    const buyerResult = await client.query(
      `UPDATE trade_history SET buyer_user_id = '[deleted]' WHERE buyer_user_id = $1`,
      [user_id]
    );
    totalUpdated += buyerResult.rowCount || 0;
    console.log(`[delete-user-phase4] Anonymized ${buyerResult.rowCount} buyer records`);

    // seller_user_id 익명화
    const sellerResult = await client.query(
      `UPDATE trade_history SET seller_user_id = '[deleted]' WHERE seller_user_id = $1`,
      [user_id]
    );
    totalUpdated += sellerResult.rowCount || 0;
    console.log(`[delete-user-phase4] Anonymized ${sellerResult.rowCount} seller records`);

  } catch (e) {
    console.error(`[delete-user-phase4] RDS error:`, e.message);
    throw e; // Step Functions will retry
  } finally {
    if (client) client.release();
  }

  // Job 진행 기록
  try {
    await dynamodb.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { job_id },
      UpdateExpression: 'SET #phase = :phase, updated_at = :now, anonymized_count = :count, phases_completed = list_append(if_not_exists(phases_completed, :empty), :newPhase)',
      ExpressionAttributeNames: { '#phase': 'phase' },
      ExpressionAttributeValues: {
        ':phase': 'ANONYMIZE_RDS',
        ':now': now,
        ':count': totalUpdated,
        ':newPhase': ['ANONYMIZE_RDS'],
        ':empty': []
      }
    }));
  } catch (e) {
    console.warn(`[delete-user-phase4] Job update failed (non-fatal):`, e.message);
  }

  console.log(`[delete-user-phase4] Phase 4 completed: ${totalUpdated} records anonymized`);
  return { success: true, job_id, user_id, phase: 'ANONYMIZE_RDS', anonymized_count: totalUpdated };
};
