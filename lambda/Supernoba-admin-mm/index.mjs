// Supernoba-admin-mm: 마켓메이커 관리 Lambda with Authentication
import pg from 'pg';
import Redis from 'ioredis';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// === Auth Layer Import ===
let verifyAdmin, authErrorResponse;
try {
  const authModule = await import('/opt/nodejs/verifyAuth.mjs');
  verifyAdmin = authModule.verifyAdmin;
  authErrorResponse = authModule.authErrorResponse;
} catch (e) {
  console.warn('[admin-mm] Auth layer not available, using fallback');
  // Fallback: 기존 API 키 방식만 사용
  verifyAdmin = async (event) => {
    const adminApiKey = process.env.ADMIN_API_KEY;
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (adminApiKey && authHeader === adminApiKey) {
      return { success: true, userId: 'admin', role: 'admin', method: 'api_key' };
    }
    return { success: false, error: 'UNAUTHORIZED', message: '인증이 필요합니다' };
  };
  authErrorResponse = (result) => ({
    statusCode: 401,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: result.error, message: result.message })
  });
}

const { Client: PgClient } = pg;

const RDS_HOST = process.env.RDS_ENDPOINT || 'supernoba-rdb1.cluster-cyxfcbnpfoci.ap-northeast-2.rds.amazonaws.com';
const RDS_PORT = parseInt(process.env.RDS_PORT || '5432');
const DB_NAME = process.env.DB_NAME || 'postgres';
const DB_SECRET_ARN = process.env.DB_SECRET_ARN || '';
// MM 전용: 백업 캐시 사용 (depth cache와 분리)
const VALKEY_HOST = process.env.VALKEY_HOST || 'master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com';

const valkey = new Redis({ host: VALKEY_HOST, port: 6379, tls: {}, connectTimeout: 5000, maxRetriesPerRequest: 3 });
valkey.on('error', (err) => console.error('Redis error:', err.message));

const secretsManager = new SecretsManagerClient({ region: 'ap-northeast-2' });
let cachedCreds = null;
let pgClient = null;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

// 관리자 인증 체크 (JWT + API Key 병행)
const checkAdmin = async (event) => {
  const result = await verifyAdmin(event);
  if (!result.success) {
    return { authorized: false, response: authErrorResponse(result, headers) };
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
      is_running BOOLEAN DEFAULT false, current_price DECIMAL(18,8), order_count INT DEFAULT 0,
      started_at TIMESTAMP, stopped_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_mm_symbol ON market_maker_configs(symbol);
  `);
  return pgClient;
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const method = event.httpMethod;
    const q = event.queryStringParameters || {};
    const action = q.action;

    // 모든 요청에 관리자 인증 필요
    const adminCheck = await checkAdmin(event);
    if (!adminCheck.authorized) return adminCheck.response;

    if (method === 'GET') {
      const db = await getPg();
      if (action === 'list') {
        const r = await db.query(`SELECT symbol, base_price, is_running, current_price, order_count, weekly_amplitude, daily_amplitude, hourly_amplitude, minute_amplitude, noise_amplitude, tick_interval, started_at, updated_at FROM market_maker_configs ORDER BY is_running DESC, updated_at DESC`);
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
        return { statusCode: 200, headers, body: JSON.stringify(rows) };
      }
      if (action === 'get' && q.symbol) {
        const r = await db.query('SELECT * FROM market_maker_configs WHERE symbol = $1', [q.symbol.toUpperCase()]);
        return r.rows.length ? { statusCode: 200, headers, body: JSON.stringify(r.rows[0]) } : { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };
      }
      if (action === 'status') {
        const [running, sym, basePrice, configStr, currentPrice, orderCount] = await Promise.all([valkey.get('mm:running'), valkey.get('mm:symbol'), valkey.get('mm:basePrice'), valkey.get('mm:config'), valkey.get('mm:currentPrice'), valkey.get('mm:orderCount')]);
        const allRunning = await db.query('SELECT symbol, current_price, order_count FROM market_maker_configs WHERE is_running = true');
        return { statusCode: 200, headers, body: JSON.stringify({ running: running === 'true', symbol: sym, basePrice: basePrice ? parseFloat(basePrice) : 100, currentPrice: currentPrice ? parseFloat(currentPrice) : null, orderCount: orderCount ? parseInt(orderCount) : 0, config: configStr ? JSON.parse(configStr) : null, runningSymbols: allRunning.rows }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify([]) };
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { action, symbol, basePrice, config } = body;
      const db = await getPg();
      const sym = (symbol || '').toUpperCase();
      const cfg = config || {};

      if (action === 'save') {
        if (!sym) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Symbol required' }) };
        const finalCfg = {
          basePrice: basePrice || 100,
          weeklyAmplitude: cfg.weeklyAmplitude ?? 0.15,
          dailyAmplitude: cfg.dailyAmplitude ?? 0.08,
          hourlyAmplitude: cfg.hourlyAmplitude ?? 0.04,
          minuteAmplitude: cfg.minuteAmplitude ?? 0.02,
          noiseAmplitude: cfg.noiseAmplitude ?? 0.005,
          tickInterval: cfg.tickInterval || 500
        };
        await db.query(`INSERT INTO market_maker_configs (symbol, base_price, weekly_amplitude, daily_amplitude, hourly_amplitude, minute_amplitude, noise_amplitude, tick_interval, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP) ON CONFLICT (symbol) DO UPDATE SET base_price=EXCLUDED.base_price, weekly_amplitude=EXCLUDED.weekly_amplitude, daily_amplitude=EXCLUDED.daily_amplitude, hourly_amplitude=EXCLUDED.hourly_amplitude, minute_amplitude=EXCLUDED.minute_amplitude, noise_amplitude=EXCLUDED.noise_amplitude, tick_interval=EXCLUDED.tick_interval, updated_at=CURRENT_TIMESTAMP`, [sym, finalCfg.basePrice, finalCfg.weeklyAmplitude, finalCfg.dailyAmplitude, finalCfg.hourlyAmplitude, finalCfg.minuteAmplitude, finalCfg.noiseAmplitude, finalCfg.tickInterval]);
        // 실행 중인 경우 Valkey에도 즉시 반영
        const isRunning = await valkey.sismember('mm:running:symbols', sym);
        if (isRunning) {
          await valkey.set(`mm:config:${sym}`, JSON.stringify(finalCfg));
        }
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, applied: !!isRunning }) };
      }

      if (action === 'start') {
        if (!sym) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Symbol required' }) };
        // 삭제된 종목 체크
        const isDeleted = await valkey.sismember('deleted:symbols', sym);
        if (isDeleted) return { statusCode: 400, headers, body: JSON.stringify({ error: `Symbol ${sym} was deleted and cannot start MarketMaker` }) };
        // DB에서 기존 설정 조회
        const existing = await db.query('SELECT * FROM market_maker_configs WHERE symbol = $1', [sym]);
        let finalBasePrice = basePrice || (existing.rows[0]?.base_price ? parseFloat(existing.rows[0].base_price) : 100);
        let finalCfg = {
          weeklyAmplitude: cfg.weeklyAmplitude || (existing.rows[0]?.weekly_amplitude ? parseFloat(existing.rows[0].weekly_amplitude) : 0.15),
          dailyAmplitude: cfg.dailyAmplitude || (existing.rows[0]?.daily_amplitude ? parseFloat(existing.rows[0].daily_amplitude) : 0.08),
          hourlyAmplitude: cfg.hourlyAmplitude || (existing.rows[0]?.hourly_amplitude ? parseFloat(existing.rows[0].hourly_amplitude) : 0.04),
          minuteAmplitude: cfg.minuteAmplitude || (existing.rows[0]?.minute_amplitude ? parseFloat(existing.rows[0].minute_amplitude) : 0.02),
          noiseAmplitude: cfg.noiseAmplitude || (existing.rows[0]?.noise_amplitude ? parseFloat(existing.rows[0].noise_amplitude) : 0.005),
          tickInterval: cfg.tickInterval || (existing.rows[0]?.tick_interval ? parseInt(existing.rows[0].tick_interval) : 500)
        };
        await db.query(`INSERT INTO market_maker_configs (symbol, base_price, weekly_amplitude, daily_amplitude, hourly_amplitude, minute_amplitude, noise_amplitude, tick_interval, is_running, started_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT (symbol) DO UPDATE SET base_price=EXCLUDED.base_price, weekly_amplitude=EXCLUDED.weekly_amplitude, daily_amplitude=EXCLUDED.daily_amplitude, hourly_amplitude=EXCLUDED.hourly_amplitude, minute_amplitude=EXCLUDED.minute_amplitude, noise_amplitude=EXCLUDED.noise_amplitude, tick_interval=EXCLUDED.tick_interval, is_running=true, started_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP`, [sym, finalBasePrice, finalCfg.weeklyAmplitude, finalCfg.dailyAmplitude, finalCfg.hourlyAmplitude, finalCfg.minuteAmplitude, finalCfg.noiseAmplitude, finalCfg.tickInterval]);
        await valkey.set('mm:running', 'true');
        await valkey.sadd('mm:running:symbols', sym);
        // mm:config:SYMBOL 형식으로 저장 (market-maker가 읽는 형식)
        await valkey.set(`mm:config:${sym}`, JSON.stringify({ basePrice: finalBasePrice, ...finalCfg }));
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, config: { basePrice: finalBasePrice, ...finalCfg } }) };
      }

      if (action === 'stop') {
        if (sym) { await db.query(`UPDATE market_maker_configs SET is_running=false, stopped_at=CURRENT_TIMESTAMP WHERE symbol=$1`, [sym]); await valkey.srem('mm:running:symbols', sym); const cur = await valkey.get('mm:symbol'); if (cur === sym) await valkey.set('mm:running', 'false'); }
        else { await db.query(`UPDATE market_maker_configs SET is_running=false, stopped_at=CURRENT_TIMESTAMP WHERE is_running=true`); await valkey.set('mm:running', 'false'); await valkey.del('mm:running:symbols'); }
        return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
      }

      if (action === 'delete') {
        if (!sym) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Symbol required' }) };
        await db.query('DELETE FROM market_maker_configs WHERE symbol=$1', [sym]); await valkey.srem('mm:running:symbols', sym);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
      }

      if (action === 'startAll') {
        const all = await db.query('SELECT symbol, base_price, weekly_amplitude, daily_amplitude, hourly_amplitude, minute_amplitude, noise_amplitude, tick_interval FROM market_maker_configs');
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
          await valkey.set(`mm:config:${row.symbol}`, JSON.stringify({
            basePrice: parseFloat(row.base_price), weeklyAmplitude: parseFloat(row.weekly_amplitude),
            dailyAmplitude: parseFloat(row.daily_amplitude), hourlyAmplitude: parseFloat(row.hourly_amplitude),
            minuteAmplitude: parseFloat(row.minute_amplitude), noiseAmplitude: parseFloat(row.noise_amplitude),
            tickInterval: parseInt(row.tick_interval)
          }));
          started.push(row.symbol);
        }
        await valkey.set('mm:running', 'true');
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, started, skipped, count: started.length }) };
      }

      if (action === 'stopAll') {
        await db.query('UPDATE market_maker_configs SET is_running=false, stopped_at=CURRENT_TIMESTAMP WHERE is_running=true');
        await valkey.set('mm:running', 'false');
        await valkey.del('mm:running:symbols');
        return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
      }
    }
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
  } catch (e) { console.error('Error:', e); return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) }; }
};
