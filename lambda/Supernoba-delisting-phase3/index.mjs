/**
 * Supernoba-delisting-phase3 Lambda
 * Phase 3: Data Cleanup (Delisting Process)
 *
 * Cleans up ALL data associated with a delisted symbol across every storage layer:
 *   Step 3A: Valkey cache cleanup (28+ keys, rankings, sets)
 *   Step 3B: RDS PostgreSQL data deletion (transactional) + partition drop
 *   Step 3C: DynamoDB symbols metadata deletion
 *   Step 3D: DynamoDB user data cleanup (holdings, orders, favorites)
 *
 * Input (from Step Functions or direct invoke):
 * {
 *   "job_id": "uuid",
 *   "symbol": "ABC",
 *   "phase": "ENGINE_CLEANED"
 * }
 *
 * Runs inside VPC (Valkey + RDS access required).
 * Lambda timeout: 15 minutes (large Scan+Delete operations on user data).
 *
 * Idempotency:
 * - Valkey DEL/ZREM/SREM are idempotent (no-op on missing keys)
 * - SQL DELETE WHERE is idempotent (0 rows deleted if already cleaned)
 * - DROP TABLE IF EXISTS is idempotent
 * - DynamoDB DeleteCommand on missing items is idempotent
 * - Scan+BatchWrite on empty results is a safe no-op
 *
 * Error handling:
 * - Each sub-step updates delist-jobs phase independently
 * - Valkey failures: warn + continue (non-critical cache data)
 * - RDS failures: throw (Step Functions will retry)
 * - DynamoDB symbol deletion: throw (critical metadata)
 * - User data cleanup: warn + continue (can be retried manually)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
  BatchWriteCommand
} from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import pg from 'pg';

import { getValkeyClient } from '/opt/nodejs/index.mjs';

// === Clients (Singleton) ===
const { Client: PgClient } = pg;
const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: 'ap-northeast-2' }),
  { marshallOptions: { removeUndefinedValues: true } }
);
const secrets = new SecretsManagerClient({ region: 'ap-northeast-2' });

// === Config ===
const SYMBOLS_TABLE   = process.env.SYMBOLS_TABLE   || 'supernoba-symbols';
const DELIST_JOBS_TABLE = process.env.DELIST_JOBS_TABLE || 'supernoba-delist-jobs';
const HOLDINGS_TABLE  = process.env.HOLDINGS_TABLE  || 'supernoba-holdings';
const ORDERS_TABLE    = process.env.ORDERS_TABLE    || 'supernoba-orders';
const FAVORITES_TABLE = process.env.FAVORITES_TABLE || 'supernoba-favorites';

const RDS_HOST       = process.env.RDS_ENDPOINT || 'supernoba-rdb1.cluster-cyxfcbnpfoci.ap-northeast-2.rds.amazonaws.com';
const DB_SECRET_ARN  = process.env.DB_SECRET_ARN || '';

// Symbol name validation: only alphanumeric and underscore (for safe DROP TABLE)
const SYMBOL_PATTERN = /^[A-Z0-9_]+$/;

// Valkey timeframes for candle keys
const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w'];

// === Shared state (warm invocation reuse) ===
let dbCreds = null;
let pgClient = null;

// ============================================================
// Helpers
// ============================================================

// admin:events 채널·심볼 라이프사이클 키는 operating(6382)에 있다. type을 생략하면
// depth(6379)로 폴백해 구독자가 없는 캐시에 발행하게 된다.
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
 * Get or create a PostgreSQL connection.
 * Reused across warm invocations. Reconnects on failure.
 */
async function getPg() {
  if (pgClient) {
    try {
      await pgClient.query('SELECT 1');
      return pgClient;
    } catch {
      // Connection died -- reconnect
      pgClient = null;
    }
  }

  if (!dbCreds) {
    if (DB_SECRET_ARN) {
      const r = await secrets.send(new GetSecretValueCommand({ SecretId: DB_SECRET_ARN }));
      const s = JSON.parse(r.SecretString);
      dbCreds = { username: s.username, password: s.password };
    } else if (process.env.DB_USERNAME && process.env.DB_PASSWORD) {
      dbCreds = { username: process.env.DB_USERNAME, password: process.env.DB_PASSWORD };
    } else {
      throw new Error('[delisting-phase3] No database credentials available');
    }
  }

  const client = new PgClient({
    host: RDS_HOST,
    port: 5432,
    database: process.env.DB_NAME || 'supernoba',
    user: dbCreds.username,
    password: dbCreds.password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
    query_timeout: 120000 // 2 minutes per query (large DELETE)
  });
  await client.connect();
  pgClient = client;
  return pgClient;
}

/**
 * Update delist-jobs table with current phase progress.
 * Non-fatal: logs warning on failure.
 */
async function updateJobPhase(job_id, phase) {
  try {
    await dynamodb.send(new UpdateCommand({
      TableName: DELIST_JOBS_TABLE,
      Key: { job_id },
      UpdateExpression: 'SET #phase = :phase, phases_completed = list_append(if_not_exists(phases_completed, :empty), :newPhase), updated_at = :now',
      ExpressionAttributeNames: { '#phase': 'phase' },
      ExpressionAttributeValues: {
        ':phase': phase,
        ':newPhase': [phase],
        ':empty': [],
        ':now': new Date().toISOString()
      }
    }));
    console.log(`[delisting-phase3] delist-jobs phase -> ${phase} for job_id=${job_id}`);
  } catch (err) {
    console.warn(`[delisting-phase3] delist-jobs update to ${phase} failed (non-fatal): ${err.message}`);
  }
}

/**
 * Generic scan-and-batch-delete for DynamoDB tables.
 * Scans with a filter, then batch-deletes in chunks of 25.
 *
 * @param {string} tableName
 * @param {string} filterExpression
 * @param {Object} expressionAttributeValues
 * @param {Function} keyMapper - (item) => Key object for DeleteRequest
 * @param {string} logLabel
 * @returns {number} Total deleted count
 */
async function scanAndDelete(tableName, filterExpression, expressionAttributeValues, keyMapper, logLabel) {
  let deletedCount = 0;
  let lastKey = undefined;

  do {
    const result = await dynamodb.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: filterExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ExclusiveStartKey: lastKey,
      Limit: 100
    }));

    const items = result.Items || [];

    if (items.length > 0) {
      const chunks = chunkArray(items, 25);
      for (const chunk of chunks) {
        try {
          await dynamodb.send(new BatchWriteCommand({
            RequestItems: {
              [tableName]: chunk.map(item => ({
                DeleteRequest: { Key: keyMapper(item) }
              }))
            }
          }));
          deletedCount += chunk.length;
        } catch (err) {
          console.error(`[delisting-phase3] BatchWrite failed for ${logLabel} (chunk of ${chunk.length}): ${err.message}`);
          // Continue with remaining chunks rather than failing entirely
        }
      }
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  console.log(`[delisting-phase3] Deleted ${deletedCount} ${logLabel}`);
  return deletedCount;
}

/**
 * Remove a symbol from all users' favorites lists.
 * Uses Scan + individual UpdateCommand (not batch delete).
 *
 * @param {string} symbol
 * @returns {number} Number of favorites records updated
 */
async function cleanFavorites(symbol) {
  let updatedCount = 0;
  let lastKey = undefined;

  do {
    // FilterExpression 없이 전체 스캔 — 구/신 포맷 모두 처리하기 위함
    // 'groups'는 DynamoDB 예약어이므로 ExpressionAttributeNames 필수
    const result = await dynamodb.send(new ScanCommand({
      TableName: FAVORITES_TABLE,
      ProjectionExpression: 'user_id, symbols, #g',
      ExpressionAttributeNames: { '#g': 'groups' },
      ExclusiveStartKey: lastKey
    }));

    const items = result.Items || [];

    for (const item of items) {
      let needsUpdate = false;
      let groupsChanged = false;
      const updateExprs = [];
      const exprValues = { ':updated_at': new Date().toISOString() };

      // 신 포맷: groups 맵 처리
      if (item.groups && typeof item.groups === 'object') {
        const newGroups = {};
        for (const [groupName, groupSymbols] of Object.entries(item.groups)) {
          const arr = Array.isArray(groupSymbols) ? groupSymbols : [];
          if (arr.includes(symbol)) {
            newGroups[groupName] = arr.filter(s => s !== symbol);
            groupsChanged = true;
          } else {
            newGroups[groupName] = arr;
          }
        }
        if (groupsChanged) {
          updateExprs.push('#g = :groups');
          exprValues[':groups'] = newGroups;
          needsUpdate = true;
        }
      }

      // 구 포맷: symbols 배열 처리
      if (Array.isArray(item.symbols) && item.symbols.includes(symbol)) {
        updateExprs.push('symbols = :symbols');
        exprValues[':symbols'] = item.symbols.filter(s => s !== symbol);
        needsUpdate = true;
      }

      if (needsUpdate) {
        updateExprs.push('updated_at = :updated_at');
        const params = {
          TableName: FAVORITES_TABLE,
          Key: { user_id: item.user_id },
          UpdateExpression: 'SET ' + updateExprs.join(', '),
          ExpressionAttributeValues: exprValues
        };
        // #g alias는 groups 변경 시에만 필요
        if (groupsChanged) {
          params.ExpressionAttributeNames = { '#g': 'groups' };
        }
        try {
          await dynamodb.send(new UpdateCommand(params));
          updatedCount++;
        } catch (err) {
          console.error(`[delisting-phase3] Favorites update failed for user ${item.user_id}: ${err.message}`);
        }
      }
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  console.log(`[delisting-phase3] Updated ${updatedCount} favorites (removed ${symbol})`);
  return updatedCount;
}

/**
 * Split an array into chunks of the given size.
 */
function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// ============================================================
// Sub-steps
// ============================================================

/**
 * Step 3A: Valkey cache cleanup.
 *
 * Deletes all cached keys associated with the symbol.
 * Uses a pipeline for efficiency (single round-trip).
 * Non-fatal: all Valkey operations are best-effort.
 */
async function step3A_cleanValkey(symbol) {
  console.log(`[delisting-phase3][3A] Starting Valkey cleanup for ${symbol}`);

  // ★ 4-Cache는 포트가 다른 별개 인스턴스다. 과거엔 getValkey()(type 누락 → depth로
  // 폴백) 하나에 전 키를 지워, candle(6380)·backup(6381)·operating(6382)의 키가 전부
  // 잔존했다. 결과: 폐지 종목이 랭킹 API에 계속 노출되고, RDS 행 삭제 후 차트 폴백이
  // Valkey를 읽어 1분봉이 되살아나며, 스트리머가 구독 목록에 남은 심볼을 영원히 폴링했다.
  // 삭제 카운트는 0으로 찍히지만 non-fatal이라 성공으로 보고됐다.
  const depthKeys = [
    `ticker:${symbol}`,
    `depth:${symbol}`,
    `ohlc:${symbol}`,
    `prev:${symbol}`,
  ];
  const candleKeys = [
    `candle:closed:1m:${symbol}`,
    ...TIMEFRAMES.map(tf => `candle:${tf}:${symbol}`),
  ];
  const operatingKeys = [
    `symbol:${symbol}:listingPrice`,
    `symbol:${symbol}:main`,
    `symbol:${symbol}:sub`,
    `symbol:${symbol}:subscribers`,
    `symbol:${symbol}:state`,        // VI halt 상태(엔진이 기록)
    `mm:config:${symbol}`,
    `mm:price:${symbol}`,
    `mm:orderCount:${symbol}`,
    `mm:started_at:${symbol}`,
    `mm:inventory:${symbol}`,        // MM 재고(백엔드가 기록)
    `mm:cpmm:${symbol}`,             // CPMM 백스톱 예산 상태
  ];

  // 캐시별 (클라이언트, 키목록, 멤버제거 작업) — 각각 독립 파이프라인으로 실행
  const plans = [
    {
      name: 'depth',
      client: getValkeyClient({ type: 'depth', preset: 'admin' }),
      keys: depthKeys,
      members: [],
    },
    {
      name: 'candle',
      client: getValkeyClient({ type: 'candle', preset: 'admin' }),
      keys: candleKeys,
      members: [],
    },
    {
      name: 'backup',
      client: getValkeyClient({ type: 'backup', preset: 'admin' }),
      keys: [`snapshot:${symbol}`],
      members: ['gainers', 'losers', 'marketcap', 'volume']
        .map(r => ({ op: 'zrem', key: `ranking:${r}` })),
    },
    {
      name: 'operating',
      client: getValkeyClient({ type: 'operating', preset: 'admin' }),
      keys: operatingKeys,
      members: [
        { op: 'srem', key: 'mm:running:symbols' },
        // Defense-in-depth: streamer가 다시 넣었을 수 있어 재삭제
        { op: 'srem', key: 'active:symbols' },
        { op: 'srem', key: 'subscribed:symbols' },
      ],
    },
  ];

  let deletedKeys = 0;
  let removedMembers = 0;
  const errors = [];

  for (const plan of plans) {
    try {
      const pipeline = plan.client.pipeline();
      plan.keys.forEach(k => pipeline.del(k));
      plan.members.forEach(m => pipeline[m.op](m.key, symbol));
      const results = await pipeline.exec();
      if (results) {
        for (let i = 0; i < plan.keys.length; i++) {
          if (results[i] && results[i][1] > 0) deletedKeys++;
        }
        for (let i = plan.keys.length; i < results.length; i++) {
          if (results[i] && results[i][1] > 0) removedMembers++;
        }
      }
    } catch (err) {
      // 캐시 하나가 실패해도 나머지는 정리한다(부분 잔존이 전면 잔존보다 낫다).
      console.warn(`[delisting-phase3][3A] ${plan.name} cache cleanup failed: ${err.message}`);
      errors.push(`${plan.name}: ${err.message}`);
    }
  }

  console.log(`[delisting-phase3][3A] Valkey cleanup done: ${deletedKeys} keys deleted, ` +
              `${removedMembers} set/zset members removed` +
              (errors.length ? ` (errors: ${errors.join('; ')})` : ''));
  return errors.length
    ? { deletedKeys, removedMembers, error: errors.join('; ') }
    : { deletedKeys, removedMembers };
}

/**
 * Step 3B: RDS PostgreSQL data deletion.
 *
 * Deletes all trade/candle/config data for the symbol within a transaction.
 * Drops the symbol-specific partition table outside the transaction.
 *
 * CRITICAL: uses parameterized queries ($1) for all WHERE clauses.
 * DROP TABLE uses validated symbol name (alphanumeric only).
 */
async function step3B_cleanRDS(symbol) {
  console.log(`[delisting-phase3][3B] Starting RDS cleanup for ${symbol}`);

  const db = await getPg();
  const deleteCounts = {};
  // RDS stores symbols in lowercase (aggregator convention)
  const symLower = symbol.toLowerCase();

  // --- Transactional deletes ---
  try {
    await db.query('BEGIN');

    const tables = [
      'market_maker_configs',
      'trade_history',
      'candle_history',
      'symbol_prev_close'
    ];

    for (const table of tables) {
      try {
        await db.query(`SAVEPOINT sp_${table}`);
        const result = await db.query(`DELETE FROM ${table} WHERE symbol = $1`, [symLower]);
        deleteCounts[table] = result.rowCount || 0;
        await db.query(`RELEASE SAVEPOINT sp_${table}`);
        console.log(`[delisting-phase3][3B] DELETE FROM ${table}: ${deleteCounts[table]} rows`);
      } catch (delErr) {
        await db.query(`ROLLBACK TO SAVEPOINT sp_${table}`);
        if (delErr.code === '42P01') {
          console.warn(`[delisting-phase3][3B] Table ${table} does not exist, skipping`);
          deleteCounts[table] = -1;
        } else {
          throw delErr;
        }
      }
    }

    await db.query('COMMIT');
    console.log(`[delisting-phase3][3B] Transaction committed successfully`);

  } catch (err) {
    console.error(`[delisting-phase3][3B] RDS transaction failed, rolling back: ${err.message}`);
    try { await db.query('ROLLBACK'); } catch (rbErr) {
      console.error(`[delisting-phase3][3B] ROLLBACK also failed: ${rbErr.message}`);
    }
    throw err; // Let Step Functions retry
  }

  // --- Partition table drop (outside transaction) ---
  // Symbol must be validated to prevent SQL injection in dynamic identifier
  if (!SYMBOL_PATTERN.test(symbol)) {
    console.warn(`[delisting-phase3][3B] Skipping partition drop: symbol "${symbol}" contains invalid characters`);
  } else {
    try {
      await db.query(`DROP TABLE IF EXISTS candle_history_${symLower}`);
      console.log(`[delisting-phase3][3B] Dropped partition table candle_history_${symLower}`);
    } catch (err) {
      // Non-fatal: partition table may not exist (project uses non-partitioned table)
      console.warn(`[delisting-phase3][3B] Partition drop failed (non-fatal): ${err.message}`);
    }
  }

  return deleteCounts;
}

/**
 * Step 3C: DynamoDB symbols metadata deletion.
 *
 * Removes the symbol record from supernoba-symbols.
 * IPO orders are intentionally NOT deleted (per requirements).
 */
async function step3C_deleteSymbol(symbol) {
  console.log(`[delisting-phase3][3C] Deleting symbol metadata for ${symbol}`);

  try {
    await dynamodb.send(new DeleteCommand({
      TableName: SYMBOLS_TABLE,
      Key: { symbol }
    }));
    console.log(`[delisting-phase3][3C] Deleted ${symbol} from ${SYMBOLS_TABLE}`);
    return true;
  } catch (err) {
    console.error(`[delisting-phase3][3C] CRITICAL: Failed to delete symbol ${symbol}: ${err.message}`);
    throw err; // Step Functions retry
  }
}

/**
 * Step 3D: DynamoDB user data cleanup.
 *
 * Scans and deletes all user-specific data for the symbol:
 *   - holdings (PK=user_id, SK=symbol)
 *   - orders (PK=user_id, SK=order_id, filtered by symbol attribute)
 *   - favorites (PK=user_id, symbols array -- removes symbol from list)
 *
 * Best-effort: logs errors but does not throw.
 * Can take significant time for symbols with many users.
 */
async function step3D_cleanUserData(symbol) {
  console.log(`[delisting-phase3][3D] Starting user data cleanup for ${symbol}`);

  const counts = {
    holdings_deleted: 0,
    orders_deleted: 0,
    favorites_updated: 0
  };

  // --- Holdings: Scan by symbol attribute, delete matching items ---
  try {
    counts.holdings_deleted = await scanAndDelete(
      HOLDINGS_TABLE,
      'symbol = :symbol',
      { ':symbol': symbol },
      item => ({ user_id: item.user_id, symbol: item.symbol }),
      `holdings for ${symbol}`
    );
  } catch (err) {
    console.error(`[delisting-phase3][3D] Holdings cleanup failed: ${err.message}`);
  }

  // --- Orders: Scan by symbol attribute, delete matching items ---
  try {
    counts.orders_deleted = await scanAndDelete(
      ORDERS_TABLE,
      'symbol = :symbol',
      { ':symbol': symbol },
      item => ({ user_id: item.user_id, order_id: item.order_id }),
      `orders for ${symbol}`
    );
  } catch (err) {
    console.error(`[delisting-phase3][3D] Orders cleanup failed: ${err.message}`);
  }

  // --- Favorites: Remove symbol from each user's symbols array ---
  try {
    counts.favorites_updated = await cleanFavorites(symbol);
  } catch (err) {
    console.error(`[delisting-phase3][3D] Favorites cleanup failed: ${err.message}`);
  }

  console.log(`[delisting-phase3][3D] User data cleanup done:`, counts);
  return counts;
}

// ============================================================
// Main Handler
// ============================================================

export const handler = async (event) => {
  const { job_id, symbol, phase: inputPhase } = event;

  // --- Input validation ---
  if (!job_id || !symbol) {
    throw new Error(`[delisting-phase3] Missing required fields: job_id=${job_id}, symbol=${symbol}`);
  }

  const sym = symbol.toUpperCase().trim();
  console.log(`[delisting-phase3] Starting Phase 3 (DATA_CLEANUP) for symbol=${sym}, job_id=${job_id}, input_phase=${inputPhase}`);

  // Validate symbol characters for SQL safety
  if (!SYMBOL_PATTERN.test(sym)) {
    throw new Error(`[delisting-phase3] Invalid symbol format: "${sym}". Only A-Z, 0-9, _ are allowed.`);
  }

  const startTime = Date.now();
  const warnings = [];

  // ==========================================
  // Step 3A: Valkey cache cleanup
  // ==========================================
  let valkeyResult;
  try {
    valkeyResult = await step3A_cleanValkey(sym);
    if (valkeyResult.error) {
      warnings.push(`Valkey cleanup partial failure: ${valkeyResult.error}`);
    }
  } catch (err) {
    valkeyResult = { deletedKeys: 0, removedMembers: 0, error: err.message };
    warnings.push(`Valkey cleanup failed: ${err.message}`);
  }
  await updateJobPhase(job_id, 'VALKEY_CLEANED');
  await publishAdminEvent('delist_progress', {
    job_id, symbol: sym, phase: 'VALKEY_CLEANED', status: 'IN_PROGRESS',
    phases_completed: ['ORDER_BLOCKED', 'ENGINE_CLEANED', 'VALKEY_CLEANED']
  });

  // ==========================================
  // Step 3B: RDS data deletion
  // ==========================================
  let rdsResult;
  try {
    rdsResult = await step3B_cleanRDS(sym);
  } catch (err) {
    console.error(`[delisting-phase3] Step 3B (RDS) failed critically: ${err.message}`);
    // Update job phase to indicate failure point
    await updateJobPhase(job_id, 'RDS_CLEANUP_FAILED');
    throw err; // Step Functions retry
  }
  await updateJobPhase(job_id, 'RDS_CLEANED');
  await publishAdminEvent('delist_progress', {
    job_id, symbol: sym, phase: 'RDS_CLEANED', status: 'IN_PROGRESS',
    phases_completed: ['ORDER_BLOCKED', 'ENGINE_CLEANED', 'VALKEY_CLEANED', 'RDS_CLEANED']
  });

  // ==========================================
  // Step 3C: DynamoDB symbol metadata deletion
  // ==========================================
  try {
    await step3C_deleteSymbol(sym);
  } catch (err) {
    console.error(`[delisting-phase3] Step 3C (Symbol delete) failed critically: ${err.message}`);
    await updateJobPhase(job_id, 'SYMBOL_DELETE_FAILED');
    throw err; // Step Functions retry
  }
  await updateJobPhase(job_id, 'SYMBOL_DELETED');
  await publishAdminEvent('delist_progress', {
    job_id, symbol: sym, phase: 'SYMBOL_DELETED', status: 'IN_PROGRESS',
    phases_completed: ['ORDER_BLOCKED', 'ENGINE_CLEANED', 'VALKEY_CLEANED', 'RDS_CLEANED', 'SYMBOL_DELETED']
  });

  // ==========================================
  // Step 3D: User data cleanup (best-effort)
  // ==========================================
  let userDataResult;
  try {
    userDataResult = await step3D_cleanUserData(sym);
  } catch (err) {
    console.error(`[delisting-phase3] Step 3D (User data) failed: ${err.message}`);
    warnings.push(`User data cleanup failed: ${err.message}`);
    userDataResult = { holdings_deleted: 0, orders_deleted: 0, favorites_updated: 0 };
  }
  await updateJobPhase(job_id, 'USER_DATA_CLEANED');
  await publishAdminEvent('delist_progress', {
    job_id, symbol: sym, phase: 'USER_DATA_CLEANED', status: 'IN_PROGRESS',
    phases_completed: ['ORDER_BLOCKED', 'ENGINE_CLEANED', 'VALKEY_CLEANED', 'RDS_CLEANED', 'SYMBOL_DELETED', 'USER_DATA_CLEANED']
  });

  // ==========================================
  // Final result
  // ==========================================
  const elapsed = Date.now() - startTime;

  const result = {
    success: true,
    job_id,
    symbol: sym,
    phase: 'USER_DATA_CLEANED',
    valkey: valkeyResult,
    rds: rdsResult,
    holdings_deleted: userDataResult.holdings_deleted,
    orders_deleted: userDataResult.orders_deleted,
    favorites_updated: userDataResult.favorites_updated,
    elapsed_ms: elapsed
  };

  if (warnings.length > 0) {
    result.warnings = warnings;
    console.warn(`[delisting-phase3] Completed with ${warnings.length} warning(s):`, warnings);
  }

  console.log(`[delisting-phase3] Phase 3 completed for ${sym} in ${elapsed}ms`, JSON.stringify(result));
  return result;
};
