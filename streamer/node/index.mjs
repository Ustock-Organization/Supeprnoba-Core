// Streaming Server - API Gateway WebSocket 푸시
// Valkey에서 depth 캐시를 읽어 구독자에게 브로드캐스트

import Redis from 'ioredis';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

// 환경변수
const VALKEY_HOST = process.env.VALKEY_HOST || 'localhost';
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT || '6379');
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT;
const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-2';

// 푸시 간격 (ms)
const PUBLIC_INTERVAL_MS = 500;   // 비로그인: 0.5초
const PRIVATE_INTERVAL_MS = 50;   // 로그인: ~50ms (60Hz 근사)

console.log('=== Streaming Server Configuration ===');
console.log(`Valkey: ${VALKEY_HOST}:${VALKEY_PORT}`);
console.log(`WebSocket Endpoint: ${WEBSOCKET_ENDPOINT}`);
console.log(`Public Interval: ${PUBLIC_INTERVAL_MS}ms`);
console.log(`Private Interval: ${PRIVATE_INTERVAL_MS}ms`);

// Valkey 연결
const valkey = new Redis({
  host: VALKEY_HOST,
  port: VALKEY_PORT,
  tls: VALKEY_HOST !== 'localhost' ? {} : undefined,
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

// 연결 ID로 메시지 전송
async function sendToConnection(connectionId, data) {
  try {
    await apiClient.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: typeof data === 'string' ? data : JSON.stringify(data),
    }));
    return true;
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 410) {
      // 연결 끊김 - 정리
      const connInfo = await valkey.get(`ws:${connectionId}`);
      if (connInfo) {
        const { userId } = JSON.parse(connInfo);
        if (userId) {
          await valkey.srem(`user:${userId}:connections`, connectionId);
        }
      }
      await valkey.del(`ws:${connectionId}`);
      console.log(`Removed stale connection: ${connectionId}`);
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

// 비로그인 사용자 푸시 루프 (500ms)
async function publicPushLoop() {
  while (true) {
    try {
      // 활성 심볼 목록 조회 (KEYS 대신 SET 사용 - Serverless 호환)
      const activeSymbols = await valkey.smembers('active:symbols');
      
      for (const symbol of activeSymbols) {
        const subscribers = await valkey.smembers(`symbol:${symbol}:subscribers`);
        
        if (subscribers.length > 0) {
          const sent = await broadcastDepth(symbol, subscribers);
          if (sent > 0) {
            console.log(`[PUBLIC] ${symbol}: ${sent}/${subscribers.length} sent`);
          }
        }
      }
    } catch (error) {
      console.error('Public push error:', error.message);
    }
    
    await new Promise(resolve => setTimeout(resolve, PUBLIC_INTERVAL_MS));
  }
}

// 로그인 사용자 푸시 루프 (50ms) - 추후 구현
async function privatePushLoop() {
  while (true) {
    try {
      // TODO: 로그인 사용자용 빠른 푸시
      // user:{userId}:subscriptions에서 심볼 조회
      // depth 전송
      
    } catch (error) {
      console.error('Private push error:', error.message);
    }
    
    await new Promise(resolve => setTimeout(resolve, PRIVATE_INTERVAL_MS));
  }
}

// 메인 시작
console.log('Starting Streaming Server...');

// 비로그인 푸시 루프 시작
publicPushLoop();

// 로그인 푸시 루프 시작 (추후 활성화)
// privatePushLoop();

console.log('Streaming Server running. Press Ctrl+C to stop.');
