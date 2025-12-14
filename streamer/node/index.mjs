// Streaming Server v3 - 로그인/익명 사용자 분류 지원
// 50ms: 로그인 사용자 (realtime:connections 기반)
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

const FAST_POLL_MS = 50;   // 로그인 사용자
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

// === 데이터 조회 ===
async function fetchSymbolData(symbol) {
  const [depthJson, tickerJson, candle] = await Promise.all([
    valkey.get(`depth:${symbol}`),
    valkey.get(`ticker:${symbol}`),
    valkey.hgetall(`candle:1m:${symbol}`),
  ]);
  
  // 캐시 갱신 (500ms용)
  if (depthJson) depthCache[symbol] = depthJson;
  if (tickerJson) tickerCache[symbol] = tickerJson;
  if (candle && candle.t) candleCache[symbol] = candle;
  
  return { depthJson, tickerJson, candle };
}

// === 봉 마감 체크 ===
async function checkCandleClose(symbol) {
  const closed = await valkey.lpop(`candle:closed:1m:${symbol}`);
  if (closed) {
    debug(`Candle closed: ${symbol}`);
    return JSON.parse(closed);
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
    // 50ms 폴링: 로그인 사용자만
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
      const candleMsg = JSON.stringify({ e: 'candle', tf: '1m', s: symbol, ...candle });
      tasks.push(...filteredMainSubs.map(id => sendToConnection(id, candleMsg)));
    }
    
    if (closedCandle) {
      const closeMsg = JSON.stringify({ e: 'candle_close', tf: '1m', s: symbol, ...closedCandle });
      tasks.push(...filteredMainSubs.map(id => sendToConnection(id, closeMsg)));
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

// === 50ms 폴링 (로그인 사용자) ===
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
        
        // 봉 마감 체크
        const closedCandle = await checkCandleClose(symbol);
        
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
