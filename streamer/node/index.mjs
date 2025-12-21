// Streaming Server v3 - 로그인/익명 사용자 분류 지원
// 100ms: 로그인 사용자 (realtime:connections 기반)
// 500ms: 익명 사용자

import Redis from 'ioredis';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

// 환경변수
const VALKEY_HOST = process.env.VALKEY_HOST || 'localhost';
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT || '6379');
const VALKEY_TLS = process.env.VALKEY_TLS === 'true';
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT;
const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-2';
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

const FAST_POLL_MS = 100;  // 로그인 사용자
const SLOW_POLL_MS = 500;  // 익명 사용자

function debug(...args) {
  if (DEBUG_MODE) console.log('[DEBUG]', ...args);
}

console.log('=== Streaming Server v3 ===');
console.log(`Valkey: ${VALKEY_HOST}:${VALKEY_PORT}`);
console.log(`Polling: ${FAST_POLL_MS}ms (logged-in) / ${SLOW_POLL_MS}ms (anonymous)`);

// Valkey 연결
const valkey = new Redis({
  host: VALKEY_HOST,
  port: VALKEY_PORT,
  tls: VALKEY_TLS ? {} : undefined,
  connectTimeout: 5000,
  lazyConnect: false,
});

valkey.on('error', (err) => console.error('Redis error:', err.message));
valkey.on('connect', () => console.log('Connected to Valkey'));

// API Gateway 클라이언트
const apiClient = new ApiGatewayManagementApiClient({
  endpoint: `https://${WEBSOCKET_ENDPOINT}`,
  region: AWS_REGION,
});

// === 캐시 (500ms용) ===
let depthCache = {};    // symbol -> depthJson
let tickerCache = {};   // symbol -> tickerJson
let candleCache = {};   // symbol -> candleData

// 상태 추적
let prevSymbolCount = 0;
let prevRealtimeCount = 0;
let prevCandleData = {};  // symbol -> 이전 캔들 데이터 (봉마감 감지용)

// === 유틸리티 ===
async function sendToConnection(connectionId, data) {
  try {
    await apiClient.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: typeof data === 'string' ? data : JSON.stringify(data),
    }));
    return true;
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 410) {
      await cleanupConnection(connectionId);
    }
    return false;
  }
}

async function cleanupConnection(connectionId) {
  const mainSymbol = await valkey.get(`conn:${connectionId}:main`);
  if (mainSymbol) {
    await valkey.srem(`symbol:${mainSymbol}:main`, connectionId);
    await valkey.srem(`symbol:${mainSymbol}:subscribers`, connectionId);
    await valkey.del(`conn:${connectionId}:main`);
  }
  await valkey.srem('realtime:connections', connectionId);
  await valkey.del(`ws:${connectionId}`);
  debug(`Cleaned stale connection: ${connectionId}`);
}

// === 연결 유형 확인 ===
async function isRealtimeConnection(connectionId) {
  return await valkey.sismember('realtime:connections', connectionId);
}

// === YYYYMMDDHHmm → epoch 변환 (KST → UTC) ===
function ymdhmToEpoch(ymdhm) {
  if (!ymdhm || ymdhm.length !== 12) return null;
  
  const y = parseInt(ymdhm.slice(0, 4));
  const m = parseInt(ymdhm.slice(4, 6)) - 1;
  const d = parseInt(ymdhm.slice(6, 8));
  const h = parseInt(ymdhm.slice(8, 10));
  const min = parseInt(ymdhm.slice(10, 12));
  
  // KST 시간을 UTC epoch으로 변환
  // Date.UTC()는 주어진 시간을 UTC로 해석하므로,
  // KST 시간을 UTC로 잘못 해석한 후 9시간을 빼서 올바른 UTC 시간을 얻음
  // 예: KST 2025-12-17 17:00 → Date.UTC는 UTC 17:00로 해석 → 9시간 빼면 UTC 08:00 (정확)
  const utcMs = Date.UTC(y, m, d, h, min, 0, 0) - (9 * 60 * 60 * 1000);
  return Math.floor(utcMs / 1000);
}

// === 데이터 조회 ===
async function fetchSymbolData(symbol) {
  const [depthJson, tickerJson, candle] = await Promise.all([
    valkey.get(`depth:${symbol}`),
    valkey.get(`ticker:${symbol}`),
    valkey.hgetall(`candle:1m:${symbol}`),
  ]);
  
  // 캔들 데이터에 epoch 추가 (t_epoch가 없으면 t에서 변환)
  if (candle && candle.t) {
    // t_epoch가 있으면 사용, 없으면 t에서 변환
    if (!candle.t_epoch && candle.t) {
      candle.t_epoch = ymdhmToEpoch(candle.t);
    }
    // 숫자로 변환
    if (candle.t_epoch) {
      candle.t_epoch = parseInt(candle.t_epoch);
    }
    candleCache[symbol] = candle;
  }
  
  // 캐시 갱신 (500ms용)
  if (depthJson) depthCache[symbol] = depthJson;
  if (tickerJson) tickerCache[symbol] = tickerJson;
  
  return { depthJson, tickerJson, candle };
}

// === 봉 마감 감지 (t 값 변화로 감지, LPOP 사용 안 함) ===
function detectCandleClose(symbol, currentCandle) {
  if (!currentCandle || !currentCandle.t) return null;
  
  const prevCandle = prevCandleData[symbol];
  
  // 이전 캔들이 있고, t 값이 다르면 = 분이 바뀜 = 이전 봉 마감!
  if (prevCandle && prevCandle.t && prevCandle.t !== currentCandle.t) {
    debug(`Candle closed: ${symbol} t=${prevCandle.t} -> ${currentCandle.t}`);
    const closedCandle = { ...prevCandle };  // 복사본 반환
    // epoch도 포함
    if (!closedCandle.t_epoch && closedCandle.t) {
      closedCandle.t_epoch = ymdhmToEpoch(closedCandle.t);
    }
    prevCandleData[symbol] = { ...currentCandle };  // 현재 캔들 저장
    return closedCandle;
  }
  
  // 이전 캔들 없으면 현재 캔들 저장
  if (!prevCandle) {
    prevCandleData[symbol] = { ...currentCandle };
  }
  
  return null;
}

// === 브로드캐스트 (연결 유형별 필터링) ===
async function broadcastToSubscribers(symbol, mainSubs, subSubs, data, realtimeOnly = false) {
  const { depthJson, tickerJson, candle, closedCandle, fromCache } = data;
  
  // 로그인/익명 필터링
  let filteredMainSubs = mainSubs;
  let filteredSubSubs = subSubs;
  
  if (realtimeOnly) {
    // 100ms 폴링: 로그인 사용자만
    const realtimeSet = await valkey.smembers('realtime:connections');
    const realtimeCheck = new Set(realtimeSet);
    filteredMainSubs = mainSubs.filter(id => realtimeCheck.has(id));
    filteredSubSubs = subSubs.filter(id => realtimeCheck.has(id));
  } else {
    // 500ms 폴링: 익명 사용자만
    const realtimeSet = await valkey.smembers('realtime:connections');
    const realtimeCheck = new Set(realtimeSet);
    filteredMainSubs = mainSubs.filter(id => !realtimeCheck.has(id));
    filteredSubSubs = subSubs.filter(id => !realtimeCheck.has(id));
  }
  
  // Main 구독자 → depth + candle
  if (filteredMainSubs.length > 0) {
    const tasks = [];
    
    if (depthJson) {
      tasks.push(...filteredMainSubs.map(id => sendToConnection(id, depthJson)));
    }
    
    if (candle && candle.t) {
      // Convert Redis string values to numbers and validate
      const o = parseFloat(candle.o);
      const h = parseFloat(candle.h);
      const l = parseFloat(candle.l);
      const c = parseFloat(candle.c);
      const v = parseInt(candle.v) || 0;
      
      // Only send if all OHLC values are valid numbers (not NaN)
      if (!isNaN(o) && !isNaN(h) && !isNaN(l) && !isNaN(c) && o > 0) {
        const candleMsg = JSON.stringify({ 
          e: 'candle', 
          tf: '1m', 
          s: symbol,
          o: o,
          h: h,
          l: l,
          c: c,
          v: v,
          t: candle.t,           // YYYYMMDDHHmm (사람이 읽기 쉬운 형식)
          t_epoch: candle.t_epoch || ymdhmToEpoch(candle.t)  // epoch (초, UTC 기준)
        });
        tasks.push(...filteredMainSubs.map(id => sendToConnection(id, candleMsg)));
      } else {
        debug(`Skipping invalid candle for ${symbol}: o=${candle.o} h=${candle.h} l=${candle.l} c=${candle.c}`);
      }
    }
    
    if (closedCandle) {
      // Convert Redis string values to numbers and validate
      const o = parseFloat(closedCandle.o);
      const h = parseFloat(closedCandle.h);
      const l = parseFloat(closedCandle.l);
      const c = parseFloat(closedCandle.c);
      const v = parseInt(closedCandle.v) || 0;
      
      if (!isNaN(o) && !isNaN(h) && !isNaN(l) && !isNaN(c) && o > 0) {
        const closedEpoch = closedCandle.t_epoch || ymdhmToEpoch(closedCandle.t);
        const closeMsg = JSON.stringify({ 
          e: 'candle_close', 
          tf: '1m', 
          s: symbol,
          o: o,
          h: h,
          l: l,
          c: c,
          v: v,
          t: closedCandle.t,
          t_epoch: closedEpoch
        });
        tasks.push(...filteredMainSubs.map(id => sendToConnection(id, closeMsg)));
      }
    }
    
    await Promise.allSettled(tasks);
    debug(`${symbol} sent to ${filteredMainSubs.length} ${realtimeOnly ? 'realtime' : 'anonymous'} main subs`);
  }
  
  // Sub 구독자 → ticker only
  if (filteredSubSubs.length > 0 && tickerJson) {
    await Promise.allSettled(
      filteredSubSubs.map(id => sendToConnection(id, tickerJson))
    );
    debug(`${symbol} ticker sent to ${filteredSubSubs.length} ${realtimeOnly ? 'realtime' : 'anonymous'} subs`);
  }
}

// === 100ms 폴링 (로그인 사용자) ===
async function fastPollLoop() {
  while (true) {
    try {
      const activeSymbols = await valkey.smembers('subscribed:symbols');
      const realtimeConns = await valkey.scard('realtime:connections');
      
      if (activeSymbols.length !== prevSymbolCount) {
        console.log(`[INFO] Active symbols: ${prevSymbolCount} → ${activeSymbols.length}`);
        prevSymbolCount = activeSymbols.length;
      }
      
      if (realtimeConns !== prevRealtimeCount) {
        console.log(`[INFO] Realtime connections: ${prevRealtimeCount} → ${realtimeConns}`);
        prevRealtimeCount = realtimeConns;
      }
      
      for (const symbol of activeSymbols) {
        // 구독자 조회
        const [mainSubs, subSubs, legacySubs] = await Promise.all([
          valkey.smembers(`symbol:${symbol}:main`),
          valkey.smembers(`symbol:${symbol}:sub`),
          valkey.smembers(`symbol:${symbol}:subscribers`),
        ]);
        
        const allMain = [...new Set([...mainSubs, ...legacySubs])];
        if (allMain.length === 0 && subSubs.length === 0) continue;
        
        // 데이터 조회 (캐시도 갱신)
        const { depthJson, tickerJson, candle } = await fetchSymbolData(symbol);
        
        // 봉 마감 감지 (t 값 변화로 감지 - LPOP 없음)
        const closedCandle = detectCandleClose(symbol, candle);
        
        // 로그인 사용자에게만 브로드캐스트
        await broadcastToSubscribers(symbol, allMain, subSubs, {
          depthJson, tickerJson, candle, closedCandle
        }, true);  // realtimeOnly = true
      }
    } catch (error) {
      console.error('Fast poll error:', error.message);
    }
    
    await new Promise(resolve => setTimeout(resolve, FAST_POLL_MS));
  }
}

// === 500ms 폴링 (익명 사용자 - 캐시 사용) ===
async function slowPollLoop() {
  while (true) {
    try {
      const activeSymbols = await valkey.smembers('subscribed:symbols');
      
      for (const symbol of activeSymbols) {
        // 구독자 조회
        const [mainSubs, subSubs, legacySubs] = await Promise.all([
          valkey.smembers(`symbol:${symbol}:main`),
          valkey.smembers(`symbol:${symbol}:sub`),
          valkey.smembers(`symbol:${symbol}:subscribers`),
        ]);
        
        const allMain = [...new Set([...mainSubs, ...legacySubs])];
        if (allMain.length === 0 && subSubs.length === 0) continue;
        
        // 캐시된 데이터 사용 (Valkey 조회 없음)
        const depthJson = depthCache[symbol];
        const tickerJson = tickerCache[symbol];
        const candle = candleCache[symbol];
        
        if (!depthJson && !tickerJson) continue;
        
        // 익명 사용자에게만 브로드캐스트
        await broadcastToSubscribers(symbol, allMain, subSubs, {
          depthJson, tickerJson, candle, closedCandle: null, fromCache: true
        }, false);  // realtimeOnly = false
      }
    } catch (error) {
      console.error('Slow poll error:', error.message);
    }
    
    await new Promise(resolve => setTimeout(resolve, SLOW_POLL_MS));
  }
}

// === 시작 ===
console.log('Starting Streaming Server v3...');
fastPollLoop();
slowPollLoop();  // 익명 사용자용 활성화
console.log('Streaming Server running. Press Ctrl+C to stop.');
