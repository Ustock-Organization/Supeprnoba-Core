// Streaming Server - 단순화 버전
// 핵심 기능: WebSocket을 통한 depth/ticker/candle 브로드캐스트
// + Admin WebSocket을 통한 MM 상태 Pub/Sub 전달

import Redis from 'ioredis';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

// 환경변수
const VALKEY_HOST = process.env.VALKEY_HOST || 'localhost';
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT || '6379');
const VALKEY_TLS = process.env.VALKEY_TLS === 'true';
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT;
const ADMIN_WEBSOCKET_ENDPOINT = process.env.ADMIN_WEBSOCKET_ENDPOINT || '2qlrv92731.execute-api.ap-northeast-2.amazonaws.com/admin';
const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-2';
const BACKUP_CACHE_HOST = process.env.BACKUP_CACHE_HOST || 'master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com';

const POLL_MS = 200;  // 브로드캐스트 주기
let lastMMDataHash = '';  // MM 데이터 변경 감지용
let isShuttingDown = false;  // 종료 플래그
const intervalHandles = [];  // 인터벌 핸들 저장 (cleanup용)

console.log('=== Streaming Server (Simplified) ===');
console.log(`Valkey: ${VALKEY_HOST}:${VALKEY_PORT}`);
console.log(`Backup Cache: ${BACKUP_CACHE_HOST}`);

// Valkey 연결 (메인 데이터 캐시)
const valkey = new Redis({
  host: VALKEY_HOST,
  port: VALKEY_PORT,
  tls: VALKEY_TLS ? { rejectUnauthorized: false } : undefined,
  connectTimeout: 5000,
});

valkey.on('error', (err) => console.error('Redis error:', err.message));
valkey.on('connect', () => console.log('Connected to Valkey'));

// Backup Cache 연결 (어드민 연결 목록 조회용) - AWS ElastiCache는 항상 TLS 필요
const backupCache = new Redis({
  host: BACKUP_CACHE_HOST,
  port: VALKEY_PORT,
  tls: {},  // AWS ElastiCache는 TLS 필수
  connectTimeout: 5000,
});

backupCache.on('error', (err) => console.error('BackupCache error:', err.message));
backupCache.on('connect', () => console.log('Connected to Backup Cache'));

// Backup Cache Pub/Sub 연결 (MM 상태 구독용) - 별도 연결 필요
const backupCacheSub = new Redis({
  host: BACKUP_CACHE_HOST,
  port: VALKEY_PORT,
  tls: {},  // AWS ElastiCache는 TLS 필수
  connectTimeout: 5000,
});

backupCacheSub.on('error', (err) => console.error('BackupCache Sub error:', err.message));
backupCacheSub.on('connect', () => console.log('Connected to Backup Cache (Pub/Sub)'));

// API Gateway 클라이언트 (일반 사용자)
const apiClient = new ApiGatewayManagementApiClient({
  endpoint: `https://${WEBSOCKET_ENDPOINT}`,
  region: AWS_REGION,
});

// API Gateway 클라이언트 (어드민)
const adminApiClient = new ApiGatewayManagementApiClient({
  endpoint: `https://${ADMIN_WEBSOCKET_ENDPOINT}`,
  region: AWS_REGION,
});

// 어드민 연결 목록 (메모리 관리)
const adminConnections = new Set();

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

// 어드민에게 메시지 전송
async function sendToAdmin(connectionId, data) {
  try {
    await adminApiClient.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: typeof data === 'string' ? data : JSON.stringify(data),
    }));
    return true;
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 410) {
      // 연결 끊어짐
      adminConnections.delete(connectionId);
      await backupCache.srem('admin:connections', connectionId);
    }
    return false;
  }
}

// 모든 어드민에게 브로드캐스트
async function broadcastToAdmins(data) {
  if (adminConnections.size === 0) {
    return;
  }

  const results = await Promise.allSettled(
    Array.from(adminConnections).map(connId => sendToAdmin(connId, data))
  );

  // 성공/실패 카운트
  let successCount = 0;
  const connections = Array.from(adminConnections);
  results.forEach((result, idx) => {
    if (result.status === 'fulfilled' && result.value) {
      successCount++;
    } else {
      adminConnections.delete(connections[idx]);
    }
  });

  // 주기적 로그 (10초에 한 번)
  if (!broadcastToAdmins.lastLog || Date.now() - broadcastToAdmins.lastLog > 10000) {
    console.log(`[Admin Broadcast] Sent to ${successCount}/${connections.length} admins`);
    broadcastToAdmins.lastLog = Date.now();
  }
}

// === 메인 브로드캐스트 루프 ===
async function broadcastLoop() {
  console.log('[Broadcast] Starting broadcast loop...');

  while (!isShuttingDown) {
    try {
      // 구독 중인 심볼 목록 가져오기
      const subscribedSymbols = await valkey.smembers('subscribed:symbols');

      if (subscribedSymbols.length > 0) {
        // 각 심볼에 대해 데이터 브로드캐스트
        await Promise.all(subscribedSymbols.map(symbol => broadcastSymbolData(symbol)));
      }

      await new Promise(r => setTimeout(r, POLL_MS));
    } catch (err) {
      if (isShuttingDown) break;
      console.error('[Broadcast] Loop error:', err.message);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log('[Broadcast] Loop terminated');
}

async function broadcastSymbolData(symbol) {
  try {
    // Main 구독자 (depth + ticker + candle)
    const mainConnections = await valkey.smembers(`symbol:${symbol}:main`);

    // Sub 구독자 (ticker만) - :sub 키는 ticker-only 구독자용
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

// === MM 상태 Pub/Sub 구독 ===
async function subscribeMMStatus() {
  console.log('[MM Pub/Sub] Subscribing to mm:status channel...');

  backupCacheSub.subscribe('mm:status', (err) => {
    if (err) {
      console.error('[MM Pub/Sub] Subscribe error:', err.message);
    } else {
      console.log('[MM Pub/Sub] Subscribed to mm:status');
    }
  });
}

// === 랭킹 Pub/Sub 구독 ===
async function subscribeRankings() {
  console.log('[Rankings Pub/Sub] Subscribing to rankings:broadcast channel...');

  backupCacheSub.subscribe('rankings:broadcast', (err) => {
    if (err) {
      console.error('[Rankings Pub/Sub] Subscribe error:', err.message);
    } else {
      console.log('[Rankings Pub/Sub] Subscribed to rankings:broadcast');
    }
  });
}

// === Pub/Sub 메시지 핸들러 ===
function setupPubSubHandlers() {
  backupCacheSub.on('message', async (channel, message) => {
    if (channel === 'mm:status') {
      try {
        const rawData = JSON.parse(message);
        console.log('[MM Raw] symbols count:', rawData.symbols?.length, 'running:', rawData.running);

        // 빈 symbols 배열은 무시 (깜빡임 방지)
        if (!rawData.symbols || rawData.symbols.length === 0) {
          console.log('[MM Status] Ignoring empty symbols message');
          return;
        }

        // 각 심볼의 실제 체결가(ohlc.c) 조회
        const symbolsWithPrice = await Promise.all(
          (rawData.symbols || []).map(async (s) => {
            const ohlcJson = await valkey.get(`ohlc:${s.symbol}`);
            const ohlc = ohlcJson ? JSON.parse(ohlcJson) : null;

            return {
              symbol: s.symbol,
              base_price: s.basePrice,
              current_price: ohlc?.c || s.price,  // 실제 체결가 우선
              mm_target_price: s.price,  // MM 목표가 (참고용)
              order_count: s.orders,
              is_running: s.isRunning,
              weekly_amplitude: s.config?.weeklyAmplitude || 0.15,
              daily_amplitude: s.config?.dailyAmplitude || 0.08,
              hourly_amplitude: s.config?.hourlyAmplitude || 0.04,
              minute_amplitude: s.config?.minuteAmplitude || 0.02,
              noise_amplitude: s.config?.noiseAmplitude || 0.005,
              tick_interval: s.config?.tickInterval || 1000,
              volume: ohlc?.v || 0,
              high: ohlc?.h || null,
              low: ohlc?.l || null,
            };
          })
        );

        const formattedData = {
          type: 'mm_status',  // mm_data와 구분: 실시간 상태 업데이트용
          data: {
            running: rawData.running,
            timestamp: rawData.timestamp,
            symbols: symbolsWithPrice
          }
        };

        // 데이터가 변경되었을 때만 브로드캐스트 (깜빡임 방지)
        const dataHash = JSON.stringify(symbolsWithPrice.map(s =>
          `${s.symbol}:${s.is_running}:${s.base_price}:${Math.round(s.current_price || 0)}`
        ));
        if (dataHash !== lastMMDataHash) {
          console.log('[MM Hash] Changed:', dataHash.substring(0, 100));
          lastMMDataHash = dataHash;
          await broadcastToAdmins(formattedData);
        }
      } catch (err) {
        console.error('[MM Pub/Sub] Message parse error:', err.message);
      }
    } else if (channel === 'rankings:broadcast') {
      // 랭킹 브로드캐스트 (10초 주기, C++ RankingManager에서 발행)
      try {
        const rankingsData = JSON.parse(message);
        const formattedData = {
          type: 'rankings',
          data: rankingsData
        };

        // 어드민에게만 브로드캐스트 (클라이언트는 API로 조회)
        await broadcastToAdmins(formattedData);
        console.log('[Rankings] Broadcast to admins:', adminConnections.size, 'connections');
      } catch (err) {
        console.error('[Rankings Pub/Sub] Message parse error:', err.message);
      }
    }
  });
}

// === 어드민 연결 동기화 (Backup Cache에서 읽어오기) ===
async function syncAdminConnections() {
  try {
    const connections = await backupCache.smembers('admin:connections');
    // 메모리 세트 업데이트
    const oldSize = adminConnections.size;
    adminConnections.clear();
    connections.forEach(conn => adminConnections.add(conn));
    if (adminConnections.size !== oldSize) {
      console.log(`[Admin Sync] Updated: ${adminConnections.size} connections`);
    }
  } catch (err) {
    console.error('[Admin Sync] Error:', err.message);
  }
}

// === 시작 ===
console.log('Starting Streaming Server...');

// 어드민 연결 동기화 시작 (1초 간격)
intervalHandles.push(setInterval(syncAdminConnections, 1000));
syncAdminConnections();

// Pub/Sub 메시지 핸들러 설정
setupPubSubHandlers();

// MM 상태 Pub/Sub 구독
subscribeMMStatus();

// 랭킹 Pub/Sub 구독
subscribeRankings();

// 메인 브로드캐스트 루프
broadcastLoop().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

// === Graceful Shutdown ===
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[Shutdown] Received ${signal}, cleaning up...`);

  // 인터벌 정리
  intervalHandles.forEach(handle => clearInterval(handle));
  console.log(`[Shutdown] Cleared ${intervalHandles.length} intervals`);

  // Redis 연결 종료
  try {
    await Promise.allSettled([
      valkey.quit(),
      backupCache.quit(),
      backupCacheSub.quit()
    ]);
    console.log('[Shutdown] Redis connections closed');
  } catch (err) {
    console.error('[Shutdown] Error closing Redis:', err.message);
  }

  console.log('[Shutdown] Cleanup complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// === Uncaught Exception/Rejection Handlers ===
process.on('uncaughtException', (err, origin) => {
  console.error(`[FATAL] Uncaught Exception at ${origin}:`, err);
  console.error('[FATAL] Stack:', err.stack);
  // 로그가 기록될 시간을 주고 종료
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise);
  console.error('[FATAL] Reason:', reason);
  // 계속 실행하되 로그 기록 (치명적이지 않은 경우 대비)
});
