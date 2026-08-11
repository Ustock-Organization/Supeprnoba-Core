// Supernoba-admin-mm: 마켓메이커 관리 Lambda with Authentication
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// Common Layer - Valkey, CORS, Response helpers
import { getValkeyClient, CORS, response } from '/opt/nodejs/index.mjs';

// Auth Layer - Cognito JWT 검증
import { verifyAdmin, authErrorResponse } from '/opt/nodejs/verifyAuth.mjs';

const { Client: PgClient } = pg;

const RDS_HOST = process.env.RDS_ENDPOINT || 'supernoba-rdb1.cluster-cyxfcbnpfoci.ap-northeast-2.rds.amazonaws.com';
const RDS_PORT = parseInt(process.env.RDS_PORT || '5432');
const DB_NAME = process.env.DB_NAME || 'postgres';
const DB_SECRET_ARN = process.env.DB_SECRET_ARN || '';

// Layer를 통한 Valkey 클라이언트 (operating 캐시 사용 - MM 관련 데이터)
const valkey = getValkeyClient({ type: 'operating', preset: 'admin' });

const secretsManager = new SecretsManagerClient({ region: 'ap-northeast-2' });
let cachedCreds = null;
let pgClient = null;

// Layer의 CORS.FULL 사용
const H = CORS.FULL;

// EC2 MM Service에 제어 신호 발송
async function sendMMControl(action, symbol = null) {
  const message = { action, symbol, timestamp: Date.now() };
  await valkey.publish('mm:control', JSON.stringify(message));
  console.log(`[MM Control] Sent: ${action}`, symbol || '');
}

// 관리자 인증 체크 (JWT 인증)
const checkAdmin = async (event) => {
  const result = await verifyAdmin(event);
  if (!result.success) {
    return { authorized: false, response: authErrorResponse(result, H) };
  }
  return { authorized: true, userId: result.userId, method: result.method };
};

async function getDbCreds() {
  if (cachedCreds) return cachedCreds;
  if (process.env.DB_USERNAME && process.env.DB_PASSWORD) return { username: process.env.DB_USERNAME, password: process.env.DB_PASSWORD };
  if (DB_SECRET_ARN) {
    const result = await secretsManager.send(new GetSecretValueCommand({ SecretId: DB_SECRET_ARN }));
    const secret = JSON.parse(result.SecretString);
    cachedCreds = { username: secret.username, password: secret.password };
    return cachedCreds;
  }
  return { username: 'postgres', password: 'postgres' };
}

async function getPg() {
  if (pgClient) return pgClient;
  const creds = await getDbCreds();
  pgClient = new PgClient({ host: RDS_HOST, port: RDS_PORT, database: DB_NAME, user: creds.username, password: creds.password, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 5000 });
  await pgClient.connect();
  await pgClient.query(`
    CREATE TABLE IF NOT EXISTS market_maker_configs (
      id SERIAL PRIMARY KEY, symbol VARCHAR(20) NOT NULL UNIQUE, base_price DECIMAL(18,8) DEFAULT 100,
      weekly_amplitude DECIMAL(5,4) DEFAULT 0.15, daily_amplitude DECIMAL(5,4) DEFAULT 0.08,
      hourly_amplitude DECIMAL(5,4) DEFAULT 0.04, minute_amplitude DECIMAL(5,4) DEFAULT 0.02,
      noise_amplitude DECIMAL(5,4) DEFAULT 0.005, tick_interval INT DEFAULT 500,
      strategy VARCHAR(20) DEFAULT 'legacy_sine',
      spread DECIMAL(5,4) DEFAULT 0.02,
      depth_levels INT DEFAULT 3,
      depth_decay DECIMAL(5,4) DEFAULT 0.50,
      external_feed VARCHAR(20) DEFAULT 'none',
      external_symbol VARCHAR(20) DEFAULT 'btcusdt',
      correlation DECIMAL(5,4) DEFAULT 0.30,
      cancel_interval INT DEFAULT 5,
      max_open_orders INT DEFAULT 10,
      trend_bias DECIMAL(5,4) DEFAULT 0.00,
      position_limit INT DEFAULT 500,
      risk_aversion DECIMAL(5,4) DEFAULT 0.50,
      volatility DECIMAL(8,6) DEFAULT 0.000100,
      is_running BOOLEAN DEFAULT false, current_price DECIMAL(18,8), order_count INT DEFAULT 0,
      started_at TIMESTAMP, stopped_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_mm_symbol ON market_maker_configs(symbol);
  `);
  // Add v10 columns if missing (idempotent)
  await pgClient.query(`
    DO $$
    BEGIN
      ALTER TABLE market_maker_configs ADD COLUMN IF NOT EXISTS strategy VARCHAR(20) DEFAULT 'legacy_sine';
      ALTER TABLE market_maker_configs ADD COLUMN IF NOT EXISTS spread DECIMAL(5,4) DEFAULT 0.02;
      ALTER TABLE market_maker_configs ADD COLUMN IF NOT EXISTS depth_levels INT DEFAULT 3;
      ALTER TABLE market_maker_configs ADD COLUMN IF NOT EXISTS depth_decay DECIMAL(5,4) DEFAULT 0.50;
      ALTER TABLE market_maker_configs ADD COLUMN IF NOT EXISTS external_feed VARCHAR(20) DEFAULT 'none';
      ALTER TABLE market_maker_configs ADD COLUMN IF NOT EXISTS external_symbol VARCHAR(20) DEFAULT 'btcusdt';
      ALTER TABLE market_maker_configs ADD COLUMN IF NOT EXISTS correlation DECIMAL(5,4) DEFAULT 0.30;
      ALTER TABLE market_maker_configs ADD COLUMN IF NOT EXISTS cancel_interval INT DEFAULT 5;
      ALTER TABLE market_maker_configs ADD COLUMN IF NOT EXISTS max_open_orders INT DEFAULT 10;
      ALTER TABLE market_maker_configs ADD COLUMN IF NOT EXISTS trend_bias DECIMAL(5,4) DEFAULT 0.00;
      ALTER TABLE market_maker_configs ADD COLUMN IF NOT EXISTS position_limit INT DEFAULT 500;
      ALTER TABLE market_maker_configs ADD COLUMN IF NOT EXISTS risk_aversion DECIMAL(5,4) DEFAULT 0.50;
      ALTER TABLE market_maker_configs ADD COLUMN IF NOT EXISTS volatility DECIMAL(8,6) DEFAULT 0.000100;
    END $$;
  `);
  return pgClient;
}

const ok = (d) => response.ok(d, H);
const err = (c, m) => response.error(c, m, H);

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  try {
    const method = event.httpMethod;
    const q = event.queryStringParameters || {};
    const action = q.action;

    // 내부 호출(admin-ws-handler → Lambda invoke)은 인증 스킵
    const headers = event.headers || {};
    const isInternal = headers['x-internal-call'] === 'true';
    if (!isInternal) {
      const adminCheck = await checkAdmin(event);
      if (!adminCheck.authorized) return adminCheck.response;
    }

    if (method === 'GET') {
      const db = await getPg();
      if (action === 'list') {
        const r = await db.query(`SELECT symbol, base_price, is_running, current_price, order_count, weekly_amplitude, daily_amplitude, hourly_amplitude, minute_amplitude, noise_amplitude, tick_interval, strategy, spread, depth_levels, depth_decay, external_feed, external_symbol, correlation, cancel_interval, max_open_orders, trend_bias, position_limit, risk_aversion, volatility, started_at, updated_at FROM market_maker_configs ORDER BY is_running DESC, updated_at DESC`);
        // Valkey에서 실시간 데이터 조회 (mm:price, mm:orderCount 사용)
        const rows = await Promise.all(r.rows.map(async (row) => {
          if (row.is_running) {
            const [priceStr, count] = await Promise.all([
              valkey.get(`mm:price:${row.symbol}`),
              valkey.get(`mm:orderCount:${row.symbol}`)
            ]);
            return {
              ...row,
              current_price: priceStr ? parseFloat(priceStr) : row.current_price,
              order_count: count ? parseInt(count) : row.order_count
            };
          }
          return row;
        }));
        return ok(rows);
      }
      if (action === 'get' && q.symbol) {
        const r = await db.query('SELECT * FROM market_maker_configs WHERE symbol = $1', [q.symbol.toUpperCase()]);
        return r.rows.length ? ok(r.rows[0]) : err(404, 'Not found');
      }
      if (action === 'status') {
        const [running, sym, basePrice, configStr, currentPrice, orderCount] = await Promise.all([valkey.get('mm:running'), valkey.get('mm:symbol'), valkey.get('mm:basePrice'), valkey.get('mm:config'), valkey.get('mm:currentPrice'), valkey.get('mm:orderCount')]);
        const allRunning = await db.query('SELECT symbol, current_price, order_count FROM market_maker_configs WHERE is_running = true');
        return ok({ running: running === 'true', symbol: sym, basePrice: basePrice ? parseFloat(basePrice) : 100, currentPrice: currentPrice ? parseFloat(currentPrice) : null, orderCount: orderCount ? parseInt(orderCount) : 0, config: configStr ? JSON.parse(configStr) : null, runningSymbols: allRunning.rows });
      }
      // 디버그: Redis 데이터 직접 확인
      if (action === 'debug_redis') {
        const allSymbols = await valkey.smembers('mm:all:symbols');
        const runningSymbols = await valkey.smembers('mm:running:symbols');
        const adminConnections = await valkey.scard('admin:connections');
        const configs = {};
        const startedAt = {};
        for (const s of allSymbols) {
          const cfgStr = await valkey.get(`mm:config:${s}`);
          configs[s] = cfgStr ? JSON.parse(cfgStr) : null;
          const started = await valkey.get(`mm:started_at:${s}`);
          startedAt[s] = started || null;
        }
        return ok({ allSymbols, runningSymbols, adminConnections, configs, startedAt });
      }
      return ok([]);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { action, symbol, basePrice, config } = body;
      const db = await getPg();
      const sym = (symbol || '').toUpperCase();
      const cfg = config || {};

      if (action === 'save') {
        if (!sym) return err(400, 'Symbol required');
        // DB용 복합 포맷
        const dbCfg = {
          basePrice: basePrice || 100,
          weeklyAmplitude: cfg.weeklyAmplitude ?? 0.15,
          dailyAmplitude: cfg.dailyAmplitude ?? 0.08,
          hourlyAmplitude: cfg.hourlyAmplitude ?? 0.04,
          minuteAmplitude: cfg.minuteAmplitude ?? 0.02,
          noiseAmplitude: cfg.noiseAmplitude ?? 0.005,
          tickInterval: cfg.tickInterval || 500,
          strategy: cfg.strategy || 'legacy_sine',
          spread: cfg.spread ?? 0.02,
          depthLevels: cfg.depthLevels ?? 3,
          depthDecay: cfg.depthDecay ?? 0.50,
          externalFeed: cfg.externalFeed || 'none',
          externalSymbol: cfg.externalSymbol || 'btcusdt',
          correlation: cfg.correlation ?? 0.30,
          cancelInterval: cfg.cancelInterval ?? 5,
          maxOpenOrders: cfg.maxOpenOrders ?? 10,
          trendBias: cfg.trendBias ?? 0,
          positionLimit: cfg.positionLimit ?? 500,
          riskAversion: cfg.riskAversion ?? 0.50,
          volatility: cfg.volatility ?? 0.0001,
        };
        // Redis용 단순 포맷 (MM Service가 읽는 포맷)
        const redisCfg = {
          basePrice: basePrice || 100,
          period: cfg.period ?? 600,
          amplitude: cfg.amplitude ?? 0.1,
          tickInterval: cfg.tickInterval || 1000,
          tradeInterval: cfg.tradeInterval ?? 3,
          tradeQuantity: cfg.tradeQuantity ?? 50,
          strategy: dbCfg.strategy,
          spread: dbCfg.spread,
          depthLevels: dbCfg.depthLevels,
          depthDecay: dbCfg.depthDecay,
          externalFeed: dbCfg.externalFeed,
          externalSymbol: dbCfg.externalSymbol,
          correlation: dbCfg.correlation,
          cancelInterval: dbCfg.cancelInterval,
          maxOpenOrders: dbCfg.maxOpenOrders,
          trendBias: dbCfg.trendBias,
          positionLimit: dbCfg.positionLimit,
          riskAversion: dbCfg.riskAversion,
          volatility: dbCfg.volatility,
        };
        await db.query(`INSERT INTO market_maker_configs (symbol, base_price, weekly_amplitude, daily_amplitude, hourly_amplitude, minute_amplitude, noise_amplitude, tick_interval, strategy, spread, depth_levels, depth_decay, external_feed, external_symbol, correlation, cancel_interval, max_open_orders, trend_bias, position_limit, risk_aversion, volatility, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,CURRENT_TIMESTAMP) ON CONFLICT (symbol) DO UPDATE SET base_price=EXCLUDED.base_price, weekly_amplitude=EXCLUDED.weekly_amplitude, daily_amplitude=EXCLUDED.daily_amplitude, hourly_amplitude=EXCLUDED.hourly_amplitude, minute_amplitude=EXCLUDED.minute_amplitude, noise_amplitude=EXCLUDED.noise_amplitude, tick_interval=EXCLUDED.tick_interval, strategy=EXCLUDED.strategy, spread=EXCLUDED.spread, depth_levels=EXCLUDED.depth_levels, depth_decay=EXCLUDED.depth_decay, external_feed=EXCLUDED.external_feed, external_symbol=EXCLUDED.external_symbol, correlation=EXCLUDED.correlation, cancel_interval=EXCLUDED.cancel_interval, max_open_orders=EXCLUDED.max_open_orders, trend_bias=EXCLUDED.trend_bias, position_limit=EXCLUDED.position_limit, risk_aversion=EXCLUDED.risk_aversion, volatility=EXCLUDED.volatility, updated_at=CURRENT_TIMESTAMP`, [sym, dbCfg.basePrice, dbCfg.weeklyAmplitude, dbCfg.dailyAmplitude, dbCfg.hourlyAmplitude, dbCfg.minuteAmplitude, dbCfg.noiseAmplitude, dbCfg.tickInterval, dbCfg.strategy, dbCfg.spread, dbCfg.depthLevels, dbCfg.depthDecay, dbCfg.externalFeed, dbCfg.externalSymbol, dbCfg.correlation, dbCfg.cancelInterval, dbCfg.maxOpenOrders, dbCfg.trendBias, dbCfg.positionLimit, dbCfg.riskAversion, dbCfg.volatility]);
        // mm:all:symbols에 추가 (WebSocket 핸들러가 목록 조회 시 사용)
        await valkey.sadd('mm:all:symbols', sym);
        // Redis에 단순 포맷으로 저장 (항상)
        await valkey.set(`mm:config:${sym}`, JSON.stringify(redisCfg));
        const isRunning = await valkey.sismember('mm:running:symbols', sym);
        if (isRunning) {
          await sendMMControl('reload', sym);
        }
        return ok({ success: true, applied: !!isRunning, reloaded: !!isRunning });
      }

      if (action === 'start') {
        if (!sym) return err(400, 'Symbol required');
        // 삭제된 종목 체크
        const isDeleted = await valkey.sismember('deleted:symbols', sym);
        if (isDeleted) return err(400, `Symbol ${sym} was deleted and cannot start MarketMaker`);
        // DB에서 기존 설정 조회
        const existing = await db.query('SELECT * FROM market_maker_configs WHERE symbol = $1', [sym]);
        let finalBasePrice = basePrice || (existing.rows[0]?.base_price ? parseFloat(existing.rows[0].base_price) : 100);
        const ex = existing.rows[0];
        let finalCfg = {
          weeklyAmplitude: cfg.weeklyAmplitude || (ex?.weekly_amplitude ? parseFloat(ex.weekly_amplitude) : 0.15),
          dailyAmplitude: cfg.dailyAmplitude || (ex?.daily_amplitude ? parseFloat(ex.daily_amplitude) : 0.08),
          hourlyAmplitude: cfg.hourlyAmplitude || (ex?.hourly_amplitude ? parseFloat(ex.hourly_amplitude) : 0.04),
          minuteAmplitude: cfg.minuteAmplitude || (ex?.minute_amplitude ? parseFloat(ex.minute_amplitude) : 0.02),
          noiseAmplitude: cfg.noiseAmplitude || (ex?.noise_amplitude ? parseFloat(ex.noise_amplitude) : 0.005),
          tickInterval: cfg.tickInterval || (ex?.tick_interval ? parseInt(ex.tick_interval) : 500),
          strategy: cfg.strategy || ex?.strategy || 'legacy_sine',
          spread: cfg.spread ?? (ex?.spread != null ? parseFloat(ex.spread) : 0.02),
          depthLevels: cfg.depthLevels ?? (ex?.depth_levels != null ? parseInt(ex.depth_levels) : 3),
          depthDecay: cfg.depthDecay ?? (ex?.depth_decay != null ? parseFloat(ex.depth_decay) : 0.50),
          externalFeed: cfg.externalFeed || ex?.external_feed || 'none',
          externalSymbol: cfg.externalSymbol || ex?.external_symbol || 'btcusdt',
          correlation: cfg.correlation ?? (ex?.correlation != null ? parseFloat(ex.correlation) : 0.30),
          cancelInterval: cfg.cancelInterval ?? (ex?.cancel_interval != null ? parseInt(ex.cancel_interval) : 5),
          maxOpenOrders: cfg.maxOpenOrders ?? (ex?.max_open_orders != null ? parseInt(ex.max_open_orders) : 10),
          trendBias: cfg.trendBias ?? (ex?.trend_bias != null ? parseFloat(ex.trend_bias) : 0),
          positionLimit: cfg.positionLimit ?? (ex?.position_limit != null ? parseInt(ex.position_limit) : 500),
          riskAversion: cfg.riskAversion ?? (ex?.risk_aversion != null ? parseFloat(ex.risk_aversion) : 0.50),
          volatility: cfg.volatility ?? (ex?.volatility != null ? parseFloat(ex.volatility) : 0.0001),
        };
        await db.query(`INSERT INTO market_maker_configs (symbol, base_price, weekly_amplitude, daily_amplitude, hourly_amplitude, minute_amplitude, noise_amplitude, tick_interval, strategy, spread, depth_levels, depth_decay, external_feed, external_symbol, correlation, cancel_interval, max_open_orders, trend_bias, position_limit, risk_aversion, volatility, is_running, started_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT (symbol) DO UPDATE SET base_price=EXCLUDED.base_price, weekly_amplitude=EXCLUDED.weekly_amplitude, daily_amplitude=EXCLUDED.daily_amplitude, hourly_amplitude=EXCLUDED.hourly_amplitude, minute_amplitude=EXCLUDED.minute_amplitude, noise_amplitude=EXCLUDED.noise_amplitude, tick_interval=EXCLUDED.tick_interval, strategy=EXCLUDED.strategy, spread=EXCLUDED.spread, depth_levels=EXCLUDED.depth_levels, depth_decay=EXCLUDED.depth_decay, external_feed=EXCLUDED.external_feed, external_symbol=EXCLUDED.external_symbol, correlation=EXCLUDED.correlation, cancel_interval=EXCLUDED.cancel_interval, max_open_orders=EXCLUDED.max_open_orders, trend_bias=EXCLUDED.trend_bias, position_limit=EXCLUDED.position_limit, risk_aversion=EXCLUDED.risk_aversion, volatility=EXCLUDED.volatility, is_running=true, started_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP`, [sym, finalBasePrice, finalCfg.weeklyAmplitude, finalCfg.dailyAmplitude, finalCfg.hourlyAmplitude, finalCfg.minuteAmplitude, finalCfg.noiseAmplitude, finalCfg.tickInterval, finalCfg.strategy, finalCfg.spread, finalCfg.depthLevels, finalCfg.depthDecay, finalCfg.externalFeed, finalCfg.externalSymbol, finalCfg.correlation, finalCfg.cancelInterval, finalCfg.maxOpenOrders, finalCfg.trendBias, finalCfg.positionLimit, finalCfg.riskAversion, finalCfg.volatility]);
        await valkey.set('mm:running', 'true');
        await valkey.sadd('mm:running:symbols', sym);
        // mm:all:symbols에 추가 (WebSocket 핸들러가 목록 조회 시 사용)
        await valkey.sadd('mm:all:symbols', sym);
        // Redis용 포맷 (MM Service가 읽는 포맷)
        const redisCfg = {
          basePrice: finalBasePrice,
          period: cfg.period ?? 600,
          amplitude: cfg.amplitude ?? 0.1,
          tickInterval: cfg.tickInterval || 1000,
          tradeInterval: cfg.tradeInterval ?? 3,
          tradeQuantity: cfg.tradeQuantity ?? 50,
          strategy: finalCfg.strategy,
          spread: finalCfg.spread,
          depthLevels: finalCfg.depthLevels,
          depthDecay: finalCfg.depthDecay,
          externalFeed: finalCfg.externalFeed,
          externalSymbol: finalCfg.externalSymbol,
          correlation: finalCfg.correlation,
          cancelInterval: finalCfg.cancelInterval,
          maxOpenOrders: finalCfg.maxOpenOrders,
          trendBias: finalCfg.trendBias,
          positionLimit: finalCfg.positionLimit,
          riskAversion: finalCfg.riskAversion,
          volatility: finalCfg.volatility,
        };
        await valkey.set(`mm:config:${sym}`, JSON.stringify(redisCfg));
        // EC2 MM Service에 시작 신호 발송
        await sendMMControl('start', sym);
        return ok({ success: true, config: redisCfg });
      }

      if (action === 'stop') {
        if (sym) {
          await db.query(`UPDATE market_maker_configs SET is_running=false, stopped_at=CURRENT_TIMESTAMP WHERE symbol=$1`, [sym]);
          await valkey.srem('mm:running:symbols', sym);
          const cur = await valkey.get('mm:symbol');
          if (cur === sym) await valkey.set('mm:running', 'false');
          // EC2 MM Service에 정지 신호 발송
          await sendMMControl('stop', sym);
        } else {
          await db.query(`UPDATE market_maker_configs SET is_running=false, stopped_at=CURRENT_TIMESTAMP WHERE is_running=true`);
          await valkey.set('mm:running', 'false');
          await valkey.del('mm:running:symbols');
          // EC2 MM Service에 전체 정지 신호 발송
          await sendMMControl('stopAll');
        }
        return ok({ success: true });
      }

      if (action === 'delete') {
        if (!sym) return err(400, 'Symbol required');
        // 먼저 MM 정지
        await sendMMControl('stop', sym);
        await db.query('DELETE FROM market_maker_configs WHERE symbol=$1', [sym]);
        await valkey.srem('mm:running:symbols', sym);
        await valkey.srem('mm:all:symbols', sym);
        await valkey.del(`mm:config:${sym}`);
        await valkey.del(`mm:price:${sym}`);
        await valkey.del(`mm:orderCount:${sym}`);
        await valkey.del(`mm:started_at:${sym}`);
        return ok({ success: true });
      }

      // 실시간 설정 반영
      if (action === 'reload') {
        if (!sym) return err(400, 'Symbol required');
        await sendMMControl('reload', sym);
        return ok({ success: true });
      }

      if (action === 'startAll') {
        const all = await db.query('SELECT symbol, base_price, weekly_amplitude, daily_amplitude, hourly_amplitude, minute_amplitude, noise_amplitude, tick_interval, strategy, spread, depth_levels, depth_decay, external_feed, external_symbol, correlation, cancel_interval, max_open_orders, trend_bias, position_limit, risk_aversion, volatility FROM market_maker_configs');
        // 삭제된 종목 목록 가져오기
        const deletedSymbols = await valkey.smembers('deleted:symbols');
        const deletedSet = new Set(deletedSymbols);
        const started = [];
        const skipped = [];
        for (const row of all.rows) {
          // 삭제된 종목은 시작하지 않음
          if (deletedSet.has(row.symbol)) {
            skipped.push(row.symbol);
            continue;
          }
          await db.query('UPDATE market_maker_configs SET is_running=true, started_at=CURRENT_TIMESTAMP WHERE symbol=$1', [row.symbol]);
          await valkey.sadd('mm:running:symbols', row.symbol);
          // mm:all:symbols에 추가 (WebSocket 핸들러가 목록 조회 시 사용)
          await valkey.sadd('mm:all:symbols', row.symbol);
          // Redis용 포맷 (MM Service가 읽는 포맷)
          await valkey.set(`mm:config:${row.symbol}`, JSON.stringify({
            basePrice: parseFloat(row.base_price),
            period: 600,
            amplitude: 0.1,
            tickInterval: parseInt(row.tick_interval) || 1000,
            tradeInterval: 3,
            tradeQuantity: 50,
            strategy: row.strategy || 'legacy_sine',
            spread: row.spread != null ? parseFloat(row.spread) : 0.02,
            depthLevels: row.depth_levels != null ? parseInt(row.depth_levels) : 3,
            depthDecay: row.depth_decay != null ? parseFloat(row.depth_decay) : 0.50,
            externalFeed: row.external_feed || 'none',
            externalSymbol: row.external_symbol || 'btcusdt',
            correlation: row.correlation != null ? parseFloat(row.correlation) : 0.30,
            cancelInterval: row.cancel_interval != null ? parseInt(row.cancel_interval) : 5,
            maxOpenOrders: row.max_open_orders != null ? parseInt(row.max_open_orders) : 10,
            trendBias: row.trend_bias != null ? parseFloat(row.trend_bias) : 0,
            positionLimit: row.position_limit != null ? parseInt(row.position_limit) : 500,
            riskAversion: row.risk_aversion != null ? parseFloat(row.risk_aversion) : 0.50,
            volatility: row.volatility != null ? parseFloat(row.volatility) : 0.0001,
          }));
          started.push(row.symbol);
        }
        await valkey.set('mm:running', 'true');
        // EC2 MM Service에 전체 시작 신호 발송
        await sendMMControl('startAll');
        return ok({ success: true, started, skipped, count: started.length });
      }

      if (action === 'stopAll') {
        await db.query('UPDATE market_maker_configs SET is_running=false, stopped_at=CURRENT_TIMESTAMP WHERE is_running=true');
        await valkey.set('mm:running', 'false');
        await valkey.del('mm:running:symbols');
        // EC2 MM Service에 전체 정지 신호 발송
        await sendMMControl('stopAll');
        return ok({ success: true });
      }
    }
    return err(400, 'Invalid request');
  } catch (e) { console.error('Error:', e); return err(500, e.message); }
};
