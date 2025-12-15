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
    })).sort((a, b) => a.time - b.time);  // 오래된 순으로 정렬
    
  } catch (error) {
    console.error(`DynamoDB query error for ${interval}:`, error);
    return [];
  }
}

// === 활성 캔들 계산 (Valkey 1분봉에서 현재 기간 집계) ===
async function computeActiveCandle(symbol, intervalSeconds) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const periodStart = Math.floor(now / intervalSeconds) * intervalSeconds;
    
    // 현재 기간 내의 마감된 1분봉 조회
    const closedList = await valkey.lrange(`candle:closed:1m:${symbol}`, 0, -1);
    const closedCandles = closedList
      .map(c => { try { return JSON.parse(c); } catch { return null; } })
      .filter(c => c !== null)
      .filter(c => parseInt(c.t) >= periodStart && parseInt(c.t) < periodStart + intervalSeconds)
      .map(c => ({
        t: parseInt(c.t),
        o: parseFloat(c.o),
        h: parseFloat(c.h),
        l: parseFloat(c.l),
        c: parseFloat(c.c),
        v: parseFloat(c.v) || 0
      }));
    
    // 현재 진행 중인 1분봉 조회
    const activeOneMin = await valkey.hgetall(`candle:1m:${symbol}`);
    
    // 병합
    const allCandles = [...closedCandles];
    if (activeOneMin && activeOneMin.t && parseInt(activeOneMin.t) >= periodStart) {
      allCandles.push({
        t: parseInt(activeOneMin.t),
        o: parseFloat(activeOneMin.o),
        h: parseFloat(activeOneMin.h),
        l: parseFloat(activeOneMin.l),
        c: parseFloat(activeOneMin.c),
        v: parseFloat(activeOneMin.v) || 0
      });
    }
    
    if (allCandles.length === 0) return null;
    
    // 시간순 정렬
    allCandles.sort((a, b) => a.t - b.t);
    
    // 집계
    return {
      time: periodStart,
      open: allCandles[0].o,                          // 첫 캔들의 시가
      high: Math.max(...allCandles.map(c => c.h)),    // 최고가
      low: Math.min(...allCandles.map(c => c.l)),     // 최저가
      close: allCandles[allCandles.length - 1].c,     // 마지막 캔들의 종가 (현재가!)
      volume: allCandles.reduce((sum, c) => sum + (c.v || 0), 0)
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
          time: parseInt(parsed.t),
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
      time: parseInt(candle.t),
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
  
  // 시간순 정렬
  return Array.from(timeMap.values()).sort((a, b) => a.time - b.time);
}

// === 상위 타임프레임 집계 ===
function aggregateCandles(oneMinCandles, intervalMinutes) {
  if (oneMinCandles.length === 0) return [];
  
  const result = [];
  
  for (let i = 0; i < oneMinCandles.length; i += intervalMinutes) {
    const group = oneMinCandles.slice(i, i + intervalMinutes);
    if (group.length === 0) continue;
    
    const startTime = Math.floor(group[0].time / (intervalMinutes * 60)) * (intervalMinutes * 60);
    
    let high = group[0].high;
    let low = group[0].low;
    let volume = 0;
    
    for (const c of group) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      volume += c.volume || 0;
    }
    
    result.push({
      time: startTime,
      open: group[0].open,
      high, low,
      close: group[group.length - 1].close,
      volume
    });
  }
  
  return result;
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
