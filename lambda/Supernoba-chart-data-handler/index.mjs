// chart-data-handler Lambda v4 (Valkey + RDS Hybrid)
// Valkey에서 실시간 캔들 + RDS에서 히스토리 캔들 조회

import pg from 'pg';
import { getValkeyClient as getLayerValkeyClient } from '/opt/nodejs/index.mjs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;

// 환경변수
const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO'; // DEBUG, INFO, WARN, ERROR
const RDS_HOST = process.env.RDS_ENDPOINT || 'supernoba-rdb1.cluster-cyxfcbnpfoci.ap-northeast-2.rds.amazonaws.com';

// 로그 레벨 체크
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const currentLogLevel = LOG_LEVELS[LOG_LEVEL] ?? LOG_LEVELS.INFO;

const logger = {
  debug: (...args) => currentLogLevel <= LOG_LEVELS.DEBUG && console.log('[DEBUG]', ...args),
  info: (...args) => currentLogLevel <= LOG_LEVELS.INFO && console.log('[INFO]', ...args),
  warn: (...args) => currentLogLevel <= LOG_LEVELS.WARN && console.warn('[WARN]', ...args),
  error: (...args) => currentLogLevel <= LOG_LEVELS.ERROR && console.error('[ERROR]', ...args),
};
const RDS_PORT = parseInt(process.env.RDS_PORT || '5432');
const DB_NAME = process.env.DB_NAME || 'postgres';
const DB_SECRET_ARN = process.env.DB_SECRET_ARN || '';
const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-2';
// 타임프레임별 초 수
const INTERVAL_SECONDS = {
  '1m': 60, '3m': 180, '5m': 300, '10m': 600,
  '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400,
  '1d': 86400, '1w': 604800
};

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Secrets Manager 클라이언트
const secretsManager = new SecretsManagerClient({ region: AWS_REGION });

// RDS 자격 증명 캐시
let cachedCredentials = null;

// 타이밍 헬퍼
function elapsed(start) {
  return `${(Date.now() - start)}ms`;
}

// Valkey 연결 (Common Layer 4-Cache)
const candleCache = getLayerValkeyClient({ type: 'candle', preset: 'default' });
function getValkeyClient() {
  return candleCache;
}

// Valkey에서 현재 캔들 + closed 리스트 조회
async function getCandlesFromValkey(symbol, interval, limit) {
  const funcStart = Date.now();
  logger.debug(`getCandlesFromValkey START: ${symbol} ${interval}`);

  // 1분봉만 Valkey에서 조회 가능
  if (interval !== '1m') {
    logger.debug(` Valkey only supports 1m interval, requested: ${interval}`);
    return [];
  }

  try {
    const redis = getValkeyClient();
    const upperSymbol = symbol.toUpperCase();

    // 1. 마감된 캔들 리스트에서 조회 (최신 limit개)
    const closedKey = `candle:closed:1m:${upperSymbol}`;
    const closedCandles = await redis.lrange(closedKey, 0, limit - 1);
    logger.debug(` Closed candles from ${closedKey}: ${closedCandles.length}`);

    // 2. 현재 활성 캔들 조회
    const activeKey = `candle:1m:${upperSymbol}`;
    const activeCandle = await redis.hgetall(activeKey);
    logger.debug(` Active candle from ${activeKey}:`, Object.keys(activeCandle).length > 0 ? 'found' : 'not found');

    // 3. 데이터 변환
    const candles = [];

    // closed 캔들 파싱 (JSON 문자열 형태)
    for (const item of closedCandles) {
      try {
        const c = JSON.parse(item);
        candles.push({
          time: parseInt(c.t_epoch || c.time_epoch || Math.floor(new Date(c.t).getTime() / 1000)),
          open: parseFloat(c.o || c.open),
          high: parseFloat(c.h || c.high),
          low: parseFloat(c.l || c.low),
          close: parseFloat(c.c || c.close),
          volume: parseFloat(c.v || c.volume || 0)
        });
      } catch (parseErr) {
        logger.warn(` Failed to parse closed candle:`, item);
      }
    }

    // 활성 캔들 추가
    if (activeCandle && activeCandle.t_epoch) {
      candles.push({
        time: parseInt(activeCandle.t_epoch),
        open: parseFloat(activeCandle.o),
        high: parseFloat(activeCandle.h),
        low: parseFloat(activeCandle.l),
        close: parseFloat(activeCandle.c),
        volume: parseFloat(activeCandle.v || 0)
      });
    }

    // 시간순 정렬
    candles.sort((a, b) => a.time - b.time);

    logger.debug(` getCandlesFromValkey TOTAL: ${elapsed(funcStart)} (${candles.length} candles)`);
    return candles;

  } catch (err) {
    logger.error(` Valkey error: ${err.message}`);
    return [];
  }
}

async function getDbCredentials() {
  const start = Date.now();
  logger.debug(' getDbCredentials START');
  
  // 환경 변수에서 직접 읽기 (우선순위 1)
  const envUsername = process.env.DB_USERNAME;
  const envPassword = process.env.DB_PASSWORD;
  
  if (envUsername && envPassword) {
    logger.debug(` getDbCredentials FROM_ENV ${elapsed(start)}`);
    return { username: envUsername, password: envPassword };
  }
  
  // 캐시된 자격 증명 사용 (우선순위 2)
  if (cachedCredentials) {
    logger.debug(` getDbCredentials CACHED ${elapsed(start)}`);
    return cachedCredentials;
  }
  
  // Secrets Manager에서 조회 (우선순위 3 - VPC 엔드포인트 필요)
  if (!DB_SECRET_ARN) {
    logger.debug(` getDbCredentials NO_SECRET_ARN, using defaults ${elapsed(start)}`);
    return { username: 'postgres', password: '' };
  }
  
  try {
    logger.debug(` Fetching secret from SecretsManager: ${DB_SECRET_ARN}`);
    const res = await secretsManager.send(new GetSecretValueCommand({ SecretId: DB_SECRET_ARN }));
    cachedCredentials = JSON.parse(res.SecretString);
    logger.debug(` getDbCredentials SECRET_FETCHED ${elapsed(start)}`);
    return cachedCredentials;
  } catch (err) {
    logger.error(` getDbCredentials ERROR ${elapsed(start)}:`, err.message);
    return { username: 'postgres', password: '' };
  }
}

export const handler = async (event) => {
  const handlerStart = Date.now();
  logger.debug(` ===== HANDLER START =====`);

  const params = event.queryStringParameters || {};
  const symbol = (params.symbol || 'TEST').toLowerCase();
  const interval = params.interval || '1m';
  const limit = Math.min(parseInt(params.limit || '100'), 500);

  logger.debug(` Chart request: ${symbol} ${interval} limit=${limit} type=${params.type || 'candle'}`);

  try {
    // type=prevClose: symbol_prev_close 테이블에서 직접 조회
    if (params.type === 'prevClose') {
      const result = await getPrevCloseFromRDS(symbol);
      logger.debug(` prevClose result: ${JSON.stringify(result)} (${elapsed(handlerStart)})`);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    const intervalSeconds = INTERVAL_SECONDS[interval];
    if (!intervalSeconds) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Invalid interval: ${interval}` }) };
    }

    // 1차: RDS에서 캔들 조회
    let candles = await getCandles(symbol, interval, limit);
    let source = 'rds';

    // 2차: RDS가 비어있으면 Valkey에서 조회 (1분봉만)
    if (candles.length === 0 && interval === '1m') {
      logger.debug(` RDS empty, trying Valkey...`);
      candles = await getCandlesFromValkey(symbol, interval, limit);
      source = 'valkey';
    }

    logger.debug(` Data: ${candles.length} candles (source: ${source})`);
    logger.debug(` ===== HANDLER END (TOTAL: ${elapsed(handlerStart)}) =====`);

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ symbol, interval, data: candles, source })
    };

  } catch (error) {
    logger.error(` HANDLER ERROR ${elapsed(handlerStart)}:`, error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};

// symbol_prev_close 테이블에서 전일종가 조회 (Aggregator가 일 경계에서 관리)
// Fallback: symbol_prev_close가 비어있으면 candle_history에서 오늘 자정(KST) 이전 마지막 캔들 사용
async function getPrevCloseFromRDS(symbol) {
  const funcStart = Date.now();
  const upperSymbol = symbol.toUpperCase();
  logger.debug(` getPrevCloseFromRDS START: ${upperSymbol}`);

  const creds = await getDbCredentials();
  const client = new Client({
    host: RDS_HOST, port: RDS_PORT, database: DB_NAME,
    user: creds.username, password: creds.password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000
  });

  try {
    await client.connect();

    // 1차: symbol_prev_close 테이블 (Aggregator 관리, 가장 정확)
    const query1 = `
      SELECT prev_close, prev_trading_date, last_close, last_trading_date
      FROM symbol_prev_close
      WHERE symbol = $1
    `;
    const result1 = await client.query(query1, [upperSymbol]);

    if (result1.rows.length > 0) {
      const row = result1.rows[0];
      logger.debug(` getPrevCloseFromRDS: ${upperSymbol} from symbol_prev_close=${row.prev_close} (${elapsed(funcStart)})`);
      return {
        symbol: upperSymbol,
        prevClose: parseFloat(row.prev_close),
        prevTradingDate: row.prev_trading_date,
        lastClose: parseFloat(row.last_close),
        lastTradingDate: row.last_trading_date
      };
    }

    // 2차 fallback: candle_history에서 KST 자정 이전 마지막 단봉(30m 이하)의 close
    // 1h/4h/1d 캔들은 자정을 넘을 수 있어 prevClose가 부정확함
    const query2 = `
      SELECT close, time_epoch, interval
      FROM candle_history
      WHERE symbol = $1
        AND interval IN ('1m', '5m', '10m', '15m', '30m')
        AND time_epoch < EXTRACT(EPOCH FROM (date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'))
      ORDER BY time_epoch DESC
      LIMIT 1
    `;
    const result2 = await client.query(query2, [symbol.toLowerCase()]);

    if (result2.rows.length > 0) {
      const row = result2.rows[0];
      logger.debug(` getPrevCloseFromRDS: ${upperSymbol} from candle_history=${row.close} (${elapsed(funcStart)})`);
      return {
        symbol: upperSymbol,
        prevClose: parseFloat(row.close)
      };
    }

    logger.debug(` getPrevCloseFromRDS: ${upperSymbol} not found (${elapsed(funcStart)})`);
    return { symbol: upperSymbol, prevClose: 0 };
  } finally {
    await client.end().catch(() => {});
  }
}

// RDS에서 캔들 조회
async function getCandles(symbol, interval, limit) {
  const funcStart = Date.now();
  logger.debug(` getCandles START`);
  
  // Step 1: Get credentials
  const credStart = Date.now();
  const creds = await getDbCredentials();
  logger.debug(` Step 1 - getDbCredentials: ${elapsed(credStart)}`);
  
  // Step 2: Create client
  const clientCreateStart = Date.now();
  const client = new Client({
    host: RDS_HOST,
    port: RDS_PORT,
    database: DB_NAME,
    user: creds.username,
    password: creds.password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000  // 10초로 명시 (기본 무한대 방지)
  });
  logger.debug(` Step 2 - Client created: ${elapsed(clientCreateStart)}`);
  logger.debug(`   -> Host: ${RDS_HOST}`);
  logger.debug(`   -> User: ${creds.username}`);
  
  try {
    // Step 3: Connect
    const connectStart = Date.now();
    logger.debug(` Step 3 - Connecting to RDS...`);
    await client.connect();
    logger.debug(` Step 3 - Connected: ${elapsed(connectStart)}`);
    
    // Step 4: Query
    // [High Fix #3] 쿼리 최적화: 서브쿼리로 최신 N개 선택 후 ASC 정렬 (클라이언트 재정렬 제거)
    // 권장 인덱스: CREATE INDEX idx_candle_history_symbol_interval_time
    //             ON candle_history(symbol, interval, time_epoch DESC);
    const queryStart = Date.now();
    const query = `
      SELECT time_epoch, open, high, low, close, volume
      FROM (
        SELECT time_epoch, open, high, low, close, volume
        FROM candle_history
        WHERE symbol = $1 AND interval = $2
        ORDER BY time_epoch DESC
        LIMIT $3
      ) sub
      ORDER BY time_epoch ASC
    `;
    logger.debug(` Step 4 - Executing query...`);
    const result = await client.query(query, [symbol, interval, limit]);
    logger.debug(` Step 4 - Query done: ${elapsed(queryStart)} (${result.rows.length} rows)`);

    // Step 5: Transform (정렬은 쿼리에서 완료)
    const transformStart = Date.now();
    const candles = result.rows.map(row => ({
      time: parseInt(row.time_epoch),
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseFloat(row.volume) || 0
    }));
    logger.debug(` Step 5 - Transform: ${elapsed(transformStart)}`);
    
    logger.debug(` getCandles TOTAL: ${elapsed(funcStart)}`);
    return candles;
    
  } finally {
    // Step 6: Disconnect
    const endStart = Date.now();
    await client.end();
    logger.debug(` Step 6 - Disconnect: ${elapsed(endStart)}`);
  }
}
