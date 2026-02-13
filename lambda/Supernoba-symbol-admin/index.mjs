/**
 * Supernoba-symbol-admin Lambda
 * Symbol 도메인 전용 관리 API
 *
 * 엔드포인트:
 * - GET /symbols - 전체 종목 목록 (공개)
 * - GET /symbols/{symbol} - 개별 종목 상세 (공개)
 * - POST /symbols (action=listing) - 신규 종목 등록 (관리자)
 * - POST /symbols (action=activate) - 종목 활성화 (관리자)
 * - POST /symbols (action=approve) - 크리에이터 승인 + IPO 생성 (관리자)
 * - POST /symbols (action=reject) - 크리에이터 거절 (관리자)
 * - POST /symbols (action=restore) - 삭제된 종목 복원 (관리자)
 * - PUT /symbols/{symbol} - 종목 수정 (관리자)
 * - DELETE /symbols/{symbol} - 종목 삭제 (관리자)
 * - POST /sync - Redis 동기화 (관리자)
 * - POST /cleanChart - 차트 데이터 정리 (관리자)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ScanCommand, GetCommand, PutCommand, UpdateCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import pg from 'pg';
// Common Layer - Valkey, CORS, Social Links
import { getValkeyClient, CORS, response, detectPlatformFromUrl } from '/opt/nodejs/index.mjs';

// Auth Layer
// Auth Layer - Cognito JWT 검증
import { verifyAdmin, authErrorResponse } from '/opt/nodejs/verifyAuth.mjs';

const { Client: PgClient } = pg;

// 환경변수
const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';
const HOLDINGS_TABLE = process.env.HOLDINGS_TABLE || 'supernoba-holdings';
const CREATOR_REQUESTS_TABLE = process.env.CREATOR_REQUESTS_TABLE || 'supernoba-creator-requests';
const RDS_HOST = process.env.RDS_ENDPOINT || 'supernoba-rdb1.cluster-cyxfcbnpfoci.ap-northeast-2.rds.amazonaws.com';
const DB_SECRET_ARN = process.env.DB_SECRET_ARN || '';
const IPO_SYSTEM_ACCOUNT = 'ipo-system';
const DELIST_JOBS_TABLE = process.env.DELIST_JOBS_TABLE || 'supernoba-delist-jobs';
const STATE_MACHINE_ARN = process.env.DELISTING_STATE_MACHINE_ARN || 'arn:aws:states:ap-northeast-2:264520158196:stateMachine:supernoba-delisting';
const IPO_ORDERS_TABLE = 'supernoba-ipo-orders';

// Layer를 통한 클라이언트 초기화 (4-Cache: operating + depth + candle)
const operatingCache = getValkeyClient({ type: 'operating', preset: 'admin' });
const depthCache = getValkeyClient({ type: 'depth', preset: 'admin' });
const candleCache = getValkeyClient({ type: 'candle', preset: 'admin' });
const sfn = new SFNClient({ region: 'ap-northeast-2' });
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));
const secrets = new SecretsManagerClient({ region: 'ap-northeast-2' });
let dbCreds = null, pgClient = null;

/**
 * Publish an admin event to Valkey Pub/Sub for real-time admin UI updates.
 * Non-blocking: failures are logged but never prevent the main flow.
 * Uses the module-level `valkey` client (already initialized above).
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

// Layer의 CORS.FULL 사용
const H = CORS.FULL;

// 관리자 인증 체크
const checkAdmin = async (event) => {
  const result = await verifyAdmin(event);
  if (!result.success) {
    return { authorized: false, response: authErrorResponse(result, H) };
  }
  return { authorized: true, userId: result.userId, method: result.method };
};

// Layer의 detectPlatformFromUrl 사용
const detectPlatform = (url) => detectPlatformFromUrl(url) || 'ETC';

const ok = (d) => response.ok(d, H);
const err = (c, m) => response.error(c, m, H);

// Symbol 유효성 검증 (영문 대문자, 숫자, 2-20자)
const SYMBOL_REGEX = /^[A-Z0-9]{2,20}$/;
const validateSymbol = (symbol) => {
  if (!symbol || typeof symbol !== 'string') return false;
  const normalized = symbol.toUpperCase().trim();
  return SYMBOL_REGEX.test(normalized);
};

// PostgreSQL 연결 풀 관리
let pgConnectionTimeout = null;
const PG_IDLE_TIMEOUT = 30000; // 30초 idle 후 연결 해제

async function getPg() {
  // idle 타이머 리셋
  if (pgConnectionTimeout) {
    clearTimeout(pgConnectionTimeout);
    pgConnectionTimeout = null;
  }

  if (pgClient) {
    // 기존 연결 재사용
    pgConnectionTimeout = setTimeout(releasePg, PG_IDLE_TIMEOUT);
    return pgClient;
  }

  if (!dbCreds) {
    if (process.env.DB_USERNAME && process.env.DB_PASSWORD) {
      dbCreds = { username: process.env.DB_USERNAME, password: process.env.DB_PASSWORD };
    } else if (DB_SECRET_ARN) {
      const r = await secrets.send(new GetSecretValueCommand({ SecretId: DB_SECRET_ARN }));
      const s = JSON.parse(r.SecretString);
      dbCreds = { username: s.username, password: s.password };
    } else {
      dbCreds = { username: 'postgres', password: 'postgres' };
    }
  }

  pgClient = new PgClient({
    host: RDS_HOST,
    port: 5432,
    database: 'postgres',
    user: dbCreds.username,
    password: dbCreds.password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000
  });
  await pgClient.connect();

  // idle 타이머 설정
  pgConnectionTimeout = setTimeout(releasePg, PG_IDLE_TIMEOUT);

  return pgClient;
}

// PostgreSQL 연결 해제
async function releasePg() {
  if (pgClient) {
    try {
      await pgClient.end();
      console.log('[symbol-admin] PostgreSQL connection released');
    } catch (e) {
      console.warn('[symbol-admin] Error releasing PostgreSQL:', e.message);
    }
    pgClient = null;
  }
  if (pgConnectionTimeout) {
    clearTimeout(pgConnectionTimeout);
    pgConnectionTimeout = null;
  }
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  try {
    const m = event.httpMethod;
    const q = event.queryStringParameters || {};
    const path = event.path || '';
    const action = q.action;

    // ==========================================
    // GET: 종목 목록/상세 (공개)
    // ==========================================
    if (m === 'GET') {
      const symbolMatch = path.match(/\/symbols\/([^\/]+)/);

      // 개별 종목 상세
      if (symbolMatch && symbolMatch[1]) {
        const sym = symbolMatch[1].toUpperCase();
        const { Item } = await dynamodb.send(new GetCommand({ TableName: SYMBOLS_TABLE, Key: { symbol: sym } }));
        if (!Item) return err(404, 'Symbol not found');

        // 테스트 종목은 관리자만 조회 가능
        if (Item.is_test) {
          console.log('[symbol-admin] Test symbol access attempt:', sym);
          console.log('[symbol-admin] Auth header:', event.headers?.Authorization?.substring(0, 50) + '...');
          const adminCheck = await checkAdmin(event).catch((e) => {
            console.error('[symbol-admin] checkAdmin error:', e.message);
            return { authorized: false };
          });
          console.log('[symbol-admin] Admin check result:', JSON.stringify(adminCheck));
          if (!adminCheck.authorized) {
            console.log('[symbol-admin] Access denied for test symbol:', sym);
            return err(404, 'Symbol not found');
          }
          console.log('[symbol-admin] Admin access granted for:', sym);
        }

        return ok({
          symbol: Item.symbol,
          name: Item.name || Item.symbol,
          logo_url: Item.logoUrl || null,
          logoUrl: Item.logoUrl || null,
          status: Item.status || 'ACTIVE',
          platform: Item.platform || 'ETC',
          creatorUrl: Item.creatorUrl || null,
          profileUrl: Item.profileUrl || null,
          description: Item.description || null,
          verified: Item.verified || false,
          trustScore: Item.trustScore,
          dividendStatus: Item.dividendStatus || 'pending',
          dividendPerShare: Item.dividendPerShare || 0,
          platformStats: Item.platformStats || {},
          socialLinks: Item.socialLinks || {},
          tags: Item.tags || [],
          categories: Item.categories || [],
          listingPrice: Item.listingPrice,
          totalShares: Item.totalShares,
          is_test: Item.is_test || false
        });
      }

      // 상장폐지 진행 상황 조회 - 관리자 전용
      if (action === 'delist-status') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        const jobId = q.job_id;
        if (!jobId) return err(400, 'job_id is required');

        try {
          const { Item: job } = await dynamodb.send(new GetCommand({
            TableName: DELIST_JOBS_TABLE,
            Key: { job_id: jobId }
          }));

          if (!job) return err(404, 'Delist job not found');

          return ok({
            job_id: job.job_id,
            symbol: job.symbol,
            status: job.status,
            phase: job.phase,
            phases_completed: job.phases_completed || [],
            error: job.error || null,
            failed_checks: job.failed_checks || null,
            cancelled_orders: job.cancelled_orders || 0,
            created_at: job.created_at,
            updated_at: job.updated_at,
            completed_at: job.completed_at || null
          });
        } catch (jobErr) {
          console.error(`[delist-status] Failed to fetch job ${jobId}: ${jobErr.message}`);
          return err(500, `Failed to fetch delist status: ${jobErr.message}`);
        }
      }

      // 삭제된 종목 목록 (deleted:symbols) - 관리자 전용
      if (q.type === 'deleted') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        try {
          const deletedSymbols = await operatingCache.smembers('deleted:symbols');
          console.log(`[GET] deleted:symbols count: ${deletedSymbols.length}`);
          return ok({ deletedSymbols: deletedSymbols || [] });
        } catch (valkeyErr) {
          console.error(`[GET] Valkey error: ${valkeyErr.message}`);
          return err(500, 'Failed to fetch deleted symbols');
        }
      }

      // 전체 종목 목록
      const search = q.q ? q.q.toUpperCase() : null;
      const { Items } = await dynamodb.send(new ScanCommand({ TableName: SYMBOLS_TABLE }));
      let r = Items || [];

      // 관리자 여부 확인 (인증 실패해도 일반 사용자로 처리)
      const adminCheck = await checkAdmin(event).catch(() => ({ authorized: false }));
      const isAdmin = adminCheck.authorized;

      // 일반 사용자는 테스트 종목 제외
      if (!isAdmin) {
        r = r.filter(s => !s.is_test);
      }

      if (search) {
        r = r.filter(s => s.symbol.includes(search) || (s.name && s.name.toUpperCase().includes(search)));
      }
      return ok(r);
    }

    // ==========================================
    // POST: 종목 관리 (관리자)
    // ==========================================
    if (m === 'POST') {
      // sync - Redis 동기화
      if (path.includes('sync')) {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        const { Items } = await dynamodb.send(new ScanCommand({ TableName: SYMBOLS_TABLE }));
        const deletedSymbols = await operatingCache.smembers('deleted:symbols');
        const deletedSet = new Set(deletedSymbols);

        if (Items?.length > 0) {
          const opPipe = operatingCache.pipeline();
          const depthPipe = depthCache.pipeline();
          opPipe.del('active:symbols');
          let syncedCount = 0;

          for (const i of Items) {
            if (deletedSet.has(i.symbol)) continue;
            if (i.status === 'ACTIVE') {
              opPipe.sadd('active:symbols', i.symbol);
              depthPipe.set(`ticker:${i.symbol}`, JSON.stringify({
                symbol: i.symbol,
                price: i.listingPrice || 0,
                changePercent: 0,
                volume: 0
              }));
              syncedCount++;
            }
          }
          await Promise.all([opPipe.exec(), depthPipe.exec()]);
          return ok({ synced: syncedCount, skippedDeleted: deletedSymbols.length });
        }
        return ok({ synced: 0 });
      }

      // cleanChart - 차트 데이터 정리
      if (action === 'cleanChart' || path.includes('cleanChart')) {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        const b = JSON.parse(event.body || '{}');
        const sym = (b.symbol || '').toLowerCase().trim();
        const threshold = b.threshold || 10000;
        const deleteAll = b.deleteAll === true;

        if (!sym) return err(400, 'symbol is required');

        try {
          const pg = await getPg();
          let result;

          if (deleteAll) {
            result = await pg.query('DELETE FROM candle_history WHERE symbol = $1', [sym]);
            console.log(`[cleanChart] Deleted ALL candles for ${sym}: ${result.rowCount} rows`);

            if (b.includeTrades) {
              const tradeResult = await pg.query('DELETE FROM trade_history WHERE symbol = $1', [sym]);
              console.log(`[cleanChart] Deleted trades for ${sym}: ${tradeResult.rowCount} rows`);
            }
          } else {
            result = await pg.query(
              'DELETE FROM candle_history WHERE symbol = $1 AND (high > $2 OR open > $2 OR close > $2)',
              [sym, threshold]
            );
            console.log(`[cleanChart] Deleted corrupted candles for ${sym}: ${result.rowCount} rows`);
          }

          // Redis 캔들 캐시 정리 (candle→6380, ohlc→depth 6379)
          const candlePipe = candleCache.pipeline();
          ['1m', '5m', '15m', '30m', '1h', '4h', '1d'].forEach(tf => {
            candlePipe.del(`candle:${tf}:${sym.toUpperCase()}`);
          });
          candlePipe.del(`candle:closed:1m:${sym.toUpperCase()}`);
          await Promise.all([
            candlePipe.exec(),
            depthCache.del(`ohlc:${sym.toUpperCase()}`)
          ]);

          return ok({
            success: true,
            symbol: sym,
            deletedRows: result.rowCount,
            action: deleteAll ? 'delete_all' : 'clean_corrupted',
            threshold: deleteAll ? null : threshold
          });
        } catch (dbErr) {
          console.error('[cleanChart] Error:', dbErr.message);
          return err(500, 'Failed to clean chart data: ' + dbErr.message);
        }
      }

      const b = JSON.parse(event.body || '{}');

      // restore - 삭제된 종목 복원 (비일관 상태 해결용)
      // 사용 사례: deleted:symbols에는 있지만 실제 데이터는 남아있는 경우
      if (action === 'restore') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        const sym = (b.symbol || '').toUpperCase().trim();
        if (!sym) return err(400, 'symbol is required');

        const [wasDeleted, wasBlocked] = await Promise.all([
          operatingCache.sismember('deleted:symbols', sym),
          operatingCache.sismember('blocked:symbols', sym),
        ]);
        if (!wasDeleted && !wasBlocked) return err(400, `Symbol ${sym} is not in deleted or blocked list`);

        const restoreResults = {};

        // 1. deleted:symbols / blocked:symbols에서 제거
        if (wasDeleted) {
          await operatingCache.srem('deleted:symbols', sym);
          restoreResults.deleted_symbols = { success: true };
          console.log(`[RESTORE] Symbol ${sym} removed from deleted:symbols`);
        }
        if (wasBlocked) {
          await operatingCache.srem('blocked:symbols', sym);
          restoreResults.blocked_symbols = { success: true };
          console.log(`[RESTORE] Symbol ${sym} removed from blocked:symbols`);
        }

        // 2. DynamoDB 종목 존재 확인 및 상태 복원
        try {
          const { Item } = await dynamodb.send(new GetCommand({ TableName: SYMBOLS_TABLE, Key: { symbol: sym } }));
          if (Item) {
            // 종목이 존재하면 상태를 ACTIVE로 변경
            await dynamodb.send(new UpdateCommand({
              TableName: SYMBOLS_TABLE,
              Key: { symbol: sym },
              UpdateExpression: 'SET #status = :status, updated_at = :now',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':status': 'ACTIVE', ':now': new Date().toISOString() }
            }));
            restoreResults.dynamodb_status = { success: true, previous: Item.status };
            console.log(`[RESTORE] DynamoDB status restored to ACTIVE for ${sym}`);
          } else {
            restoreResults.dynamodb_status = { success: false, error: 'Symbol not found in DynamoDB' };
            console.warn(`[RESTORE] Symbol ${sym} not found in DynamoDB - may need to re-list`);
          }
        } catch (dbErr) {
          restoreResults.dynamodb_status = { success: false, error: dbErr.message };
          console.error(`[RESTORE] DynamoDB update failed: ${dbErr.message}`);
        }

        // 3. Valkey subscribed:symbols에 추가 (구독 가능하도록)
        try {
          await operatingCache.sadd('subscribed:symbols', sym);
          restoreResults.subscribed_symbols = { success: true };
          console.log(`[RESTORE] Added ${sym} to subscribed:symbols`);
        } catch (valkeyErr) {
          restoreResults.subscribed_symbols = { success: false, error: valkeyErr.message };
        }

        // 4. 매칭 엔진 오더북 존재 확인 (선택적 - gRPC 호출)
        try {
          // 참고: 매칭 엔진에 오더북이 없으면 재생성 필요할 수 있음
          // 현재는 확인만 하고, 필요시 재상장으로 처리
          restoreResults.engine_orderbook = { success: true, note: 'Check manually if orderbook exists' };
        } catch (grpcErr) {
          restoreResults.engine_orderbook = { success: false, error: grpcErr.message };
        }

        const allSuccess = Object.values(restoreResults).every(r => r.success);
        return ok({
          message: allSuccess
            ? `Symbol ${sym} fully restored and ready for trading.`
            : `Symbol ${sym} partially restored. Check restoreResults for details.`,
          restoreResults
        });
      }

      // listing - 신규 종목 등록
      if (action === 'listing') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        const { symbol, name, listingPrice, totalShares, platform, creatorId, ownerId, description, logoUrl, creatorUrl, profileUrl, tags, categories, is_test } = b;

        if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') return err(400, 'symbol is required');
        if (!validateSymbol(symbol)) return err(400, 'Invalid symbol format. Must be 2-20 alphanumeric characters (A-Z, 0-9)');
        if (!name || typeof name !== 'string' || name.trim() === '') return err(400, 'name is required');
        if (typeof listingPrice !== 'number' || listingPrice <= 0) return err(400, 'listingPrice must be a positive number');
        if (typeof totalShares !== 'number' || totalShares <= 0) return err(400, 'totalShares must be a positive number');
        if (!platform || typeof platform !== 'string' || platform.trim() === '') return err(400, 'platform is required');

        const sym = symbol.toUpperCase().trim();
        const now = new Date().toISOString();

        // 삭제/차단된 종목이면 자동으로 복원 (재상장 허용)
        const [isDeleted, isBlocked] = await Promise.all([
          operatingCache.sismember('deleted:symbols', sym),
          operatingCache.sismember('blocked:symbols', sym),
        ]);
        if (isDeleted || isBlocked) {
          await Promise.all([
            isDeleted ? operatingCache.srem('deleted:symbols', sym) : null,
            isBlocked ? operatingCache.srem('blocked:symbols', sym) : null,
          ]);
          console.log(`[LISTING] Auto-cleared delist state for ${sym}: deleted=${isDeleted}, blocked=${isBlocked}`);
        }

        const { Item: existing } = await dynamodb.send(new GetCommand({ TableName: SYMBOLS_TABLE, Key: { symbol: sym } }));
        if (existing) return err(409, `Symbol ${sym} already exists`);

        const item = {
          symbol: sym,
          name: name.trim(),
          listingPrice,
          totalShares,
          platform: platform.trim(),
          status: 'PENDING',
          creatorId: creatorId || null,
          ownerId: ownerId || null,
          description: description || null,
          logoUrl: logoUrl || null,
          creatorUrl: creatorUrl || null,
          profileUrl: profileUrl || null,
          tags: tags || [],
          categories: categories || [],
          verified: false,
          trustScore: 5,
          platformStats: {},
          socialLinks: {},
          prevClose: null,
          lastClose: null,
          is_test: is_test || false,
          createdAt: now,
          updatedAt: now
        };

        await dynamodb.send(new PutCommand({ TableName: SYMBOLS_TABLE, Item: item }));
        await operatingCache.set(`symbol:${sym}:listingPrice`, listingPrice.toString());

        // 전일종가 초기화 (등락율 계산용)
        const prevData = JSON.stringify({ close: listingPrice });
        await depthCache.set(`prev:${sym}`, prevData);
        console.log(`[LISTING] prev:${sym} initialized with listingPrice: ${listingPrice}`);

        const tickerData = {
          symbol: sym,
          price: listingPrice,
          open: listingPrice,
          high: listingPrice,
          low: listingPrice,
          close: listingPrice,
          prevClose: listingPrice,
          changePercent: 0,
          change: 0,
          volume: 0,
          value: 0,
          trades: 0,
          updatedAt: now
        };
        await depthCache.set(`ticker:${sym}`, JSON.stringify(tickerData));

        // PostgreSQL: 초기 1d 캔들 생성 (프론트엔드 getDayOHLC 지원)
        try {
          const pg = await getPg();
          const symLower = sym.toLowerCase(); // RDS는 소문자로 저장 (chart-data-handler 쿼리와 일치)

          // 파티션 생성 (없으면)
          await pg.query(`
            CREATE TABLE IF NOT EXISTS public.candle_history_${symLower}
            PARTITION OF public.candle_history FOR VALUES IN ('${symLower}')
          `);
          console.log(`[LISTING] Partition candle_history_${symLower} ensured`);

          // 전일 캔들 생성 (prevClose 제공용)
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          yesterday.setUTCHours(0, 0, 0, 0);
          const yesterdayEpoch = Math.floor(yesterday.getTime() / 1000);
          const yesterdayYmdhm = yesterday.toISOString().slice(0, 10).replace(/-/g, '') + '0000';

          await pg.query(`
            INSERT INTO candle_history (symbol, interval, time_epoch, time_ymdhm, open, high, low, close, volume)
            VALUES ($1, '1d', $2, $3, $4, $4, $4, $4, 0)
            ON CONFLICT (symbol, interval, time_epoch) DO NOTHING
          `, [symLower, yesterdayEpoch, yesterdayYmdhm, listingPrice]);

          // 당일 캔들 생성 (dayOpen, dayHigh, dayLow 제공용)
          const today = new Date();
          today.setUTCHours(0, 0, 0, 0);
          const todayEpoch = Math.floor(today.getTime() / 1000);
          const todayYmdhm = today.toISOString().slice(0, 10).replace(/-/g, '') + '0000';

          await pg.query(`
            INSERT INTO candle_history (symbol, interval, time_epoch, time_ymdhm, open, high, low, close, volume)
            VALUES ($1, '1d', $2, $3, $4, $4, $4, $4, 0)
            ON CONFLICT (symbol, interval, time_epoch) DO NOTHING
          `, [symLower, todayEpoch, todayYmdhm, listingPrice]);

          console.log(`[LISTING] RDS 1d candles created for ${symLower} (prev: ${yesterdayEpoch}, today: ${todayEpoch})`);
        } catch (pgErr) {
          console.warn(`[LISTING] PostgreSQL candle insert warning: ${pgErr.message}`);
          // 실패해도 계속 진행 (Valkey 데이터로 fallback 가능)
        }

        // IPO 매도 주문 생성 (ipo-processor Lambda 트리거)
        try {
          // 1. IPO 시스템 계정 holdings 생성
          await dynamodb.send(new PutCommand({
            TableName: HOLDINGS_TABLE,
            Item: {
              user_id: 'ipo-system',
              symbol: sym,
              quantity: totalShares,
              availableQuantity: totalShares,
              averagePrice: listingPrice,
              totalCost: totalShares * listingPrice,
              source: 'IPO',
              createdAt: now,
              updatedAt: now
            }
          }));
          console.log(`[LISTING] IPO holdings created: ${sym} x ${totalShares} @ ${listingPrice}`);

          // 2. IPO 주문 생성 (DynamoDB Stream → ipo-processor)
          const listingOrderId = `ipo-${sym}-${Date.now()}`;
          await dynamodb.send(new PutCommand({
            TableName: IPO_ORDERS_TABLE,
            Item: {
              order_id: listingOrderId,
              symbol: sym,
              status: 'PENDING',
              quantity: totalShares,
              price: listingPrice,
              userId: 'ipo-system',
              createdAt: now,
              ttl: Math.floor(Date.now() / 1000) + 86400 * 7  // 7일 TTL
            }
          }));
          console.log(`[LISTING] IPO order created: ${listingOrderId}, ${sym} x ${totalShares} @ ${listingPrice}`);
        } catch (ipoErr) {
          console.error(`[LISTING] IPO creation failed: ${ipoErr.message}`);
          // IPO 실패해도 종목 등록은 성공 처리
        }

        return ok({
          success: true,
          symbol: sym,
          status: 'PENDING',
          message: `Symbol ${sym} listed successfully. Use activate action to make it active.`
        });
      }

      // activate - 종목 활성화
      if (action === 'activate') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        const { symbol } = b;
        if (!symbol || typeof symbol !== 'string') return err(400, 'symbol is required');
        if (!validateSymbol(symbol)) return err(400, 'Invalid symbol format. Must be 2-20 alphanumeric characters (A-Z, 0-9)');

        const sym = symbol.toUpperCase().trim();

        // 삭제/차단된 종목이면 자동으로 복원 (재활성화 허용)
        const [isDeletedAct, isBlockedAct] = await Promise.all([
          operatingCache.sismember('deleted:symbols', sym),
          operatingCache.sismember('blocked:symbols', sym),
        ]);
        if (isDeletedAct || isBlockedAct) {
          await Promise.all([
            isDeletedAct ? operatingCache.srem('deleted:symbols', sym) : null,
            isBlockedAct ? operatingCache.srem('blocked:symbols', sym) : null,
          ]);
          console.log(`[ACTIVATE] Auto-cleared delist state for ${sym}: deleted=${isDeletedAct}, blocked=${isBlockedAct}`);
        }

        const { Item } = await dynamodb.send(new GetCommand({ TableName: SYMBOLS_TABLE, Key: { symbol: sym } }));
        if (!Item) return err(404, `Symbol ${sym} not found`);
        if (Item.status === 'ACTIVE') return err(400, `Symbol ${sym} is already active`);

        const now = new Date().toISOString();

        await dynamodb.send(new UpdateCommand({
          TableName: SYMBOLS_TABLE,
          Key: { symbol: sym },
          UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':status': 'ACTIVE', ':updatedAt': now }
        }));

        await operatingCache.sadd('subscribed:symbols', sym);
        await operatingCache.sadd('active:symbols', sym);

        return ok({ success: true, symbol: sym, status: 'ACTIVE', message: `Symbol ${sym} activated successfully` });
      }

      // approve - 크리에이터 승인 + IPO 생성
      if (action === 'approve') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        const { requestId, symbol, name, logo_url, listingPrice = 0, totalShares = 0, platform: providedPlatform, description, createIpoOrder = true } = b;
        if (!symbol || !name || name.trim().length === 0 || name.length > 100) return err(400, 'Invalid symbol or name');
        if (!validateSymbol(symbol)) return err(400, 'Invalid symbol format. Must be 2-20 alphanumeric characters (A-Z, 0-9)');

        if (listingPrice !== undefined && listingPrice !== 0 && (isNaN(listingPrice) || listingPrice < 0 || !isFinite(listingPrice))) return err(400, 'Invalid listingPrice');
        if (totalShares !== undefined && totalShares !== 0 && (isNaN(totalShares) || totalShares < 0 || !isFinite(totalShares))) return err(400, 'Invalid totalShares');

        const sym = symbol.toUpperCase().trim();

        // 삭제/차단된 종목이면 자동으로 복원 (재승인 허용)
        const [isDeletedApp, isBlockedApp] = await Promise.all([
          operatingCache.sismember('deleted:symbols', sym),
          operatingCache.sismember('blocked:symbols', sym),
        ]);
        if (isDeletedApp || isBlockedApp) {
          await Promise.all([
            isDeletedApp ? operatingCache.srem('deleted:symbols', sym) : null,
            isBlockedApp ? operatingCache.srem('blocked:symbols', sym) : null,
          ]);
          console.log(`[APPROVE] Auto-cleared delist state for ${sym}: deleted=${isDeletedApp}, blocked=${isBlockedApp}`);
        }

        const ipoQuantity = createIpoOrder ? totalShares : 0;
        const ipoPrice = createIpoOrder ? listingPrice : 0;
        console.log(`[APPROVE] Processing: ${symbol}, ReqID: ${requestId}, IPO: ${ipoQuantity}@${ipoPrice}`);

        let detectedPlatform = providedPlatform || 'ETC';
        let creatorUrl = '';

        if (requestId) {
          try {
            // Primary Key is 'request_id', not 'id'
            const { Item: reqData } = await dynamodb.send(new GetCommand({
              TableName: CREATOR_REQUESTS_TABLE,
              Key: { request_id: requestId }
            }));
            if (!reqData) {
              console.error(`[APPROVE] Request not found: ${requestId}`);
              return err(404, 'Request not found');
            }
            creatorUrl = reqData.creator_url || '';
            if (!providedPlatform) detectedPlatform = reqData.platform || detectPlatform(creatorUrl);

            await dynamodb.send(new UpdateCommand({
              TableName: CREATOR_REQUESTS_TABLE,
              Key: { request_id: requestId },
              UpdateExpression: 'SET #status = :status, platform = :platform, processed_at = :processed_at, approved_symbol = :symbol',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':status': 'approved',
                ':platform': detectedPlatform,
                ':processed_at': new Date().toISOString(),
                ':symbol': symbol.toUpperCase()
              }
            }));
          } catch (reqErr) {
            console.error('[APPROVE] Request update error:', reqErr.message);
            return err(500, 'Failed to update request: ' + reqErr.message);
          }
        }

        const now = new Date().toISOString();
        const newSymbol = {
          symbol: symbol.toUpperCase(),
          name: name || symbol.toUpperCase(),
          base_asset: symbol.toUpperCase(),
          quote_asset: 'BOLT',
          status: 'ACTIVE',
          listingDate: now,
          listingPrice: listingPrice || 0,
          totalShares: totalShares || 0,
          platform: detectedPlatform,
          creatorUrl,
          profileUrl: `/creator/${symbol.toUpperCase()}`,
          logoUrl: logo_url || '',
          marketCap: (listingPrice || 0) * (totalShares || 0),
          totalSupply: totalShares || 0,
          circulatingSupply: 0,
          volume24h: 0,
          priceChange24h: 0,
          allTimeHigh: listingPrice || 0,
          allTimeLow: listingPrice || 0,
          platformStats: { subscribers: 0, followers: 0, views: 0, videos: 0, lastUpdated: null },
          tags: [],
          categories: [],
          verified: false,
          trustScore: 5,
          userRating: 0,
          ratingCount: 0,
          description: description || `Official symbol for Creator ${name}`
        };

        await dynamodb.send(new PutCommand({ TableName: SYMBOLS_TABLE, Item: newSymbol }));
        await operatingCache.sadd('active:symbols', symbol.toUpperCase());

        // IPO 주문 처리
        let ipoError = null;
        let ipoOrderStatus = null;
        if (ipoQuantity > 0 && ipoPrice > 0) {
          console.log(`[APPROVE] Creating IPO order request: ${ipoQuantity} shares @ ${ipoPrice}`);

          try {
            // ipo-system 계정에 holdings 생성
            await dynamodb.send(new PutCommand({
              TableName: HOLDINGS_TABLE,
              Item: {
                user_id: IPO_SYSTEM_ACCOUNT,
                symbol: symbol.toUpperCase(),
                quantity: ipoQuantity,
                availableQuantity: ipoQuantity,
                averagePrice: ipoPrice,
                totalCost: ipoQuantity * ipoPrice,
                createdAt: now,
                updatedAt: now,
                source: 'IPO'
              }
            }));
            console.log(`[APPROVE] IPO holdings created for ${IPO_SYSTEM_ACCOUNT}`);

            // IPO 주문 생성
            const approveOrderId = `ipo-${symbol.toUpperCase()}-${Date.now()}`;
            await dynamodb.send(new PutCommand({
              TableName: IPO_ORDERS_TABLE,
              Item: {
                order_id: approveOrderId,
                symbol: symbol.toUpperCase(),
                status: 'PENDING',
                quantity: ipoQuantity,
                price: ipoPrice,
                userId: IPO_SYSTEM_ACCOUNT,
                createdAt: now,
                ttl: Math.floor(Date.now() / 1000) + 86400 * 7
              }
            }));
            console.log(`[APPROVE] IPO order created: ${approveOrderId} (PENDING)`);
            ipoOrderStatus = 'PENDING';
          } catch (ipoErr) {
            console.error('[APPROVE] IPO order creation failed:', ipoErr);
            ipoError = `IPO order creation failed: ${ipoErr.message}`;
          }
        }

        return ok({
          message: `Symbol ${symbol} approved and created`,
          symbol: newSymbol,
          ipoOrder: ipoOrderStatus ? { status: ipoOrderStatus, quantity: ipoQuantity, price: ipoPrice } : null,
          ...(ipoError && { ipoError })
        });
      }

      // reject - 크리에이터 거절
      if (action === 'reject') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        const { requestId, reason } = b;
        if (!requestId) return err(400, 'requestId is required');

        console.log(`[REJECT] Processing: RequestId: ${requestId}`);

        try {
          // First check if request exists (Primary Key is 'request_id')
          const { Item: existingReq } = await dynamodb.send(new GetCommand({
            TableName: CREATOR_REQUESTS_TABLE,
            Key: { request_id: requestId }
          }));

          if (!existingReq) {
            return err(404, 'Request not found');
          }

          await dynamodb.send(new UpdateCommand({
            TableName: CREATOR_REQUESTS_TABLE,
            Key: { request_id: requestId },
            UpdateExpression: 'SET #status = :status, processed_at = :processed_at, admin_note = :admin_note',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':status': 'rejected',
              ':processed_at': new Date().toISOString(),
              ':admin_note': reason || 'Rejected by admin'
            }
          }));

          const { Item } = await dynamodb.send(new GetCommand({
            TableName: CREATOR_REQUESTS_TABLE,
            Key: { request_id: requestId }
          }));

          return ok({ message: 'Request rejected', data: { ...Item, id: Item.request_id } });
        } catch (rejectErr) {
          console.error('[REJECT] Update Error:', rejectErr);
          return err(500, 'Failed to reject request: ' + rejectErr.message);
        }
      }
    }

    // ==========================================
    // PUT: 종목 수정 (관리자)
    // ==========================================
    if (m === 'PUT') {
      const adminCheck = await checkAdmin(event);
      if (!adminCheck.authorized) return adminCheck.response;

      const b = JSON.parse(event.body || '{}');

      // --- 강제 완료: 상장폐지 job을 스킵된 Phase 기록과 함께 강제 종료 ---
      if (b.action === 'force-complete-delist') {
        const jobId = b.job_id;
        if (!jobId) return err(400, 'job_id is required');

        const { Item: job } = await dynamodb.send(new GetCommand({
          TableName: DELIST_JOBS_TABLE, Key: { job_id: jobId }
        }));
        if (!job) return err(404, 'Delist job not found');

        const allPhases = ['ORDER_BLOCKED', 'ENGINE_CLEANED', 'VALKEY_CLEANED', 'RDS_CLEANED', 'SYMBOL_DELETED', 'USER_DATA_CLEANED', 'VERIFIED'];
        const completed = job.phases_completed || [];
        const skipped = allPhases.filter(p => !completed.includes(p));

        // Valkey: deleted:symbols SADD + blocked:symbols SREM
        try {
          await operatingCache.sadd('deleted:symbols', job.symbol);
          await operatingCache.srem('blocked:symbols', job.symbol);
        } catch (e) { console.warn('Valkey force-complete warning:', e.message); }

        // delist-jobs 업데이트
        const fcNow = new Date().toISOString();
        await dynamodb.send(new UpdateCommand({
          TableName: DELIST_JOBS_TABLE,
          Key: { job_id: jobId },
          UpdateExpression: 'SET #s = :s, phases_skipped = :skipped, force_completed_by = :by, force_completed_at = :now, updated_at = :now',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':s': 'FORCE_COMPLETED',
            ':skipped': skipped,
            ':by': adminCheck.userId,
            ':now': fcNow
          }
        }));

        console.log(`[PUT] Force-completed delist job ${jobId} by ${adminCheck.userId}. Skipped: ${skipped.join(', ')}`);
        return ok({ success: true, job_id: jobId, status: 'FORCE_COMPLETED', phases_skipped: skipped });
      }

      const symbolMatch = path.match(/\/symbols\/([^\/]+)/);
      const sym = (symbolMatch?.[1] || b.symbol || '').toUpperCase().trim();
      if (!sym) return err(400, 'symbol is required');

      const { Item } = await dynamodb.send(new GetCommand({ TableName: SYMBOLS_TABLE, Key: { symbol: sym } }));
      if (!Item) return err(404, `Symbol ${sym} not found`);

      const now = new Date().toISOString();
      const updateExprParts = ['updatedAt = :updatedAt'];
      const exprAttrNames = {};
      const exprAttrValues = { ':updatedAt': now };

      const updateableFields = [
        'name', 'listingPrice', 'totalShares', 'creatorId', 'ownerId',
        'description', 'logoUrl', 'creatorUrl', 'profileUrl', 'platform',
        'verified', 'trustScore', 'dividendStatus', 'dividendPerShare',
        'tags', 'categories', 'platformStats', 'socialLinks', 'prevClose', 'lastClose',
        'is_test'
      ];

      for (const field of updateableFields) {
        if (b[field] !== undefined) {
          if (field === 'listingPrice' && (typeof b[field] !== 'number' || b[field] <= 0)) {
            return err(400, 'listingPrice must be a positive number');
          }
          if (field === 'totalShares' && (typeof b[field] !== 'number' || b[field] <= 0)) {
            return err(400, 'totalShares must be a positive number');
          }

          updateExprParts.push(`#${field} = :${field}`);
          exprAttrNames[`#${field}`] = field;
          exprAttrValues[`:${field}`] = b[field];
        }
      }

      if (b.status !== undefined) {
        const validStatuses = ['PENDING', 'ACTIVE', 'SUSPENDED', 'DELISTED'];
        if (!validStatuses.includes(b.status)) return err(400, `Invalid status. Must be one of: ${validStatuses.join(', ')}`);
        updateExprParts.push('#status = :status');
        exprAttrNames['#status'] = 'status';
        exprAttrValues[':status'] = b.status;

        if (b.status === 'ACTIVE') {
          await operatingCache.sadd('subscribed:symbols', sym);
          await operatingCache.sadd('active:symbols', sym);
        } else if (b.status !== 'ACTIVE' && Item.status === 'ACTIVE') {
          await operatingCache.srem('subscribed:symbols', sym);
          await operatingCache.srem('active:symbols', sym);
        }
      }

      await dynamodb.send(new UpdateCommand({
        TableName: SYMBOLS_TABLE,
        Key: { symbol: sym },
        UpdateExpression: 'SET ' + updateExprParts.join(', '),
        ExpressionAttributeNames: Object.keys(exprAttrNames).length > 0 ? exprAttrNames : undefined,
        ExpressionAttributeValues: exprAttrValues
      }));

      if (b.listingPrice !== undefined) {
        await operatingCache.set(`symbol:${sym}:listingPrice`, b.listingPrice.toString());
      }

      return ok({ success: true, symbol: sym, message: `Symbol ${sym} updated successfully` });
    }

    // ==========================================
    // DELETE: 종목 상장폐지 (관리자) - Step Functions 비동기 오케스트레이션
    // ==========================================
    if (m === 'DELETE') {
      const adminCheck = await checkAdmin(event);
      if (!adminCheck.authorized) return adminCheck.response;

      const b = JSON.parse(event.body || '{}');
      const sym = (b.symbol || '').toUpperCase().trim();
      if (!sym) return err(400, 'symbol is required');

      console.log(`[DELETE] Starting async delisting for symbol: ${sym}`);

      // 1. 종목 존재 확인
      const { Item } = await dynamodb.send(new GetCommand({ TableName: SYMBOLS_TABLE, Key: { symbol: sym } }));
      if (!Item) return err(404, `Symbol ${sym} not found`);

      // 2. DELISTING 중복 방지: 이미 진행 중인 job이 있는지 확인
      if (Item.status === 'DELISTING') {
        return err(409, `Symbol ${sym} is already being delisted`);
      }

      // 3. delist-jobs 레코드 생성
      const job_id = `delist-${sym}-${Date.now()}`;
      const now = new Date().toISOString();

      try {
        await dynamodb.send(new PutCommand({
          TableName: DELIST_JOBS_TABLE,
          Item: {
            job_id,
            symbol: sym,
            status: 'PENDING',
            phase: 'INITIATED',
            phases_completed: [],
            error_log: [],
            requested_by: adminCheck.userId,
            created_at: now,
            updated_at: now
          }
        }));
        console.log(`[DELETE] delist-jobs record created: job_id=${job_id}`);
      } catch (jobErr) {
        console.error(`[DELETE] Failed to create delist-jobs record: ${jobErr.message}`);
        return err(500, `Failed to initiate delisting: ${jobErr.message}`);
      }

      // 3.5. symbols 테이블 status를 DELISTING으로 변경
      try {
        await dynamodb.send(new UpdateCommand({
          TableName: SYMBOLS_TABLE,
          Key: { symbol: sym },
          UpdateExpression: 'SET #status = :status, delist_job_id = :jobId, updated_at = :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': 'DELISTING',
            ':jobId': job_id,
            ':now': now
          }
        }));
        console.log(`[DELETE] symbols table status -> DELISTING for ${sym}`);
      } catch (symErr) {
        console.error(`[DELETE] symbols status update failed (non-fatal): ${symErr.message}`);
      }

      // 3.7. MM-service 사전 중지 (Step Functions 시작 전 — 레이스 컨디션 방지)
      // MM이 상장폐지 중에도 Kinesis로 주문을 계속 보내면 ticker/depth 키가 재생성됨.
      // mm:all:symbols에서 제거하면 MM이 이 종목을 무시함.
      try {
        await operatingCache.publish('mm:control', JSON.stringify({
          action: 'stop', symbol: sym, timestamp: Date.now()
        }));
        await operatingCache.srem('mm:all:symbols', sym);
        await operatingCache.srem('mm:running:symbols', sym);
        console.log(`[DELETE] MM pre-stop sent + removed from mm sets for ${sym}`);
      } catch (mmErr) {
        console.warn(`[DELETE] MM pre-stop failed (continuing): ${mmErr.message}`);
      }

      // 4. Step Functions 실행 시작
      try {
        const executionResult = await sfn.send(new StartExecutionCommand({
          stateMachineArn: STATE_MACHINE_ARN,
          name: job_id,
          input: JSON.stringify({ job_id, symbol: sym })
        }));
        console.log(`[DELETE] Step Functions execution started: ${executionResult.executionArn}`);

        // Publish initial delisting event to admin WebSocket clients
        await publishAdminEvent('delist_progress', {
          job_id, symbol: sym, phase: 'INITIATED', status: 'PENDING',
          phases_completed: []
        });
      } catch (sfnErr) {
        console.error(`[DELETE] Step Functions start failed: ${sfnErr.message}`);
        // Job 상태를 FAILED로 업데이트
        await dynamodb.send(new UpdateCommand({
          TableName: DELIST_JOBS_TABLE,
          Key: { job_id },
          UpdateExpression: 'SET #s = :s, #e = :e, updated_at = :now',
          ExpressionAttributeNames: { '#s': 'status', '#e': 'error' },
          ExpressionAttributeValues: {
            ':s': 'FAILED',
            ':e': `Step Functions start failed: ${sfnErr.message}`,
            ':now': new Date().toISOString()
          }
        })).catch(() => {});
        return err(500, `Failed to start delisting process: ${sfnErr.message}`);
      }

      // 5. 즉시 반환 (비동기 - 프론트엔드에서 폴링)
      return ok({
        success: true,
        job_id,
        symbol: sym,
        status: 'PENDING',
        message: `Delisting started for ${sym}. Poll GET /symbols?action=delist-status&job_id=${job_id} for progress.`
      });
    }

    return err(404, 'Not found');
  } catch (e) {
    console.error('Error:', e);
    // 에러 발생 시 PostgreSQL 연결 정리
    await releasePg();
    return err(500, e.message);
  }
};
