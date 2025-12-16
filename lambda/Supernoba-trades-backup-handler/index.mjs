// trades-backup-handler Lambda v3 - Trades Only
// 10분마다: trades:* → DynamoDB trade_history 백업
// 캔들 집계는 C++ Aggregator 서비스가 담당

import Redis from 'ioredis';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const VALKEY_HOST = process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com';
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT || '6379');
const VALKEY_TLS = process.env.VALKEY_TLS === 'true';
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

const debug = (...args) => { if (DEBUG_MODE) console.log(...args); };

console.log('[INIT] trades-backup-handler v3 (trades only) starting...');
console.log(`[INIT] DEBUG_MODE: ${DEBUG_MODE}`);

const valkey = new Redis({
  host: VALKEY_HOST,
  port: VALKEY_PORT,
  tls: VALKEY_TLS ? {} : undefined,
  maxRetriesPerRequest: 1,
  connectTimeout: 5000,
  commandTimeout: 10000,
});

valkey.on('connect', () => console.log('[REDIS] Connected to Valkey'));
valkey.on('error', (err) => console.error('[REDIS] Connection error:', err.message));

const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' })
);

const DYNAMODB_TRADE_TABLE = process.env.DYNAMODB_TRADE_TABLE || 'trade_history';

// === 재시도 헬퍼 함수 ===
async function withRetry(operation, operationName, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      console.error(`[ERROR] ${operationName} attempt ${attempt}/${maxRetries}:`, error.message);
      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

// === 메인 핸들러 ===
export const handler = async (event) => {
  console.log('[HANDLER] Lambda invoked');
  debug('[HANDLER] Event:', JSON.stringify(event));
  
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = now.toISOString().slice(11, 16).replace(':', '');
  console.log(`[HANDLER] Backup started: ${dateStr} ${timeStr}`);
  
  const results = {
    trades: { count: 0, symbols: [] }
  };
  
  try {
    // Valkey 연결 확인
    console.log('[REDIS] Checking connection...');
    const pingResult = await valkey.ping();
    console.log(`[REDIS] Ping result: ${pingResult}`);
    
    // === 체결 백업 ===
    const tradeKeys = await valkey.keys('trades:*');
    console.log(`[TRADE] Found ${tradeKeys.length} symbols with trades`);
    
    const BATCH_SIZE = 25;  // DynamoDB 배치 제한
    
    for (const key of tradeKeys) {
      const symbol = key.replace('trades:', '');
      debug(`[TRADE] Processing symbol: ${symbol}`);
      
      // 체결 데이터 조회
      const tradeData = await valkey.lrange(key, 0, -1);
      if (!tradeData || tradeData.length === 0) continue;
      
      console.log(`[TRADE] ${symbol}: Found ${tradeData.length} trades`);
      
      // JSON 파싱
      const trades = tradeData
        .map(t => { try { return JSON.parse(t); } catch { return null; } })
        .filter(t => t !== null);
      
      if (trades.length === 0) continue;
      
      // DynamoDB 배치 저장
      let savedCount = 0;
      for (let i = 0; i < trades.length; i += BATCH_SIZE) {
        const batch = trades.slice(i, i + BATCH_SIZE);
        
        const writeRequests = batch.map(trade => ({
          PutRequest: {
            Item: {
              pk: `TRADE#${symbol}#${dateStr}`,
              sk: `${trade.timestamp || Date.now()}`,
              symbol,
              price: trade.price,
              quantity: trade.quantity,
              buyer_id: trade.buyer_id || 'unknown',
              seller_id: trade.seller_id || 'unknown',
              timestamp: trade.timestamp || Date.now()
            }
          }
        }));
        
        try {
          await withRetry(
            () => dynamodb.send(new BatchWriteCommand({
              RequestItems: { [DYNAMODB_TRADE_TABLE]: writeRequests }
            })),
            `DynamoDB batch ${symbol}`
          );
          savedCount += batch.length;
        } catch (err) {
          console.error(`[TRADE] ${symbol}: Batch write failed - ${err.message}`);
        }
      }
      
      if (savedCount > 0) {
        // 백업 완료 후 Valkey에서 삭제
        await valkey.del(key);
        console.log(`[TRADE] ${symbol}: Saved ${savedCount} trades, cleared from Valkey`);
        results.trades.count += savedCount;
        results.trades.symbols.push({ symbol, count: savedCount });
      }
    }
    
    console.log(`[COMPLETE] Trades backed up: ${results.trades.count}`);
    console.log('[NOTE] Candle aggregation is handled by C++ Aggregator service');
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Trades backup completed',
        results
      })
    };
    
  } catch (error) {
    console.error('[ERROR] Backup failed:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
