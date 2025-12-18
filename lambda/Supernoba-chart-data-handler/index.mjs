// chart-data-handler Lambda v2
// Hot/Cold 하이브리드 조회 - Valkey(최근) + DynamoDB(과거)
// 백업 갭 처리: 10분 미만 데이터는 Valkey candle:closed:* 에서 조회

// import Redis from 'ioredis'; // Redis 제거 (CORS Crash 방지)
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { QueryCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const VALKEY_TLS = process.env.VALKEY_TLS === 'true';

// Valkey 제거: 배포 패키지 문제(node_modules 누락)로 인한 크래시 방지
// const valkey = new Redis({ ... });

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

// === YYYYMMDDHHmm ↔ epoch 변환 헬퍼 (KST 기준) ===
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;  // 9시간 (밀리초)

function ymdhmToEpoch(ymdhm) {
  // ymdhm은 KST 시간 문자열: "202512171230" = 2025-12-17 12:30 KST
  const y = parseInt(ymdhm.slice(0, 4));
  const m = parseInt(ymdhm.slice(4, 6)) - 1;
  const d = parseInt(ymdhm.slice(6, 8));
  const h = parseInt(ymdhm.slice(8, 10));
  const min = parseInt(ymdhm.slice(10, 12));
  
  // Date.UTC로 UTC 시간 생성 후 KST 오프셋 적용
  // KST 12:30 = UTC 03:30 → UTC 밀리초에서 9시간 빼기
  const utcMs = Date.UTC(y, m, d, h, min, 0, 0) - KST_OFFSET_MS;
  return Math.floor(utcMs / 1000);
}

function epochToYMDHM(epoch) {
  // epoch (UTC) → KST 시간 문자열
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
    
    return result.Items.map(item => {
      const timeStr = item.time || item.sk;  // YYYYMMDDHHmm 형식
      const epoch = ymdhmToEpoch(timeStr);  // epoch으로 변환
      return {
        time: epoch,  // epoch (초, UTC 기준) - 클라이언트가 우선 사용
        time_ymdhm: timeStr,  // YYYYMMDDHHmm (사람이 읽기 쉬운 형식)
        open: parseFloat(item.open || item.o),
        high: parseFloat(item.high || item.h),
        low: parseFloat(item.low || item.l),
        close: parseFloat(item.close || item.c),
        volume: parseFloat(item.volume || item.v) || 0
      };
    }).sort((a, b) => a.time - b.time);  // 숫자 비교로 오래된 순 정렬
    
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
    
    // 1. Valkey 제거 (DynamoDB만 사용)
    /*
    const closedList = await valkey.lrange(`candle:closed:1m:${symbol}`, 0, -1);
    const valkeyClosedCandles = closedList...
    */
    const valkeyClosedCandles = []; // 빈 배열 처리
    
    // 2. DynamoDB에서 현재 기간 1분봉 조회
    let dbCandles = [];
    // 항상 DynamoDB 조회 시도
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
        
        dbCandles = (result.Items || []).map(item => {
          const timeStr = item.time || item.sk;
          const epoch = ymdhmToEpoch(timeStr);
          return {
            time: epoch,
            time_ymdhm: timeStr,
            o: parseFloat(item.open || item.o),
            h: parseFloat(item.high || item.h),
            l: parseFloat(item.low || item.l),
            c: parseFloat(item.close || item.c),
            v: parseFloat(item.volume || item.v) || 0
          };
        });
    } catch (dbErr) {
        console.warn(`[ACTIVE] DynamoDB 1m query failed: ${dbErr.message}`);
    }
    
    // 3. 현재 진행 중인 1분봉 조회 (Valkey 제거 -> null)
    const activeOneMin = null; 
    
    // 4. 모든 소스 병합
    const allCandles = [...dbCandles];
    
    const candleMap = new Map();
    for (const c of allCandles) {
        candleMap.set(c.time, c);
    }
    
    // 현재 진행 중인 1분봉 추가
    if (activeOneMin && activeOneMin.t && activeOneMin.t >= periodStartYMDHM) {
      const activeEpoch = activeOneMin.t_epoch ? parseInt(activeOneMin.t_epoch) : ymdhmToEpoch(activeOneMin.t);
      candleMap.set(activeEpoch, {
        time: activeEpoch,  // epoch (초, UTC 기준)
        time_ymdhm: activeOneMin.t,  // YYYYMMDDHHmm
        o: parseFloat(activeOneMin.o),
        h: parseFloat(activeOneMin.h),
        l: parseFloat(activeOneMin.l),
        c: parseFloat(activeOneMin.c),
        v: parseFloat(activeOneMin.v) || 0
      });
    }
    
    const mergedCandles = Array.from(candleMap.values());
    
    if (mergedCandles.length === 0) return null;
    
    // 시간순 정렬 (숫자 비교)
    mergedCandles.sort((a, b) => a.time - b.time);
    
    // 집계 - epoch과 ymdhm 둘 다 반환
    return {
      time: periodStartEpoch,  // epoch 타임스탬프 (초, UTC 기준)
      time_ymdhm: periodStartYMDHM,  // YYYYMMDDHHmm (사람이 읽기 쉬운 형식)
      open: mergedCandles[0].o,
      high: Math.max(...mergedCandles.map(c => c.h)),
      low: Math.min(...mergedCandles.map(c => c.l)),
      close: mergedCandles[mergedCandles.length - 1].c,
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
          time: ymdhmToEpoch(parsed.t),  // epoch으로 변환
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
    
    const epoch = candle.t_epoch ? parseInt(candle.t_epoch) : ymdhmToEpoch(candle.t);
    return {
      time: epoch,  // epoch (초, UTC 기준)
      time_ymdhm: candle.t,  // YYYYMMDDHHmm
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
    
    return result.Items.map(item => {
      const timeStr = item.time || item.sk;
      const epoch = ymdhmToEpoch(timeStr);
      return {
        time: epoch,  // epoch (초, UTC 기준)
        time_ymdhm: timeStr,  // YYYYMMDDHHmm
        open: parseFloat(item.open || item.o),
        high: parseFloat(item.high || item.h),
        low: parseFloat(item.low || item.l),
        close: parseFloat(item.close || item.c),
        volume: parseFloat(item.volume || item.v) || 0
      };
    }).sort((a, b) => a.time - b.time);
    
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
  
  // 시간순 정렬 (숫자 비교 - epoch)
  return Array.from(timeMap.values()).sort((a, b) => a.time - b.time);
}

// === 상위 타임프레임 집계 (epoch 형식) ===
function aggregateCandles(oneMinCandles, intervalMinutes) {
  if (oneMinCandles.length === 0) return [];
  
  const grouped = new Map();
  const intervalSeconds = intervalMinutes * 60;
  
  // 정렬 먼저 (epoch 숫자 비교)
  const sorted = [...oneMinCandles].sort((a, b) => a.time - b.time);
  
  for (const c of sorted) {
    // epoch을 interval에 맞춰 정렬
    const alignedEpoch = Math.floor(c.time / intervalSeconds) * intervalSeconds;
    
    if (!grouped.has(alignedEpoch)) {
      grouped.set(alignedEpoch, {
        time: alignedEpoch,  // epoch (초, UTC 기준)
        time_ymdhm: epochToYMDHM(alignedEpoch),  // YYYYMMDDHHmm
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 0
      });
    } else {
      const existing = grouped.get(alignedEpoch);
      if (c.high > existing.high) existing.high = c.high;
      if (c.low < existing.low) existing.low = c.low;
      existing.close = c.close;
      existing.volume += c.volume || 0;
    }
  }
  
  return Array.from(grouped.values()).sort((a, b) => a.time - b.time);
}

// === 포맷 ===
function formatCandle(candle) {
  return {
    time: candle.time,  // epoch (초, UTC 기준) - 클라이언트가 우선 사용
    time_ymdhm: candle.time_ymdhm || epochToYMDHM(candle.time),  // YYYYMMDDHHmm (사람이 읽기 쉬운 형식)
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume || 0,
    ...(candle.active && { active: true })
  };
}
