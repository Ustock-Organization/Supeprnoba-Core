// Streaming Server - Main/Sub 분리 브로드캐스트
// Main 구독자 → depth (호가 전체)
// Sub 구독자 → ticker (시세만)
// 로그인 사용자: 50ms, 비로그인: 500ms

import Redis from 'ioredis';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

// 환경변수
const VALKEY_HOST = process.env.VALKEY_HOST || 'localhost';
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT || '6379');
const VALKEY_TLS = process.env.VALKEY_TLS === 'true';
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT;
const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-2';
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

// 폴링 간격
const SLOW_POLL_MS = 500;   // 비로그인
const FAST_POLL_MS = 50;    // 로그인 (60fps 기준 3프레임)

function debug(...args) {
  if (DEBUG_MODE) console.log('[DEBUG]', ...args);
}

console.log('=== Streaming Server Configuration ===');
console.log(`Valkey: ${VALKEY_HOST}:${VALKEY_PORT} (TLS: ${VALKEY_TLS})`);
console.log(`WebSocket Endpoint: ${WEBSOCKET_ENDPOINT}`);
console.log(`Polling: slow=${SLOW_POLL_MS}ms, fast=${FAST_POLL_MS}ms`);

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

// 상태 추적
let prevSymbolCount = 0;
let prevMainCounts = new Map();
let prevSubCounts = new Map();

// 연결 ID로 메시지 전송
async function sendToConnection(connectionId, data) {
  try {
    await apiClient.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: typeof data === 'string' ? data : JSON.stringify(data),
    }));
    return true;
  } catch (error) {
    if (DEBUG_MODE) {
      console.error(`[ERROR] sendToConnection(${connectionId}):`, error.name);
    }
    
    if (error.$metadata?.httpStatusCode === 410) {
      // 연결 끊김 - 정리
      await cleanupConnection(connectionId);
    }
    return false;
  }
}

async function cleanupConnection(connectionId) {
  // Main 구독 정리
  const mainSymbol = await valkey.get(`conn:${connectionId}:main`);
  if (mainSymbol) {
    await valkey.srem(`symbol:${mainSymbol}:main`, connectionId);
    await valkey.del(`conn:${connectionId}:main`);
  }
  // 연결 정보 삭제
  await valkey.del(`ws:${connectionId}`);
  debug(`Cleaned stale connection: ${connectionId}`);
}

// 심볼별 브로드캐스트
async function broadcastSymbol(symbol) {
  // === Main 구독자 → depth 데이터 ===
  const mainSubs = await valkey.smembers(`symbol:${symbol}:main`);
  if (mainSubs.length > 0) {
    const depthJson = await valkey.get(`depth:${symbol}`);
    if (depthJson) {
      const results = await Promise.allSettled(
        mainSubs.map(connId => sendToConnection(connId, depthJson))
      );
      const sent = results.filter(r => r.status === 'fulfilled' && r.value).length;
      debug(`${symbol} main: ${sent}/${mainSubs.length} sent`);
    }
  }
  
  // === Sub 구독자 → ticker 데이터 ===
  const subSubs = await valkey.smembers(`symbol:${symbol}:sub`);
  if (subSubs.length > 0) {
    const tickerJson = await valkey.get(`ticker:${symbol}`);
    if (tickerJson) {
      const results = await Promise.allSettled(
        subSubs.map(connId => sendToConnection(connId, tickerJson))
      );
      const sent = results.filter(r => r.status === 'fulfilled' && r.value).length;
      debug(`${symbol} sub: ${sent}/${subSubs.length} sent`);
    }
  }
  
  // 구독자 수 변경 로그
  logSubscriberChanges(symbol, mainSubs.length, subSubs.length);
}

function logSubscriberChanges(symbol, mainCount, subCount) {
  const prevMain = prevMainCounts.get(symbol) || 0;
  const prevSub = prevSubCounts.get(symbol) || 0;
  
  if (mainCount !== prevMain) {
    console.log(`[INFO] ${symbol} main: ${prevMain} → ${mainCount}`);
    prevMainCounts.set(symbol, mainCount);
  }
  if (subCount !== prevSub) {
    console.log(`[INFO] ${symbol} sub: ${prevSub} → ${subCount}`);
    prevSubCounts.set(symbol, subCount);
  }
}

// 메인 푸시 루프 (비로그인용 500ms)
async function slowPushLoop() {
  while (true) {
    try {
      const activeSymbols = await valkey.smembers('active:symbols');
      
      if (activeSymbols.length !== prevSymbolCount) {
        console.log(`[INFO] Active symbols: ${prevSymbolCount} → ${activeSymbols.length}`);
        prevSymbolCount = activeSymbols.length;
      }
      
      for (const symbol of activeSymbols) {
        await broadcastSymbol(symbol);
      }
      
      // 제거된 심볼 정리
      for (const [symbol] of prevMainCounts) {
        if (!activeSymbols.includes(symbol)) {
          console.log(`[INFO] Symbol removed: ${symbol}`);
          prevMainCounts.delete(symbol);
          prevSubCounts.delete(symbol);
        }
      }
      
    } catch (error) {
      console.error('Slow loop error:', error.message);
    }
    
    await new Promise(resolve => setTimeout(resolve, SLOW_POLL_MS));
  }
}

// 빠른 푸시 루프 (로그인용 50ms) - 추후 로그인 체크 추가
async function fastPushLoop() {
  // TODO: 로그인 사용자 구분 후 활성화
  // 현재는 비활성화
  /*
  while (true) {
    try {
      const activeSymbols = await valkey.smembers('active:symbols');
      for (const symbol of activeSymbols) {
        // 로그인 사용자에게만 빠른 전송
        await broadcastToLoggedInUsers(symbol);
      }
    } catch (error) {
      console.error('Fast loop error:', error.message);
    }
    await new Promise(resolve => setTimeout(resolve, FAST_POLL_MS));
  }
  */
}

// 시작
console.log('Starting Streaming Server...');
slowPushLoop();
// fastPushLoop();  // 추후 활성화
console.log('Streaming Server running. Press Ctrl+C to stop.');
