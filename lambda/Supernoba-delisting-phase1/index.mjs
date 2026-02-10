/**
 * Supernoba-delisting-phase1 Lambda
 * Phase 1: Order Blocking (Delisting Process)
 *
 * Step Functions or direct invocation from admin panel.
 * Blocks new orders for a symbol by:
 *   1. Adding symbol to Valkey blocked:symbols set
 *   2. Updating DynamoDB supernoba-symbols status to DELISTING
 *   3. Removing symbol from Valkey active:symbols set
 *   4. Removing symbol from Valkey subscribed:symbols set
 *   5. Stopping MM-service for symbol (Pub/Sub + set removal)
 *   6. Recording phase progress in supernoba-delist-jobs table
 *   7. Waiting 5 seconds for in-flight order + Kinesis buffer stabilization
 *
 * Input (from Step Functions or direct invoke):
 * {
 *   "job_id": "uuid",
 *   "symbol": "ABC"
 * }
 *
 * Idempotency:
 * - SADD is idempotent (ignores existing members)
 * - DynamoDB status overwrites with same value are safe
 * - Safe to re-execute without side effects
 *
 * Error handling:
 * - Valkey failure: warn + continue (DynamoDB status blocks orders within 2min cache TTL)
 * - DynamoDB failure: throw (Step Functions will retry)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { getValkeyClient, closeAllValkeyClients } from '/opt/nodejs/index.mjs';

// === Clients (Singleton) ===
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));

// === Config ===
const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';
const DELIST_JOBS_TABLE = process.env.DELIST_JOBS_TABLE || 'supernoba-delist-jobs';

// Stabilization wait after blocking (milliseconds)
const STABILIZATION_WAIT_MS = 5000;

/**
 * Get Valkey client with admin preset (stable connection, retries)
 * Uses Common Layer singleton -- cached across warm invocations.
 */
function getValkey() {
  return getValkeyClient({ type: 'operating', preset: 'admin' });
}

/**
 * Publish an admin event to Valkey Pub/Sub for real-time admin UI updates.
 * Non-blocking: failures are logged but never prevent phase completion.
 */
async function publishAdminEvent(type, payload) {
  try {
    const valkey = getValkey();
    await valkey.publish('admin:events', JSON.stringify({
      type,
      ...payload,
      timestamp: Date.now()
    }));
    console.log(`[Admin Event] Published ${type} for ${payload.symbol}`);
  } catch (e) {
    console.warn(`[Admin Event] Publish failed (non-fatal): ${e.message}`);
  }
}

/**
 * Phase 1: Block orders for a symbol.
 *
 * Valkey operations are best-effort. If Valkey is down, the DynamoDB
 * status update alone will block orders once the order-router's
 * 2-minute symbol cache expires.
 */
export const handler = async (event) => {
  const { job_id, symbol } = event;

  // --- Input validation ---
  if (!job_id || !symbol) {
    throw new Error(`[delisting-phase1] Missing required fields: job_id=${job_id}, symbol=${symbol}`);
  }

  const sym = symbol.toUpperCase().trim();
  const now = new Date().toISOString();
  console.log(`[delisting-phase1] Starting Phase 1 (ORDER_BLOCKED) for symbol=${sym}, job_id=${job_id}`);

  // --- Verify symbol exists in DynamoDB ---
  const { Item: symbolItem } = await dynamodb.send(new GetCommand({
    TableName: SYMBOLS_TABLE,
    Key: { symbol: sym }
  }));

  if (!symbolItem) {
    throw new Error(`[delisting-phase1] Symbol ${sym} not found in ${SYMBOLS_TABLE}`);
  }

  // If already in DELISTING or DELISTED status, log and continue (idempotent)
  if (symbolItem.status === 'DELISTED') {
    console.warn(`[delisting-phase1] Symbol ${sym} is already DELISTED. Returning success (idempotent).`);
    return {
      success: true,
      job_id,
      symbol: sym,
      phase: 'ORDER_BLOCKED',
      blocked_at: now,
      note: 'Symbol already DELISTED'
    };
  }

  let valkeyWarnings = [];

  // --- Step 1: SADD blocked:symbols {symbol} ---
  try {
    const valkey = getValkey();
    const added = await valkey.sadd('blocked:symbols', sym);
    console.log(`[delisting-phase1] SADD blocked:symbols ${sym} -> ${added} (1=new, 0=already existed)`);
  } catch (err) {
    console.warn(`[delisting-phase1] Valkey SADD blocked:symbols failed (continuing): ${err.message}`);
    valkeyWarnings.push(`blocked:symbols SADD failed: ${err.message}`);
  }

  // --- Step 1.5: MM-service 사전 중지 (symbol-admin에서도 보내지만 중복 OK, idempotent) ---
  // MM이 상장폐지 중 주문을 계속 발행하면 Phase 3A 이후에도 키가 재생성되는 레이스 컨디션 발생.
  try {
    const valkey = getValkey();
    await valkey.publish('mm:control', JSON.stringify({
      action: 'stop', symbol: sym, timestamp: Date.now()
    }));
    await valkey.srem('mm:running:symbols', sym);
    await valkey.srem('mm:all:symbols', sym);
    console.log(`[delisting-phase1] MM stop sent + removed from mm sets for ${sym}`);
  } catch (err) {
    console.warn(`[delisting-phase1] MM cleanup warning: ${err.message}`);
    valkeyWarnings.push(`MM cleanup: ${err.message}`);
  }

  // --- Step 2: DynamoDB supernoba-symbols status = 'DELISTING' ---
  // This is the critical step. If this fails, we throw and let Step Functions retry.
  try {
    await dynamodb.send(new UpdateCommand({
      TableName: SYMBOLS_TABLE,
      Key: { symbol: sym },
      UpdateExpression: 'SET #status = :status, updated_at = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'DELISTING',
        ':now': now
      }
    }));
    console.log(`[delisting-phase1] DynamoDB ${SYMBOLS_TABLE} status -> DELISTING for ${sym}`);
  } catch (err) {
    console.error(`[delisting-phase1] CRITICAL: DynamoDB status update failed for ${sym}: ${err.message}`);
    throw err; // Step Functions will retry
  }

  // --- Step 3: SREM active:symbols {symbol} ---
  try {
    const valkey = getValkey();
    const removed = await valkey.srem('active:symbols', sym);
    console.log(`[delisting-phase1] SREM active:symbols ${sym} -> ${removed}`);
  } catch (err) {
    console.warn(`[delisting-phase1] Valkey SREM active:symbols failed (continuing): ${err.message}`);
    valkeyWarnings.push(`active:symbols SREM failed: ${err.message}`);
  }

  // --- Step 4: SREM subscribed:symbols {symbol} ---
  try {
    const valkey = getValkey();
    const removed = await valkey.srem('subscribed:symbols', sym);
    console.log(`[delisting-phase1] SREM subscribed:symbols ${sym} -> ${removed}`);
  } catch (err) {
    console.warn(`[delisting-phase1] Valkey SREM subscribed:symbols failed (continuing): ${err.message}`);
    valkeyWarnings.push(`subscribed:symbols SREM failed: ${err.message}`);
  }

  // --- Step 5: DynamoDB delist-jobs phase = 'ORDER_BLOCKED' ---
  try {
    await dynamodb.send(new UpdateCommand({
      TableName: DELIST_JOBS_TABLE,
      Key: { job_id },
      UpdateExpression: 'SET #phase = :phase, blocked_at = :now, symbol = :symbol, updated_at = :now, phases_completed = list_append(if_not_exists(phases_completed, :empty), :newPhase)',
      ExpressionAttributeNames: { '#phase': 'phase' },
      ExpressionAttributeValues: {
        ':phase': 'ORDER_BLOCKED',
        ':now': now,
        ':symbol': sym,
        ':newPhase': ['ORDER_BLOCKED'],
        ':empty': []
      }
    }));
    console.log(`[delisting-phase1] DynamoDB ${DELIST_JOBS_TABLE} phase -> ORDER_BLOCKED for job_id=${job_id}`);

    // Publish progress event to admin WebSocket clients
    await publishAdminEvent('delist_progress', {
      job_id, symbol: sym, phase: 'ORDER_BLOCKED', status: 'IN_PROGRESS',
      phases_completed: ['ORDER_BLOCKED']
    });
  } catch (err) {
    // Job tracking failure is non-fatal -- the actual blocking already succeeded
    console.warn(`[delisting-phase1] delist-jobs update failed (non-fatal): ${err.message}`);
    valkeyWarnings.push(`delist-jobs update failed: ${err.message}`);
  }

  // --- Step 6: Stabilization wait (3 seconds) ---
  // Allow in-flight orders that passed the symbol check before the block
  // to complete their Kinesis publish. After this window, the matching
  // engine and order-router will both reject new orders for this symbol.
  console.log(`[delisting-phase1] Waiting ${STABILIZATION_WAIT_MS}ms for in-flight order stabilization...`);
  await new Promise(resolve => setTimeout(resolve, STABILIZATION_WAIT_MS));
  console.log(`[delisting-phase1] Stabilization complete.`);

  // --- Step 7: Return result ---
  const result = {
    success: true,
    job_id,
    symbol: sym,
    phase: 'ORDER_BLOCKED',
    blocked_at: now
  };

  if (valkeyWarnings.length > 0) {
    result.warnings = valkeyWarnings;
    console.warn(`[delisting-phase1] Completed with ${valkeyWarnings.length} warning(s):`, valkeyWarnings);
  }

  console.log(`[delisting-phase1] Phase 1 completed successfully for ${sym}`);
  return result;
};
