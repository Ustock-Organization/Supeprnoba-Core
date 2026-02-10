/**
 * Supernoba-delete-user-phase2 Lambda
 * Phase 2: CANCEL_ORDERS
 *
 * DynamoDB에서 미체결 주문 조회 → Engine gRPC CancelOrder 개별 호출
 * gRPC 사용 불가 시 Kinesis CANCEL 발행 (fallback)
 * 5초 안정화 대기 (processor가 locked 풀 시간)
 *
 * Input: { job_id, user_id }
 * Timeout: 60s
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));
const kinesis = new KinesisClient({ region: 'ap-northeast-2' });

const ORDERS_TABLE = process.env.ORDERS_TABLE || 'supernoba-orders';
const JOBS_TABLE = process.env.JOBS_TABLE || 'supernoba-delete-user-jobs';
const KINESIS_ORDERS_STREAM = process.env.KINESIS_ORDERS_STREAM || 'supernoba-orders';
const STABILIZATION_WAIT_MS = 5000;

export const handler = async (event) => {
  const { job_id, user_id } = event;
  if (!job_id || !user_id) throw new Error('Missing required fields: job_id, user_id');

  const now = new Date().toISOString();
  console.log(`[delete-user-phase2] Starting CANCEL_ORDERS for user=${user_id}, job=${job_id}`);

  // 1. DynamoDB에서 미체결 주문 조회
  let openOrders = [];
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: ORDERS_TABLE,
      KeyConditionExpression: 'user_id = :uid',
      ExpressionAttributeValues: { ':uid': user_id }
    }));
    openOrders = (result.Items || []).filter(
      o => ['ACCEPTED', 'PARTIALLY_FILLED', 'PARTIAL_FILL', 'PENDING'].includes(o.status)
    );
    console.log(`[delete-user-phase2] Found ${openOrders.length} open orders`);
  } catch (e) {
    console.error(`[delete-user-phase2] Order query failed:`, e.message);
    throw e;
  }

  // 2. Kinesis CANCEL 발행 (각 주문에 대해)
  let cancelledCount = 0;
  let failedOrders = [];

  for (const order of openOrders) {
    try {
      await kinesis.send(new PutRecordCommand({
        StreamName: KINESIS_ORDERS_STREAM,
        Data: Buffer.from(JSON.stringify({
          action: 'CANCEL',
          order_id: order.order_id,
          user_id,
          symbol: order.symbol,
          timestamp: Date.now()
        })),
        PartitionKey: order.symbol
      }));
      cancelledCount++;
      console.log(`[delete-user-phase2] Cancelled: ${order.order_id} (${order.symbol})`);
    } catch (e) {
      console.error(`[delete-user-phase2] Cancel failed for ${order.order_id}: ${e.message}`);
      failedOrders.push(order.order_id);
    }
  }

  // 3. 안정화 대기 (processor가 locked 풀 시간)
  if (cancelledCount > 0) {
    console.log(`[delete-user-phase2] Waiting ${STABILIZATION_WAIT_MS}ms for stabilization...`);
    await new Promise(resolve => setTimeout(resolve, STABILIZATION_WAIT_MS));
  }

  // 4. Job 진행 기록
  try {
    await dynamodb.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { job_id },
      UpdateExpression: 'SET #phase = :phase, updated_at = :now, cancelled_orders = :count, phases_completed = list_append(if_not_exists(phases_completed, :empty), :newPhase)',
      ExpressionAttributeNames: { '#phase': 'phase' },
      ExpressionAttributeValues: {
        ':phase': 'CANCEL_ORDERS',
        ':now': now,
        ':count': cancelledCount,
        ':newPhase': ['CANCEL_ORDERS'],
        ':empty': []
      }
    }));
  } catch (e) {
    console.warn(`[delete-user-phase2] Job update failed (non-fatal):`, e.message);
  }

  console.log(`[delete-user-phase2] Phase 2 completed: ${cancelledCount}/${openOrders.length} cancelled`);
  return {
    success: true, job_id, user_id, phase: 'CANCEL_ORDERS',
    cancelled_count: cancelledCount, total_open: openOrders.length,
    failed_orders: failedOrders
  };
};
