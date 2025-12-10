// Streaming Server - API Gateway WebSocket 푸시
// Valkey에서 depth 캐시를 읽어 구독자에게 브로드캐스트
// 0.5초마다 계속 푸시, 구독자/종목 변경 시에만 로그

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
const POLL_INTERVAL_MS = 500;

// 디버그 로그 함수
function debug(...args) {
  if (DEBUG_MODE) {
    console.log('[DEBUG]', ...args);
  }
}

console.log('=== Streaming Server Configuration ===');
console.log(`Valkey: ${VALKEY_HOST}:${VALKEY_PORT} (TLS: ${VALKEY_TLS})`);
console.log(`WebSocket Endpoint: ${WEBSOCKET_ENDPOINT}`);
console.log(`Debug Mode: ${DEBUG_MODE}`);

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

// 이전 상태 추적 (변경 로그용)
let prevSymbolCount = 0;
let prevSubscriberCounts = new Map();

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
      console.error(`[ERROR] sendToConnection(${connectionId}):`, error.name, error.message);
    }
    
    if (error.$metadata?.httpStatusCode === 410) {
      // 연결 끊김 - 정리
      const connInfo = await valkey.get(`ws:${connectionId}`);
      if (connInfo) {
        try {
          const { userId } = JSON.parse(connInfo);
          if (userId) {
            await valkey.srem(`user:${userId}:connections`, connectionId);
          }
        } catch (e) {}
      }
      await valkey.del(`ws:${connectionId}`);
      debug(`Removed stale connection: ${connectionId}`);
    }
    return false;
  }
}

// 심볼별 depth 브로드캐스트
async function broadcastDepth(symbol, subscribers) {
  const depthJson = await valkey.get(`depth:${symbol}`);
  if (!depthJson) return 0;

  const results = await Promise.allSettled(
    subscribers.map(connId => sendToConnection(connId, depthJson))
  );
  
  return results.filter(r => r.status === 'fulfilled' && r.value === true).length;
}

// 메인 푸시 루프
async function pushLoop() {
  while (true) {
    try {
      // 활성 심볼 목록 조회
      const activeSymbols = await valkey.smembers('active:symbols');
      
      // 종목 수 변경 감지
      if (activeSymbols.length !== prevSymbolCount) {
        console.log(`[INFO] Active symbols changed: ${prevSymbolCount} -> ${activeSymbols.length} (${activeSymbols.join(', ')})`);
        prevSymbolCount = activeSymbols.length;
      }
      
      for (const symbol of activeSymbols) {
        const subscribers = await valkey.smembers(`symbol:${symbol}:subscribers`);
        
        // 구독자 수 변경 감지
        const prevCount = prevSubscriberCounts.get(symbol) || 0;
        if (subscribers.length !== prevCount) {
          console.log(`[INFO] ${symbol} subscribers changed: ${prevCount} -> ${subscribers.length}`);
          prevSubscriberCounts.set(symbol, subscribers.length);
        }
        
        // 구독자가 있으면 항상 브로드캐스트 (0.5초마다)
        if (subscribers.length > 0) {
          const sent = await broadcastDepth(symbol, subscribers);
          debug(`${symbol}: ${sent}/${subscribers.length} sent`);
        }
      }
      
      // 제거된 종목 정리
      for (const [symbol] of prevSubscriberCounts) {
        if (!activeSymbols.includes(symbol)) {
          console.log(`[INFO] Symbol removed: ${symbol}`);
          prevSubscriberCounts.delete(symbol);
        }
      }
      
    } catch (error) {
      console.error('Push loop error:', error.message);
      if (DEBUG_MODE) {
        console.error(error.stack);
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// 메인 시작
console.log('Starting Streaming Server...');
pushLoop();
console.log('Streaming Server running. Press Ctrl+C to stop.');
