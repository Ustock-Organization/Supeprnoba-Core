/**
 * Supernoba-delisting-phase4 Lambda
 * Phase 4: Final Verification (Delisting Process)
 *
 * Verifies that ALL data for a delisted symbol has been completely removed
 * from every data store (Valkey, DynamoDB, RDS).
 *
 * Input (from Step Functions or direct invoke):
 * {
 *   "job_id": "uuid",
 *   "symbol": "ABC",
 *   "phase": "USER_DATA_CLEANED"
 * }
 *
 * Verification checklist:
 *   1. Valkey: ticker, active:symbols, subscribed:symbols, depth
 *   2. DynamoDB supernoba-symbols: symbol record removed
 *   3. RDS candle_history: no rows remain for symbol
 *   4. RDS partition table: candle_history_{symbol} dropped
 *   5. DynamoDB supernoba-holdings: no holdings for symbol
 *   6. DynamoDB supernoba-orders: no orders for symbol
 *
 * Idempotency:
 * - All checks are read-only -- no side effects during verification
 * - Completion actions (deleted:symbols SADD, blocked:symbols SREM) are idempotent
 * - Safe to re-execute without risk
 *
 * Error handling:
 * - Each check runs independently; a single failure does not abort others
 * - PARTIAL_FAILURE preserves blocked:symbols (orders remain blocked)
 * - Valkey/RDS connection failures are caught per-check, not fatal
 */

import pg from 'pg';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { getValkeyClient } from '/opt/nodejs/index.mjs';

const { Client: PgClient } = pg;

// === Clients (Singleton) ===
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));

// === Config ===
const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';
const DELIST_JOBS_TABLE = process.env.DELIST_JOBS_TABLE || 'supernoba-delist-jobs';
const HOLDINGS_TABLE = process.env.HOLDINGS_TABLE || 'supernoba-holdings';
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'supernoba-orders';

// RDS Config
const RDS_HOST = process.env.RDS_ENDPOINT || 'supernoba-rdb1.cluster-cyxfcbnpfoci.ap-northeast-2.rds.amazonaws.com';
const RDS_PORT = parseInt(process.env.RDS_PORT || '5432');
const DB_NAME = process.env.DB_NAME || 'postgres';
const DB_SECRET_ARN = process.env.DB_SECRET_ARN || '';
const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-2';

// === RDS Credentials ===
const secretsManager = new SecretsManagerClient({ region: AWS_REGION });
let cachedCredentials = null;

async function getDbCredentials() {
  // Priority 1: Cached credentials (warm invocation)
  if (cachedCredentials) {
    return cachedCredentials;
  }

  // Priority 2: Secrets Manager (matches Phase 3 approach — env vars may have escaping issues)
  if (DB_SECRET_ARN) {
    try {
      const res = await secretsManager.send(new GetSecretValueCommand({ SecretId: DB_SECRET_ARN }));
      cachedCredentials = JSON.parse(res.SecretString);
      return cachedCredentials;
    } catch (err) {
      console.warn(`[delisting-phase4] Secrets Manager fetch failed: ${err.message}`);
    }
  }

  // Priority 3: Environment variables (fallback)
  const envUsername = process.env.DB_USERNAME;
  const envPassword = process.env.DB_PASSWORD;

  if (envUsername && envPassword) {
    return { username: envUsername, password: envPassword };
  }

  return { username: 'postgres', password: '' };
}

// 4-Cache clients (operating + depth)
const operatingCache = getValkeyClient({ type: 'operating', preset: 'admin' });
const depthCache = getValkeyClient({ type: 'depth', preset: 'admin' });

/**
 * Publish an admin event to Valkey Pub/Sub for real-time admin UI updates.
 * Non-blocking: failures are logged but never prevent phase completion.
 */
async function publishAdminEvent(type, payload) {
  try {
    await operatingCache.publish('admin:events', JSON.stringify({
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
 * Create a new RDS (PostgreSQL) client, connect, and return it.
 * Caller is responsible for calling client.end() in finally.
 */
async function createRdsClient() {
  const creds = await getDbCredentials();
  const client = new PgClient({
    host: RDS_HOST,
    port: RDS_PORT,
    database: DB_NAME,
    user: creds.username,
    password: creds.password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  return client;
}

/**
 * Run a single verification check. Catches errors so one failed check
 * does not block the remaining checks.
 *
 * @param {string} name - Human-readable check identifier
 * @param {() => Promise<boolean>} fn - Async function returning true if check passes
 * @returns {{ name: string, pass: boolean, error?: string }}
 */
async function runCheck(name, fn) {
  try {
    const pass = await fn();
    return { name, pass };
  } catch (err) {
    console.error(`[delisting-phase4] Check '${name}' threw: ${err.message}`);
    return { name, pass: false, error: err.message };
  }
}

/**
 * Phase 4: Verify all data stores are clean for the delisted symbol.
 */
export const handler = async (event) => {
  const { job_id, symbol } = event;

  // --- Input validation ---
  if (!job_id || !symbol) {
    throw new Error(`[delisting-phase4] Missing required fields: job_id=${job_id}, symbol=${symbol}`);
  }

  const sym = symbol.toUpperCase().trim();
  const now = new Date().toISOString();
  console.log(`[delisting-phase4] Starting Phase 4 (VERIFICATION) for symbol=${sym}, job_id=${job_id}`);

  // ===================================================================
  // Verification Checks
  // ===================================================================
  const checks = [];
  let pgClient = null;

  try {
    // --- 1. Valkey checks (depth cache: ticker/depth, operating cache: active/subscribed) ---
    checks.push(await runCheck('valkey:ticker', async () => {
      const val = await depthCache.get(`ticker:${sym}`);
      return !val;
    }));

    checks.push(await runCheck('valkey:active', async () => {
      const isMember = await operatingCache.sismember('active:symbols', sym);
      return !isMember;
    }));

    checks.push(await runCheck('valkey:subscribed', async () => {
      const isMember = await operatingCache.sismember('subscribed:symbols', sym);
      return !isMember;
    }));

    checks.push(await runCheck('valkey:depth', async () => {
      const val = await depthCache.get(`depth:${sym}`);
      return !val;
    }));

    // --- 2. DynamoDB symbols check ---
    checks.push(await runCheck('dynamodb:symbols', async () => {
      const { Item } = await dynamodb.send(new GetCommand({
        TableName: SYMBOLS_TABLE,
        Key: { symbol: sym }
      }));
      return !Item;
    }));

    // --- 3. RDS checks ---
    try {
      pgClient = await createRdsClient();

      // 3a. candle_history rows for this symbol
      checks.push(await runCheck('rds:candle_history', async () => {
        const result = await pgClient.query(
          'SELECT count(*) AS cnt FROM candle_history WHERE symbol = $1',
          [sym.toLowerCase()]
        );
        return parseInt(result.rows[0].cnt) === 0;
      }));

      // 3b. Partition table existence
      const symLower = sym.toLowerCase();
      checks.push(await runCheck('rds:partition_table', async () => {
        const result = await pgClient.query(
          "SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = $1",
          [`candle_history_${symLower}`]
        );
        return result.rows.length === 0;
      }));
    } catch (rdsConnErr) {
      console.error(`[delisting-phase4] RDS connection failed: ${rdsConnErr.message}`);
      checks.push({ name: 'rds:candle_history', pass: false, error: `RDS connection failed: ${rdsConnErr.message}` });
      checks.push({ name: 'rds:partition_table', pass: false, error: `RDS connection failed: ${rdsConnErr.message}` });
    }

    // --- 4. DynamoDB holdings check ---
    checks.push(await runCheck('dynamodb:holdings', async () => {
      const result = await dynamodb.send(new ScanCommand({
        TableName: HOLDINGS_TABLE,
        FilterExpression: 'symbol = :sym',
        ExpressionAttributeValues: { ':sym': sym },
        Limit: 1,
      }));
      return (result.Items || []).length === 0;
    }));

    // --- 5. DynamoDB orders check ---
    checks.push(await runCheck('dynamodb:orders', async () => {
      const result = await dynamodb.send(new ScanCommand({
        TableName: ORDERS_TABLE,
        FilterExpression: 'symbol = :sym',
        ExpressionAttributeValues: { ':sym': sym },
        Limit: 1,
      }));
      return (result.Items || []).length === 0;
    }));
  } finally {
    // Always release the RDS connection
    if (pgClient) {
      await pgClient.end().catch(() => {});
    }
  }

  // ===================================================================
  // Result Processing
  // ===================================================================
  let failedChecks = checks.filter(c => !c.pass).map(c => c.name);

  // --- Self-Heal: Valkey 키가 MM 레이스 컨디션으로 재출현한 경우 자가 치유 ---
  // Phase 3A에서 삭제했지만, MM-service의 잔여 Kinesis 레코드가 Engine에 의해 처리되어
  // ticker/depth 등의 키가 재생성될 수 있음. Valkey 키만 실패한 경우 재삭제 + 재검증.
  if (failedChecks.length > 0) {
    const valkeyFailures = failedChecks.filter(c => c.startsWith('valkey:'));

    if (valkeyFailures.length > 0 && valkeyFailures.length === failedChecks.length) {
      console.log(`[delisting-phase4] Self-heal: ${valkeyFailures.length} Valkey checks failed, attempting cleanup + re-verify`);

      try {
        // Split cleanup keys by cache type
        const depthKeys = [
          `ticker:${sym}`, `depth:${sym}`, `ohlc:${sym}`, `prev:${sym}`
        ];
        const operatingKeys = [
          `symbol:${sym}:main`, `symbol:${sym}:sub`, `symbol:${sym}:subscribers`, `symbol:${sym}:listingPrice`,
          `mm:config:${sym}`, `mm:price:${sym}`, `mm:orderCount:${sym}`, `mm:started_at:${sym}`
        ];
        const candleKeys = [
          ...['1m','5m','15m','30m','1h','2h','4h','1d','1w'].map(tf => `candle:${tf}:${sym}`),
          `candle:closed:1m:${sym}`
        ];

        // Delete keys from respective caches + srem operating sets
        const candleCacheClient = getValkeyClient({ type: 'candle', preset: 'admin' });
        await Promise.all([
          depthCache.del(...depthKeys),
          operatingCache.del(...operatingKeys),
          candleCacheClient.del(...candleKeys),
          operatingCache.srem('mm:all:symbols', sym),
          operatingCache.srem('mm:running:symbols', sym),
          operatingCache.srem('active:symbols', sym),
          operatingCache.srem('subscribed:symbols', sym)
        ]);

        console.log(`[delisting-phase4] Self-heal cleanup done, re-verifying after 1s...`);
        await new Promise(r => setTimeout(r, 1000));

        let healedCount = 0;
        for (const checkName of valkeyFailures) {
          if (checkName === 'valkey:ticker') {
            const val = await depthCache.get(`ticker:${sym}`);
            if (!val) healedCount++;
          } else if (checkName === 'valkey:depth') {
            const val = await depthCache.get(`depth:${sym}`);
            if (!val) healedCount++;
          } else if (checkName === 'valkey:active') {
            const m = await operatingCache.sismember('active:symbols', sym);
            if (!m) healedCount++;
          } else if (checkName === 'valkey:subscribed') {
            const m = await operatingCache.sismember('subscribed:symbols', sym);
            if (!m) healedCount++;
          }
        }

        if (healedCount === valkeyFailures.length) {
          console.log(`[delisting-phase4] Self-heal SUCCESS: all ${healedCount} Valkey checks now pass`);
          failedChecks = failedChecks.filter(c => !c.startsWith('valkey:'));
        } else {
          console.warn(`[delisting-phase4] Self-heal PARTIAL: ${healedCount}/${valkeyFailures.length} healed`);
        }
      } catch (healErr) {
        console.error(`[delisting-phase4] Self-heal failed: ${healErr.message}`);
      }
    }
  }

  const allPassed = failedChecks.length === 0;

  // Log individual results
  for (const c of checks) {
    const mark = c.pass ? 'PASS' : 'FAIL';
    const extra = c.error ? ` (${c.error})` : '';
    console.log(`[delisting-phase4]   [${mark}] ${c.name}${extra}`);
  }

  if (allPassed) {
    // --- All clean: mark as COMPLETED ---
    console.log(`[delisting-phase4] All ${checks.length} checks passed. Marking job as COMPLETED.`);

    // Valkey: move from blocked to deleted (both idempotent)
    try {
      await operatingCache.sadd('deleted:symbols', sym);
      await operatingCache.srem('blocked:symbols', sym);
      console.log(`[delisting-phase4] Valkey: SADD deleted:symbols, SREM blocked:symbols for ${sym}`);
    } catch (err) {
      console.warn(`[delisting-phase4] Valkey update failed (non-fatal): ${err.message}`);
    }

    // DynamoDB: update delist job to COMPLETED / VERIFIED
    try {
      await dynamodb.send(new UpdateCommand({
        TableName: DELIST_JOBS_TABLE,
        Key: { job_id },
        UpdateExpression: 'SET #status = :status, phase = :phase, completed_at = :now, updated_at = :now, phases_completed = list_append(if_not_exists(phases_completed, :empty), :newPhase)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'COMPLETED',
          ':phase': 'VERIFIED',
          ':now': now,
          ':newPhase': ['VERIFIED'],
          ':empty': [],
        },
      }));
      console.log(`[delisting-phase4] DynamoDB ${DELIST_JOBS_TABLE} -> COMPLETED / VERIFIED`);

      // Publish final completion event to admin WebSocket clients
      await publishAdminEvent('delist_progress', {
        job_id, symbol: sym, phase: 'VERIFIED', status: 'COMPLETED',
        phases_completed: ['ORDER_BLOCKED', 'ENGINE_CLEANED', 'VALKEY_CLEANED', 'RDS_CLEANED', 'SYMBOL_DELETED', 'USER_DATA_CLEANED', 'VERIFIED'],
        failed_checks: []
      });
    } catch (err) {
      console.error(`[delisting-phase4] CRITICAL: delist-jobs COMPLETED update failed: ${err.message}`);
      throw err; // Step Functions should retry
    }

    return {
      success: true,
      job_id,
      symbol: sym,
      status: 'COMPLETED',
      checks_total: checks.length,
      checks_passed: checks.length,
      failed_checks: [],
    };
  } else {
    // --- Partial failure: some data remains ---
    console.warn(`[delisting-phase4] ${failedChecks.length}/${checks.length} checks failed: ${failedChecks.join(', ')}`);

    // blocked:symbols is intentionally preserved -- orders remain blocked
    try {
      await dynamodb.send(new UpdateCommand({
        TableName: DELIST_JOBS_TABLE,
        Key: { job_id },
        UpdateExpression: 'SET #status = :status, failed_checks = :checks, updated_at = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'PARTIAL_FAILURE',
          ':checks': failedChecks,
          ':now': now,
        },
      }));
      console.log(`[delisting-phase4] DynamoDB ${DELIST_JOBS_TABLE} -> PARTIAL_FAILURE`);

      // Publish partial failure event to admin WebSocket clients
      await publishAdminEvent('delist_progress', {
        job_id, symbol: sym, phase: 'VERIFIED', status: 'PARTIAL_FAILURE',
        phases_completed: ['ORDER_BLOCKED', 'ENGINE_CLEANED', 'VALKEY_CLEANED', 'RDS_CLEANED', 'SYMBOL_DELETED', 'USER_DATA_CLEANED', 'VERIFIED'],
        failed_checks: failedChecks
      });
    } catch (err) {
      console.warn(`[delisting-phase4] delist-jobs PARTIAL_FAILURE update failed (non-fatal): ${err.message}`);
    }

    return {
      success: false,
      job_id,
      symbol: sym,
      status: 'PARTIAL_FAILURE',
      checks_total: checks.length,
      checks_passed: checks.length - failedChecks.length,
      failed_checks: failedChecks,
    };
  }
};
