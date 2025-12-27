// chart-data-handler Lambda v3 (Debug)
// RDS PostgreSQL에서 캔들 데이터 조회 + 타이밍 디버그

import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;

// 환경변수
const RDS_HOST = process.env.RDS_ENDPOINT || 'supernoba-rdb1.cluster-cyxfcbnpfoci.ap-northeast-2.rds.amazonaws.com';
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

async function getDbCredentials() {
  const start = Date.now();
  console.log('[DEBUG] getDbCredentials START');
  
  // 환경 변수에서 직접 읽기 (우선순위 1)
  const envUsername = process.env.DB_USERNAME;
  const envPassword = process.env.DB_PASSWORD;
  
  if (envUsername && envPassword) {
    console.log(`[DEBUG] getDbCredentials FROM_ENV ${elapsed(start)}`);
    return { username: envUsername, password: envPassword };
  }
  
  // 캐시된 자격 증명 사용 (우선순위 2)
  if (cachedCredentials) {
    console.log(`[DEBUG] getDbCredentials CACHED ${elapsed(start)}`);
    return cachedCredentials;
  }
  
  // Secrets Manager에서 조회 (우선순위 3 - VPC 엔드포인트 필요)
  if (!DB_SECRET_ARN) {
    console.log(`[DEBUG] getDbCredentials NO_SECRET_ARN, using defaults ${elapsed(start)}`);
    return { username: 'postgres', password: '' };
  }
  
  try {
    console.log(`[DEBUG] Fetching secret from SecretsManager: ${DB_SECRET_ARN}`);
    const res = await secretsManager.send(new GetSecretValueCommand({ SecretId: DB_SECRET_ARN }));
    cachedCredentials = JSON.parse(res.SecretString);
    console.log(`[DEBUG] getDbCredentials SECRET_FETCHED ${elapsed(start)}`);
    return cachedCredentials;
  } catch (err) {
    console.error(`[DEBUG] getDbCredentials ERROR ${elapsed(start)}:`, err.message);
    return { username: 'postgres', password: '' };
  }
}

export const handler = async (event) => {
  const handlerStart = Date.now();
  console.log(`[DEBUG] ===== HANDLER START =====`);
  
  const params = event.queryStringParameters || {};
  const symbol = (params.symbol || 'TEST').toLowerCase();
  const interval = params.interval || '1m';
  const limit = Math.min(parseInt(params.limit || '100'), 500);
  
  console.log(`[DEBUG] Chart request: ${symbol} ${interval} limit=${limit}`);
  
  try {
    const intervalSeconds = INTERVAL_SECONDS[interval];
    if (!intervalSeconds) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Invalid interval: ${interval}` }) };
    }
    
    // RDS에서 캔들 조회
    const candles = await getCandles(symbol, interval, limit);
    
    console.log(`[DEBUG] Data: ${candles.length} candles`);
    console.log(`[DEBUG] ===== HANDLER END (TOTAL: ${elapsed(handlerStart)}) =====`);
    
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ symbol, interval, data: candles })
    };
    
  } catch (error) {
    console.error(`[DEBUG] HANDLER ERROR ${elapsed(handlerStart)}:`, error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};

// RDS에서 캔들 조회
async function getCandles(symbol, interval, limit) {
  const funcStart = Date.now();
  console.log(`[DEBUG] getCandles START`);
  
  // Step 1: Get credentials
  const credStart = Date.now();
  const creds = await getDbCredentials();
  console.log(`[DEBUG] Step 1 - getDbCredentials: ${elapsed(credStart)}`);
  
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
  console.log(`[DEBUG] Step 2 - Client created: ${elapsed(clientCreateStart)}`);
  console.log(`[DEBUG]   -> Host: ${RDS_HOST}`);
  console.log(`[DEBUG]   -> User: ${creds.username}`);
  
  try {
    // Step 3: Connect
    const connectStart = Date.now();
    console.log(`[DEBUG] Step 3 - Connecting to RDS...`);
    await client.connect();
    console.log(`[DEBUG] Step 3 - Connected: ${elapsed(connectStart)}`);
    
    // Step 4: Query
    const queryStart = Date.now();
    const query = `
      SELECT time_epoch, time_ymdhm, open, high, low, close, volume
      FROM candle_history
      WHERE symbol = $1 AND interval = $2
      ORDER BY time_epoch DESC
      LIMIT $3
    `;
    console.log(`[DEBUG] Step 4 - Executing query...`);
    const result = await client.query(query, [symbol, interval, limit]);
    console.log(`[DEBUG] Step 4 - Query done: ${elapsed(queryStart)} (${result.rows.length} rows)`);
    
    // Step 5: Transform
    const transformStart = Date.now();
    const candles = result.rows.map(row => ({
      time: parseInt(row.time_epoch),
      time_ymdhm: row.time_ymdhm,
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseFloat(row.volume) || 0
    })).sort((a, b) => a.time - b.time);
    console.log(`[DEBUG] Step 5 - Transform: ${elapsed(transformStart)}`);
    
    console.log(`[DEBUG] getCandles TOTAL: ${elapsed(funcStart)}`);
    return candles;
    
  } finally {
    // Step 6: Disconnect
    const endStart = Date.now();
    await client.end();
    console.log(`[DEBUG] Step 6 - Disconnect: ${elapsed(endStart)}`);
  }
}
