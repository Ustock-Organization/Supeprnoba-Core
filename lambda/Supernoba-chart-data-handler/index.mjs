// chart-data-handler Lambda v2
// Hot/Cold 하이브리드 조회 - Valkey(최근) + DynamoDB(과거)
// 백업 갭 처리: 10분 미만 데이터는 Valkey candle:closed:* 에서 조회

import Redis from 'ioredis';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { QueryCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const VALKEY_TLS = process.env.VALKEY_TLS === 'true';

const valkey = new Redis({
  host: process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com',
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  tls: VALKEY_TLS ? {} : undefined,
  maxRetriesPerRequest: 1,
});

const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' })
);

const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE || 'candle_history';
const HOT_DATA_TTL_MS = 10 * 60 * 1000; // 10분

// 타임프레임별 초 수 (9개 지원)
const INTERVAL_SECONDS = {
  '1m': 60, '3m': 180, '5m': 300, '10m': 600,
  '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, 
  '1d': 86400, '1w': 604800
};

// === YYYYMMDDHHmm ↔ epoch 변환 헬퍼 ===
function ymdhmToEpoch(ymdhm) {
  const y = parseInt(ymdhm.slice(0, 4));
  const m = parseInt(ymdhm.slice(4, 6)) - 1;
  const d = parseInt(ymdhm.slice(6, 8));
  const h = parseInt(ymdhm.slice(8, 10));
  const min = parseInt(ymdhm.slice(10, 12));
  return Math.floor(new Date(y, m, d, h, min).getTime() / 1000);
}

function epochToYMDHM(epoch) {
  const d = new Date(epoch * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
}

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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
    
    // === 1. 완료된 캔들 조회 (DynamoDB) ===
    const completedCandles = await getCompletedCandles(symbol, interval, limit);
    
    // === 2. 활성 캔들 계산 (Valkey 1분봉에서) ===
    const activeCandle = await computeActiveCandle(symbol, intervalSeconds);
    
    // === 3. 병합 ===
    const allCandles = [...completedCandles];
    if (activeCandle) {
      allCandles.push({ ...activeCandle, active: true });
    }
    
    console.log(`Data: completed=${completedCandles.length}, active=${activeCandle ? 1 : 0}`);
    
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ symbol, interval, data: allCandles.map(formatCandle) })
    };
    
  } catch (error) {
    console.error('Chart data error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};

// === 완료된 캔들 조회 (DynamoDB에서 사전 집계된 데이터) ===
async function getCompletedCandles(symbol, interval, limit) {
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: DYNAMODB_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `CANDLE#${symbol}#${interval}` },
      ScanIndexForward: false,  // 최신순
      Limit: limit
    }));
    
    if (!result.Items || result.Items.length === 0) return [];
    
    return result.Items.map(item => ({
      time: item.time || item.sk,
      open: item.open || item.o,
      high: item.high || item.h,
      low: item.low || item.l,
      close: item.close || item.c,
      volume: item.volume || item.v || 0
    })).sort((a, b) => a.time.localeCompare(b.time));  // 문자열 비교로 오래된 순 정렬
    
  } catch (error) {
    console.error(`DynamoDB query error for ${interval}:`, error);
    return [];
  }
}

// === 활성 캔들 계산 (Valkey + DynamoDB 1분봉에서 현재 기간 집계) ===
// 백업 후 Valkey closed 리스트가 비어있을 수 있으므로 DynamoDB도 확인
async function computeActiveCandle(symbol, intervalSeconds) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const periodStartEpoch = Math.floor(now / intervalSeconds) * intervalSeconds;
    const periodStartYMDHM = epochToYMDHM(periodStartEpoch);
    const periodEndEpoch = periodStartEpoch + intervalSeconds;
    const periodEndYMDHM = epochToYMDHM(periodEndEpoch);
    
    // 1. Valkey에서 마감된 1분봉 조회 (최근 데이터) - YYYYMMDDHHmm 형식
    const closedList = await valkey.lrange(`candle:closed:1m:${symbol}`, 0, -1);
    const valkeyClosedCandles = closedList
      .map(c => { try { return JSON.parse(c); } catch { return null; } })
      .filter(c => c !== null)
      .filter(c => c.t >= periodStartYMDHM && c.t < periodEndYMDHM)  // 문자열 비교
      .map(c => ({
        t: c.t,  // YYYYMMDDHHmm 문자열 유지
        o: parseFloat(c.o),
        h: parseFloat(c.h),
        l: parseFloat(c.l),
        c: parseFloat(c.c),
        v: parseFloat(c.v) || 0
      }));
    
    // 2. DynamoDB에서 현재 기간 1분봉 조회 (백업된 데이터 - Valkey 비었을 때 대비)
    let dbCandles = [];
    if (valkeyClosedCandles.length === 0) {
      // Valkey가 비어있으면 DynamoDB에서 1분봉 조회
      try {
        const result = await dynamodb.send(new QueryCommand({
          TableName: DYNAMODB_TABLE,
          KeyConditionExpression: 'pk = :pk AND sk BETWEEN :start AND :end',
          ExpressionAttributeValues: {
            ':pk': `CANDLE#${symbol}#1m`,
            ':start': periodStartYMDHM,
            ':end': periodEndYMDHM
          }
        }));
        
        dbCandles = (result.Items || []).map(item => ({
          t: item.time || item.sk,  // YYYYMMDDHHmm 문자열
          o: parseFloat(item.open || item.o),
          h: parseFloat(item.high || item.h),
          l: parseFloat(item.low || item.l),
          c: parseFloat(item.close || item.c),
          v: parseFloat(item.volume || item.v) || 0
        }));
        
        if (dbCandles.length > 0) {
          console.log(`[ACTIVE] Using ${dbCandles.length} 1m candles from DynamoDB for ${symbol}`);
        }
      } catch (dbErr) {
        console.warn(`[ACTIVE] DynamoDB 1m query failed: ${dbErr.message}`);
      }
    }
    
    // 3. 현재 진행 중인 1분봉 조회 (Valkey) - YYYYMMDDHHmm 형식
    const activeOneMin = await valkey.hgetall(`candle:1m:${symbol}`);
    
    // 4. 모든 소스 병합
    const allCandles = [...valkeyClosedCandles, ...dbCandles];
    
    // 중복 제거 (같은 시간의 캔들은 Valkey 우선)
    const candleMap = new Map();
    for (const c of allCandles) {
      if (!candleMap.has(c.t)) {
        candleMap.set(c.t, c);
      }
    }
    
    // 현재 진행 중인 1분봉 추가 (YYYYMMDDHHmm 형식)
    if (activeOneMin && activeOneMin.t && activeOneMin.t >= periodStartYMDHM) {
      candleMap.set(activeOneMin.t, {
        t: activeOneMin.t,
        o: parseFloat(activeOneMin.o),
        h: parseFloat(activeOneMin.h),
        l: parseFloat(activeOneMin.l),
        c: parseFloat(activeOneMin.c),
        v: parseFloat(activeOneMin.v) || 0
      });
    }
    
    const mergedCandles = Array.from(candleMap.values());
    
    if (mergedCandles.length === 0) return null;
    
    // 시간순 정렬 (문자열 비교)
    mergedCandles.sort((a, b) => a.t.localeCompare(b.t));
    
    // 집계
    return {
      time: periodStartYMDHM,  // YYYYMMDDHHmm 문자열
      open: mergedCandles[0].o,                          // 첫 캔들의 시가
      high: Math.max(...mergedCandles.map(c => c.h)),    // 최고가
      low: Math.min(...mergedCandles.map(c => c.l)),     // 최저가
      close: mergedCandles[mergedCandles.length - 1].c,  // 마지막 캔들의 종가 (현재가!)
      volume: mergedCandles.reduce((sum, c) => sum + (c.v || 0), 0)
    };
    
  } catch (error) {
    console.error('Active candle computation error:', error);
    return null;
  }
}

// === Hot 데이터: Valkey candle:closed:* ===
async function getHotCandles(symbol) {
  try {
    const closedList = await valkey.lrange(`candle:closed:1m:${symbol}`, 0, -1);
    
    return closedList.map(item => {
      try {
        const parsed = JSON.parse(item);
        return {
          time: parsed.t,  // YYYYMMDDHHmm 문자열 유지
          open: parseFloat(parsed.o),
          high: parseFloat(parsed.h),
          low: parseFloat(parsed.l),
          close: parseFloat(parsed.c),
          volume: parseFloat(parsed.v) || 0
        };
      } catch (e) {
        return null;
      }
    }).filter(c => c !== null);
    
  } catch (error) {
    console.error('Valkey hot candles error:', error.message);
    return [];
  }
}

// === 활성 캔들: Valkey candle:1m:* ===
async function getActiveCandle(symbol) {
  try {
    const candle = await valkey.hgetall(`candle:1m:${symbol}`);
    
    if (!candle || !candle.t) return null;
    
    return {
      time: candle.t,  // YYYYMMDDHHmm 문자열 유지
      open: parseFloat(candle.o),
      high: parseFloat(candle.h),
      low: parseFloat(candle.l),
      close: parseFloat(candle.c),
      volume: parseFloat(candle.v) || 0,
      active: true  // 진행 중 표시
    };
    
  } catch (error) {
    console.error('Valkey active candle error:', error.message);
    return null;
  }
}

// === Cold 데이터: DynamoDB ===
async function getColdCandles(symbol, limit) {
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: DYNAMODB_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `CANDLE#${symbol}#1m` },
      ScanIndexForward: false,
      Limit: limit
    }));
    
    if (!result.Items || result.Items.length === 0) return [];
    
    return result.Items.map(item => ({
      time: item.time || item.sk,
      open: item.open || item.o,
      high: item.high || item.h,
      low: item.low || item.l,
      close: item.close || item.c,
      volume: item.volume || item.v || 0
    })).sort((a, b) => a.time - b.time);
    
  } catch (error) {
    console.error('DynamoDB query error:', error);
    return [];
  }
}

// === 병합 및 중복 제거 ===
function mergeCandles(cold, hot, active) {
  const timeMap = new Map();
  
  // Cold 먼저 (오래된 데이터)
  for (const c of cold) {
    timeMap.set(c.time, c);
  }
  
  // Hot으로 덮어쓰기 (최신 데이터)
  for (const c of hot) {
    timeMap.set(c.time, c);
  }
  
  // 활성 캔들 추가
  if (active) {
    timeMap.set(active.time, active);
  }
  
  // 시간순 정렬 (문자열 비교)
  return Array.from(timeMap.values()).sort((a, b) => a.time.localeCompare(b.time));
}

// === 상위 타임프레임 집계 (YYYYMMDDHHmm 형식 지원) ===
function aggregateCandles(oneMinCandles, intervalMinutes) {
  if (oneMinCandles.length === 0) return [];
  
  const grouped = new Map();
  const intervalSeconds = intervalMinutes * 60;
  
  // 정렬 먼저
  const sorted = [...oneMinCandles].sort((a, b) => a.time.localeCompare(b.time));
  
  for (const c of sorted) {
    // YYYYMMDDHHmm → epoch → 정렬 → 다시 YMDHM
    const epoch = ymdhmToEpoch(c.time);
    const alignedEpoch = Math.floor(epoch / intervalSeconds) * intervalSeconds;
    const alignedYMDHM = epochToYMDHM(alignedEpoch);
    
    if (!grouped.has(alignedYMDHM)) {
      grouped.set(alignedYMDHM, {
        time: alignedYMDHM,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 0
      });
    } else {
      const existing = grouped.get(alignedYMDHM);
      if (c.high > existing.high) existing.high = c.high;
      if (c.low < existing.low) existing.low = c.low;
      existing.close = c.close;
      existing.volume += c.volume || 0;
    }
  }
  
  return Array.from(grouped.values()).sort((a, b) => a.time.localeCompare(b.time));
}

// === 포맷 ===
function formatCandle(candle) {
  return {
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume || 0,
    ...(candle.active && { active: true })
  };
}
