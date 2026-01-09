// Streaming Server - 단순화 버전
// 핵심 기능: WebSocket을 통한 depth/ticker/candle 브로드캐스트

import Redis from 'ioredis';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

// 환경변수
const VALKEY_HOST = process.env.VALKEY_HOST || 'localhost';
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT || '6379');
const VALKEY_TLS = process.env.VALKEY_TLS === 'true';
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT;
const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-2';

const POLL_MS = 200;  // 브로드캐스트 주기

console.log('=== Streaming Server (Simplified) ===');
console.log(`Valkey: ${VALKEY_HOST}:${VALKEY_PORT}`);

// Valkey 연결
const valkey = new Redis({
  host: VALKEY_HOST,
  port: VALKEY_PORT,
  tls: VALKEY_TLS ? {} : undefined,
  connectTimeout: 5000,
});

valkey.on('error', (err) => console.error('Redis error:', err.message));
valkey.on('connect', () => console.log('Connected to Valkey'));

// API Gateway 클라이언트
const apiClient = new ApiGatewayManagementApiClient({
  endpoint: `https://${WEBSOCKET_ENDPOINT}`,
  region: AWS_REGION,
});

// === 유틸리티 ===
let lastLogTime = 0;
let successCount = 0;
let errorCount = 0;

async function sendToConnection(connectionId, data) {
  try {
    await apiClient.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: typeof data === 'string' ? data : JSON.stringify(data),
    }));
    successCount++;
    // 5초마다 상태 로그
    const now = Date.now();
    if (now - lastLogTime > 5000) {
      console.log(`[Send] Success: ${successCount}, Errors: ${errorCount}`);
      lastLogTime = now;
      successCount = 0;
      errorCount = 0;
    }
    return true;
  } catch (error) {
    errorCount++;
    const statusCode = error.$metadata?.httpStatusCode;
    if (statusCode === 410) {
      console.log(`[Send] 410 Gone - cleaning up ${connectionId}`);
      await cleanupConnection(connectionId);
    } else if (statusCode === 403) {
      console.error(`[Send] 403 Forbidden for ${connectionId}: ${error.message}`);
    } else {
      console.error(`[Send] Error ${statusCode} for ${connectionId}: ${error.message}`);
    }
    return false;
  }
}

async function cleanupConnection(connectionId) {
  // Main 구독 정리 (conn:*:main 키 기반)
  const mainSymbol = await valkey.get(`conn:${connectionId}:main`);
  if (mainSymbol) {
    await valkey.srem(`symbol:${mainSymbol}:main`, connectionId);
    await valkey.srem(`symbol:${mainSymbol}:subscribers`, connectionId); // 레거시 호환
    await valkey.del(`conn:${connectionId}:main`);
  }

  // Sub 구독 정리 (SCAN 기반)
  const subscribedSymbols = await valkey.smembers('subscribed:symbols');
  for (const symbol of subscribedSymbols) {
    await valkey.srem(`symbol:${symbol}:sub`, connectionId);
    await valkey.srem(`symbol:${symbol}:subscribers`, connectionId); // 레거시 호환
  }

  // realtime:connections 제거됨 - 더 이상 사용하지 않음
  await valkey.del(`ws:${connectionId}`);
}

// === 메인 브로드캐스트 루프 ===
async function broadcastLoop() {
  console.log('[Broadcast] Starting broadcast loop...');

  while (true) {
    try {
      // 구독 중인 심볼 목록 가져오기
      const subscribedSymbols = await valkey.smembers('subscribed:symbols');

      if (subscribedSymbols.length > 0) {
        // 각 심볼에 대해 데이터 브로드캐스트
        await Promise.all(subscribedSymbols.map(symbol => broadcastSymbolData(symbol)));
      }

      await new Promise(r => setTimeout(r, POLL_MS));
    } catch (err) {
      console.error('[Broadcast] Loop error:', err.message);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function broadcastSymbolData(symbol) {
  try {
    // Main 구독자 (depth + ticker + candle)
    const mainConnections = await valkey.smembers(`symbol:${symbol}:main`);

    // Sub 구독자 (ticker만) - sub 키 사용 (subscribers는 Main+Sub 전체)
    const subConnections = await valkey.smembers(`symbol:${symbol}:sub`);

    if (mainConnections.length === 0 && subConnections.length === 0) return;

    // Valkey에서 데이터 가져오기
    const [depthJson, tickerJson, candleData] = await Promise.all([
      valkey.get(`depth:${symbol}`),
      valkey.get(`ticker:${symbol}`),
      valkey.hgetall(`candle:1m:${symbol}`)
    ]);

    // ticker 파싱 (Main, Sub 모두에게 전송)
    const tickerData = tickerJson ? JSON.parse(tickerJson) : null;

    // Main 구독자에게 depth + ticker + candle 전송
    if (mainConnections.length > 0) {
      // Depth 전송
      if (depthJson) {
        const depthData = JSON.parse(depthJson);
        await Promise.all(mainConnections.map(connId => sendToConnection(connId, depthData)));
      }

      // Ticker 전송 (가격 정보는 ticker에서만)
      if (tickerData) {
        await Promise.all(mainConnections.map(connId => sendToConnection(connId, tickerData)));
      }

      // Candle 전송
      if (candleData && candleData.t) {
        const candle = {
          e: 'candle',
          s: symbol,
          t: candleData.t,
          t_epoch: ymdhmToEpoch(candleData.t),
          o: parseFloat(candleData.o) || 0,
          h: parseFloat(candleData.h) || 0,
          l: parseFloat(candleData.l) || 0,
          c: parseFloat(candleData.c) || 0,
          v: parseInt(candleData.v) || 0
        };
        await Promise.all(mainConnections.map(connId => sendToConnection(connId, candle)));
      }
    }

    // Sub 구독자에게 ticker 전송
    if (subConnections.length > 0 && tickerData) {
      await Promise.all(subConnections.map(connId => sendToConnection(connId, tickerData)));
    }
  } catch (err) {
    console.error(`[Broadcast] Error for ${symbol}:`, err.message);
  }
}

// YYYYMMDDHHmm -> epoch 변환
function ymdhmToEpoch(ymdhm) {
  if (!ymdhm || ymdhm.length !== 12) return null;
  const y = parseInt(ymdhm.slice(0, 4));
  const mo = parseInt(ymdhm.slice(4, 6)) - 1;
  const d = parseInt(ymdhm.slice(6, 8));
  const h = parseInt(ymdhm.slice(8, 10));
  const m = parseInt(ymdhm.slice(10, 12));
  // KST -> UTC
  const kstDate = new Date(y, mo, d, h, m, 0);
  return Math.floor(kstDate.getTime() / 1000) - 9 * 3600;
}

// === 시작 ===
console.log('Starting Streaming Server...');
broadcastLoop().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
