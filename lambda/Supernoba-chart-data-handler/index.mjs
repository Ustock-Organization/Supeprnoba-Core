// chart-data-handler Lambda v3
// RDS PostgreSQL에서 캔들 데이터 조회
// DynamoDB 제거, Valkey 제거

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

// KST 변환 헬퍼
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function epochToYMDHM(epoch) {
  const kstMs = epoch * 1000 + KST_OFFSET_MS;
  const d = new Date(kstMs);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Secrets Manager 클라이언트
const secretsManager = new SecretsManagerClient({ region: AWS_REGION });

// RDS 자격 증명 캐시
let cachedCredentials = null;

async function getDbCredentials() {
  if (cachedCredentials) return cachedCredentials;
  
  if (!DB_SECRET_ARN) {
    return { username: 'postgres', password: '' };
  }
  
  try {
    const res = await secretsManager.send(new GetSecretValueCommand({ SecretId: DB_SECRET_ARN }));
    cachedCredentials = JSON.parse(res.SecretString);
    return cachedCredentials;
  } catch (err) {
    console.error('Failed to get DB credentials:', err);
    return { username: 'postgres', password: '' };
  }
}

export const handler = async (event) => {
  const params = event.queryStringParameters || {};
  const symbol = (params.symbol || 'TEST').toUpperCase();
  const interval = params.interval || '1m';
  const limit = Math.min(parseInt(params.limit || '100'), 500);
  
  console.log(`Chart request: ${symbol} ${interval} limit=${limit}`);
  
  try {
    const intervalSeconds = INTERVAL_SECONDS[interval];
    if (!intervalSeconds) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Invalid interval: ${interval}` }) };
    }
    
    // RDS에서 캔들 조회
    const candles = await getCandles(symbol, interval, limit);
    
    console.log(`Data: ${candles.length} candles`);
    
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ symbol, interval, data: candles })
    };
    
  } catch (error) {
    console.error('Chart data error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};

// RDS에서 캔들 조회
async function getCandles(symbol, interval, limit) {
  const creds = await getDbCredentials();
  
  const client = new Client({
    host: RDS_HOST,
    port: RDS_PORT,
    database: DB_NAME,
    user: creds.username,
    password: creds.password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000
  });
  
  try {
    await client.connect();
    
    const query = `
      SELECT time_epoch, time_ymdhm, open, high, low, close, volume
      FROM candle_history
      WHERE symbol = $1 AND interval = $2
      ORDER BY time_epoch DESC
      LIMIT $3
    `;
    
    const result = await client.query(query, [symbol, interval, limit]);
    
    // 오래된 순으로 정렬하여 반환
    const candles = result.rows.map(row => ({
      time: parseInt(row.time_epoch),
      time_ymdhm: row.time_ymdhm,
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseFloat(row.volume) || 0
    })).sort((a, b) => a.time - b.time);
    
    return candles;
    
  } finally {
    await client.end();
  }
}
