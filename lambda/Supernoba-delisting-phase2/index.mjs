/**
 * Supernoba-delisting-phase2 Lambda
 * 상장폐지 Phase 2: 엔진 주문 정리
 *
 * Step Functions에서 호출됨.
 * 입력: { job_id, symbol, phase: "ORDER_BLOCKED" }
 *
 * 처리 순서:
 *   1. gRPC CancelAllOrders(symbol) -- 엔진의 모든 잔여 주문 취소
 *      -> Engine이 cancel 콜백 발행 -> stock-processor가 DynamoDB 업데이트 + locked 해제
 *   2. 5초 안정화 대기 (stock-processor 처리 시간 확보)
 *   3. gRPC RemoveOrderBook(symbol) -- 엔진 오더북 제거
 *   4. Valkey: DEL snapshot:{symbol}, snapshot:{symbol}:timestamp
 *   5. DynamoDB: delist-jobs phase = 'ENGINE_CLEANED', cancelled_orders = N
 *   6. 반환: { success, job_id, symbol, phase, cancelled_count, failed_order_ids }
 *
 * 에러 처리:
 *   - gRPC 실패 (Engine 다운): throw -> Step Functions 재시도
 *   - Valkey DEL 실패: 경고 로그, 계속 진행 (snapshot은 TTL로 자동 만료)
 *
 * 환경:
 *   - VPC 내 실행 (Engine gRPC + Valkey 접근 필요)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { UpdateCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// 환경변수
// ---------------------------------------------------------------------------
const ENGINE_GRPC_HOST = process.env.ENGINE_GRPC_HOST || '172.31.47.97:50051';
const VALKEY_HOST = process.env.VALKEY_HOST || '172.31.10.211';
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT || '6379', 10);
const DELIST_JOBS_TABLE = process.env.DELIST_JOBS_TABLE || 'supernoba-delist-jobs';
const STABILIZATION_DELAY_MS = parseInt(process.env.STABILIZATION_DELAY_MS || '5000', 10);

// ---------------------------------------------------------------------------
// AWS 클라이언트
// ---------------------------------------------------------------------------
const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: 'ap-northeast-2' })
);

// ---------------------------------------------------------------------------
// Valkey (ioredis) -- lazy 초기화, Lambda 컨테이너 재활용
// ---------------------------------------------------------------------------
// 4-Cache는 포트가 다른 별개 인스턴스다. 단일 연결(6379=depth)로 다루면
// admin:events(operating 6382)는 구독자 없는 캐시에 발행되고, snapshot:{sym}
// (backup 6381)은 지워지지 않고 남는다.
const CACHE_PORTS = {
  depth: parseInt(process.env.DEPTH_CACHE_PORT || '6379', 10),
  candle: parseInt(process.env.CANDLE_CACHE_PORT || '6380', 10),
  backup: parseInt(process.env.BACKUP_CACHE_PORT || '6381', 10),
  operating: parseInt(process.env.OPERATING_CACHE_PORT || '6382', 10),
};
const redisClients = {};
function getRedis(type = 'operating') {
  if (redisClients[type]) return redisClients[type];
  const client = new Redis({
    host: VALKEY_HOST,
    port: CACHE_PORTS[type] || VALKEY_PORT,
    connectTimeout: 5000,
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });
  client.on('error', (err) => {
    console.error(`[delisting-phase2] Redis(${type}) connection error:`, err.message);
  });
  redisClients[type] = client;
  return client;
}

// ---------------------------------------------------------------------------
// gRPC 클라이언트 -- lazy 초기화
// ---------------------------------------------------------------------------
let grpcClient = null;

function getGrpcClient() {
  if (grpcClient) return grpcClient;

  const PROTO_PATH = path.join(__dirname, 'snapshot.proto');
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
  grpcClient = new protoDescriptor.aws_wrapper.SnapshotService(
    ENGINE_GRPC_HOST,
    grpc.credentials.createInsecure(),
    { 'grpc.max_receive_message_length': 100 * 1024 * 1024 }
  );
  return grpcClient;
}

// 관리 채널 인증 토큰(x-engine-token)을 담은 메타데이터. 엔진이 ENGINE_GRPC_TOKEN과 대조한다.
function buildAuthMetadata() {
  const metadata = new grpc.Metadata();
  const token = process.env.ENGINE_GRPC_TOKEN;
  if (token) metadata.set('x-engine-token', token);
  return metadata;
}

// ---------------------------------------------------------------------------
// gRPC Promise 래퍼
// ---------------------------------------------------------------------------

/**
 * 종목의 모든 잔여 주문을 취소한다.
 * Engine이 각 주문에 대해 cancel 콜백을 발행하며,
 * stock-processor가 DynamoDB 업데이트 + locked 해제를 처리한다.
 *
 * @param {string} symbol
 * @returns {Promise<{success: boolean, cancelled_count: number, failed_order_ids: string[], error: string}>}
 */
function cancelAllOrders(symbol) {
  return new Promise((resolve, reject) => {
    const client = getGrpcClient();
    const deadline = new Date(Date.now() + 30000); // 30초 -- 대량 주문 취소 대비
    client.CancelAllOrders({ symbol }, buildAuthMetadata(), { deadline }, (err, response) => {
      if (err) {
        reject(new Error(`gRPC CancelAllOrders failed: ${err.message} (code=${err.code})`));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * 엔진에서 오더북을 제거한다.
 * 제거 후 해당 종목으로의 신규 주문은 엔진에서 거부된다.
 *
 * @param {string} symbol
 * @returns {Promise<{success: boolean, error: string}>}
 */
function removeOrderBook(symbol) {
  return new Promise((resolve, reject) => {
    const client = getGrpcClient();
    const deadline = new Date(Date.now() + 10000); // 10초
    client.RemoveOrderBook({ symbol }, buildAuthMetadata(), { deadline }, (err, response) => {
      if (err) {
        reject(new Error(`gRPC RemoveOrderBook failed: ${err.message} (code=${err.code})`));
      } else {
        resolve(response);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Admin Event Publishing
// ---------------------------------------------------------------------------

/**
 * Publish an admin event to Valkey Pub/Sub for real-time admin UI updates.
 * Non-blocking: failures are logged but never prevent phase completion.
 * Uses ioredis (getRedis) since this Lambda does not use the common layer Valkey client.
 */
async function publishAdminEvent(type, payload) {
  try {
    const r = getRedis();
    await r.connect().catch(() => {}); // 이미 연결된 경우 무시
    await r.publish('admin:events', JSON.stringify({
      type,
      ...payload,
      timestamp: Date.now()
    }));
    console.log(`[Admin Event] Published ${type} for ${payload.symbol}`);
  } catch (e) {
    console.warn(`[Admin Event] Publish failed (non-fatal): ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 유틸리티
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 핸들러
// ---------------------------------------------------------------------------
export const handler = async (event) => {
  const { job_id, symbol, phase } = event;

  console.log(`[delisting-phase2] START job_id=${job_id} symbol=${symbol} phase=${phase}`);

  // 입력 검증
  if (!job_id || !symbol) {
    throw new Error('Missing required fields: job_id, symbol');
  }
  if (phase !== 'ORDER_BLOCKED') {
    throw new Error(`Unexpected phase: ${phase}. Expected ORDER_BLOCKED.`);
  }

  const sym = symbol.toUpperCase().trim();

  // =========================================================================
  // Step 1: gRPC CancelAllOrders
  // =========================================================================
  console.log(`[delisting-phase2] Step 1: CancelAllOrders(${sym})`);
  let cancelResponse;
  try {
    cancelResponse = await cancelAllOrders(sym);
  } catch (err) {
    console.error(`[delisting-phase2] CancelAllOrders FAILED:`, err.message);
    // gRPC 실패 -> throw -> Step Functions가 재시도
    throw err;
  }

  const cancelledCount = parseInt(cancelResponse.cancelled_count || '0', 10);
  const failedOrderIds = cancelResponse.failed_order_ids || [];

  console.log(
    `[delisting-phase2] CancelAllOrders result: success=${cancelResponse.success}` +
    ` cancelled=${cancelledCount} failed=${failedOrderIds.length}`
  );

  if (!cancelResponse.success) {
    // Engine이 명시적으로 실패를 보고한 경우
    const errMsg = `CancelAllOrders returned success=false: ${cancelResponse.error || 'unknown'}`;
    console.error(`[delisting-phase2] ${errMsg}`);
    throw new Error(errMsg);
  }

  if (failedOrderIds.length > 0) {
    // 부분 실패: 일부 주문 취소 실패. 로그에 기록하되 계속 진행.
    // RemoveOrderBook이 남은 주문을 강제 제거하므로 데이터 정합성은 유지됨.
    console.warn(
      `[delisting-phase2] Partial cancel failure. Failed order IDs: ${failedOrderIds.join(', ')}`
    );
  }

  // =========================================================================
  // Step 2: 안정화 대기 (stock-processor 처리 시간)
  // =========================================================================
  console.log(`[delisting-phase2] Step 2: Stabilization wait ${STABILIZATION_DELAY_MS}ms`);
  await sleep(STABILIZATION_DELAY_MS);

  // =========================================================================
  // Step 3: gRPC RemoveOrderBook
  // =========================================================================
  console.log(`[delisting-phase2] Step 3: RemoveOrderBook(${sym})`);
  let removeResponse;
  try {
    removeResponse = await removeOrderBook(sym);
  } catch (err) {
    console.error(`[delisting-phase2] RemoveOrderBook FAILED:`, err.message);
    // gRPC 실패 -> throw -> Step Functions가 재시도
    throw err;
  }

  if (!removeResponse.success) {
    const errMsg = `RemoveOrderBook returned success=false: ${removeResponse.error || 'unknown'}`;
    console.error(`[delisting-phase2] ${errMsg}`);
    throw new Error(errMsg);
  }

  console.log(`[delisting-phase2] RemoveOrderBook success for ${sym}`);

  // =========================================================================
  // Step 4: Valkey -- snapshot 키 삭제
  // =========================================================================
  console.log(`[delisting-phase2] Step 4: Valkey snapshot cleanup`);
  try {
    const r = getRedis('backup');   // snapshot:{sym}은 backup 캐시(6381)에 있다
    await r.connect().catch(() => {}); // 이미 연결된 경우 무시
    const deletedCount = await r.del(`snapshot:${sym}`, `snapshot:${sym}:timestamp`);
    console.log(`[delisting-phase2] Valkey DEL snapshot keys: ${deletedCount} removed`);
  } catch (valkeyErr) {
    // Valkey 실패는 non-fatal -- snapshot은 TTL로 자동 만료됨
    console.warn(
      `[delisting-phase2] Valkey cleanup warning (non-fatal): ${valkeyErr.message}`
    );
  }

  // =========================================================================
  // Step 5: DynamoDB -- delist-jobs 상태 업데이트
  // =========================================================================
  console.log(`[delisting-phase2] Step 5: DynamoDB delist-jobs update`);
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: DELIST_JOBS_TABLE,
        Key: { job_id },
        UpdateExpression:
          'SET #phase = :phase, cancelled_orders = :cnt, failed_order_ids = :failed, engine_cleaned_at = :now, updated_at = :now2, phases_completed = list_append(if_not_exists(phases_completed, :empty), :newPhase)',
        ExpressionAttributeNames: {
          '#phase': 'phase',
        },
        ExpressionAttributeValues: {
          ':phase': 'ENGINE_CLEANED',
          ':cnt': cancelledCount,
          ':failed': failedOrderIds,
          ':now': new Date().toISOString(),
          ':now2': new Date().toISOString(),
          ':newPhase': ['ENGINE_CLEANED'],
          ':empty': [],
        },
      })
    );
    console.log(`[delisting-phase2] DynamoDB updated: phase=ENGINE_CLEANED`);

    // Publish progress event to admin WebSocket clients
    await publishAdminEvent('delist_progress', {
      job_id, symbol: sym, phase: 'ENGINE_CLEANED', status: 'IN_PROGRESS',
      phases_completed: ['ORDER_BLOCKED', 'ENGINE_CLEANED'],
      cancelled_orders: cancelledCount
    });
  } catch (dbErr) {
    console.error(`[delisting-phase2] DynamoDB update FAILED:`, dbErr.message);
    // DynamoDB 실패도 throw -> Step Functions가 재시도
    throw dbErr;
  }

  // =========================================================================
  // 결과 반환
  // =========================================================================
  const result = {
    success: true,
    job_id,
    symbol: sym,
    phase: 'ENGINE_CLEANED',
    cancelled_count: cancelledCount,
    failed_order_ids: failedOrderIds,
  };

  console.log(`[delisting-phase2] DONE`, JSON.stringify(result));
  return result;
};
