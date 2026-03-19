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
const ADMIN_WEBSOCKET_ENDPOINT = process.env.ADMIN_WEBSOCKET_ENDPOINT || 'sa1arlclz4.execute-api.ap-northeast-2.amazonaws.com/production';
const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-2';
const BACKUP_CACHE_HOST = process.env.BACKUP_CACHE_HOST || 'master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com';
const DEPTH_CACHE_HOST = process.env.DEPTH_CACHE_HOST || VALKEY_HOST;
const DEPTH_CACHE_PORT = parseInt(process.env.DEPTH_CACHE_PORT || '6379');
const CANDLE_CACHE_HOST = process.env.CANDLE_CACHE_HOST || VALKEY_HOST;
const CANDLE_CACHE_PORT = parseInt(process.env.CANDLE_CACHE_PORT || '6380');
const OPERATING_CACHE_HOST = process.env.OPERATING_CACHE_HOST || VALKEY_HOST;
const OPERATING_CACHE_PORT = parseInt(process.env.OPERATING_CACHE_PORT || '6382');
const BACKUP_CACHE_PORT = parseInt(process.env.BACKUP_CACHE_PORT || '6381');

const POLL_MS_AUTH = 200;  // 인증 사용자 브로드캐스트 주기
const POLL_MS_ANON = 500;  // 익명 사용자 브로드캐스트 주기
let lastMMDataHash = '';  // MM 데이터 변경 감지용
let isShuttingDown = false;  // 종료 플래그
const intervalHandles = [];  // 인터벌 핸들 저장 (cleanup용)

console.log('=== Streaming Server (Simplified) ===');
console.log(`Depth Cache: ${DEPTH_CACHE_HOST}:${DEPTH_CACHE_PORT}`);
console.log(`Candle Cache: ${CANDLE_CACHE_HOST}:${CANDLE_CACHE_PORT}`);
console.log(`Operating Cache: ${OPERATING_CACHE_HOST}:${OPERATING_CACHE_PORT}`);
console.log(`Backup Cache: ${BACKUP_CACHE_HOST}:${BACKUP_CACHE_PORT}`);

// Redis 재연결 전략 (exponential backoff)
const retryStrategy = (times) => {
  if (times > 100) {
    console.error(`[Redis] Max retries (${times}) reached, giving up`);
    return null; // 재연결 포기
  }
  const delay = Math.min(times * 100, 3000); // 최대 3초
  console.log(`[Redis] Reconnecting in ${delay}ms (attempt ${times})`);
  return delay;
};

// Depth Cache - depth, ticker, ohlc, prev reads (port 6379)
const depthClient = new Redis({
  host: DEPTH_CACHE_HOST,
  port: DEPTH_CACHE_PORT,
  tls: VALKEY_TLS ? { rejectUnauthorized: false } : undefined,
  connectTimeout: 5000,
  retryStrategy,
  maxRetriesPerRequest: null,
  enableOfflineQueue: true,
});
depthClient.on('error', (err) => console.error('[DepthCache] Error:', err.message));
depthClient.on('connect', () => console.log('[DepthCache] Connected'));

// Candle Cache - candle:1m reads (port 6380)
const candleClient = new Redis({
  host: CANDLE_CACHE_HOST,
  port: CANDLE_CACHE_PORT,
  tls: VALKEY_TLS ? { rejectUnauthorized: false } : undefined,
  connectTimeout: 5000,
  retryStrategy,
  maxRetriesPerRequest: null,
  enableOfflineQueue: true,
});
candleClient.on('error', (err) => console.error('[CandleCache] Error:', err.message));
candleClient.on('connect', () => console.log('[CandleCache] Connected'));

// Operating Cache - ws, conn, symbol, subscribed, admin:connections R/W (port 6382)
const operatingClient = new Redis({
  host: OPERATING_CACHE_HOST,
  port: OPERATING_CACHE_PORT,
  tls: VALKEY_TLS ? { rejectUnauthorized: false } : undefined,
  connectTimeout: 5000,
  retryStrategy,
  maxRetriesPerRequest: null,
  enableOfflineQueue: true,
});
operatingClient.on('error', (err) => console.error('[OperatingCache] Error:', err.message));
operatingClient.on('connect', () => console.log('[OperatingCache] Connected'));

// Operating Cache Pub/Sub - mm:status, admin:events (port 6382, dedicated sub connection)
const operatingSub = new Redis({
  host: OPERATING_CACHE_HOST,
  port: OPERATING_CACHE_PORT,
  tls: VALKEY_TLS ? { rejectUnauthorized: false } : undefined,
  connectTimeout: 5000,
  retryStrategy,
  maxRetriesPerRequest: null,
  enableOfflineQueue: true,
});
operatingSub.on('error', (err) => console.error('[OperatingCache Sub] Error:', err.message));
operatingSub.on('connect', () => console.log('[OperatingCache Sub] Connected'));

// Backup Cache Pub/Sub - rankings:broadcast only (port 6381)
const backupSub = new Redis({
  host: BACKUP_CACHE_HOST,
  port: BACKUP_CACHE_PORT,
  tls: VALKEY_TLS ? { rejectUnauthorized: false } : undefined,
  connectTimeout: 5000,
  retryStrategy,
  maxRetriesPerRequest: null,
  enableOfflineQueue: true,
});
backupSub.on('error', (err) => console.error('[BackupCache Sub] Error:', err.message));
backupSub.on('connect', () => console.log('[BackupCache Sub] Connected'));

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

// === 연결 분류 (인증/익명) ===
async function classifyConnections(connectionIds) {
  if (connectionIds.length === 0) return { auth: [], anon: [] };

  // Pipeline으로 일괄 조회 (1 RTT) — ws:* keys live in operating cache
  const pipeline = operatingClient.pipeline();
  connectionIds.forEach(id => pipeline.get(`ws:${id}`));
  const results = await pipeline.exec();

  const auth = [];
  const anon = [];
  results.forEach(([err, val], i) => {
    if (err || !val) {
      anon.push(connectionIds[i]);
      return;
    }
    try {
      const info = JSON.parse(val);
      (info.isLoggedIn ? auth : anon).push(connectionIds[i]);
    } catch {
      anon.push(connectionIds[i]);
    }
  });
  return { auth, anon };
}

// === 유틸리티 ===
async function sendToConnection(connectionId, data) {
  try {
    await apiClient.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: typeof data === 'string' ? data : JSON.stringify(data),
    }));
    return true;
  } catch (error) {
    const statusCode = error.$metadata?.httpStatusCode;
    if (statusCode === 410) {
      await cleanupConnection(connectionId);
    } else {
      console.error(`[SendToConn] Error ${statusCode}: ${error.message} (conn=${connectionId})`);
    }
    return false;
  }
}

async function cleanupConnection(connectionId) {
  try {
    // ws 정보에서 userId 추출
    const wsData = await operatingClient.get(`ws:${connectionId}`);
    if (wsData) {
      try {
        const info = JSON.parse(wsData);
        if (info.userId) {
          await operatingClient.srem(`user:${info.userId}:connections`, connectionId);
        }
      } catch {}
    }

    // 구독 심볼 목록에서 제거
    const symbols = await operatingClient.smembers('subscribed:symbols');
    const pipeline = operatingClient.pipeline();
    for (const s of symbols) {
      pipeline.srem(`symbol:${s}:main`, connectionId);
      pipeline.srem(`symbol:${s}:sub`, connectionId);
    }
    pipeline.del(`ws:${connectionId}`);
    await pipeline.exec();

    console.log(`[Cleanup] Connection ${connectionId} stale (410), removed from Redis`);
  } catch (err) {
    console.error(`[Cleanup] Error cleaning ${connectionId}: ${err.message}`);
  }
}

// 어드민에게 메시지 전송
async function sendToAdmin(connectionId, data) {
  try {
    await adminApiClient.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: typeof data === 'string' ? data : JSON.stringify(data),
    }));
    return { success: true };
  } catch (error) {
    const statusCode = error.$metadata?.httpStatusCode;
    if (statusCode === 410) {
      adminConnections.delete(connectionId);
      await operatingClient.srem('admin:connections', connectionId);
      console.log(`[Admin WS] Connection ${connectionId} stale (410), removed`);
    } else {
      console.error(`[Admin WS] PostToConnection failed: ${statusCode} ${error.message}`);
    }
    return { success: false, stale: statusCode === 410 };
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
  results.forEach((result) => {
    if (result.status === 'fulfilled' && result.value.success) {
      successCount++;
    }
    // 410 stale: already removed in sendToAdmin
    // Other errors: keep connection (may be transient)
  });

  // 주기적 로그 (10초에 한 번)
  if (!broadcastToAdmins.lastLog || Date.now() - broadcastToAdmins.lastLog > 10000) {
    console.log(`[Admin Broadcast] Sent to ${successCount}/${connections.length} admins`);
    broadcastToAdmins.lastLog = Date.now();
  }
}

// === 듀얼 브로드캐스트 루프 ===

// 인증 사용자 루프 (200ms)
async function broadcastLoopAuth() {
  console.log('[Broadcast] Auth loop started (200ms)');
  while (!isShuttingDown) {
    try {
      const symbols = await operatingClient.smembers('subscribed:symbols');
      if (symbols.length > 0) {
        await Promise.all(symbols.map(s => broadcastSymbolData(s, 'auth')));
      }
      await new Promise(r => setTimeout(r, POLL_MS_AUTH));
    } catch (err) {
      if (isShuttingDown) break;
      console.error('[Broadcast Auth] Loop error:', err.message);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  console.log('[Broadcast Auth] Loop terminated');
}

// 익명 사용자 루프 (500ms)
async function broadcastLoopAnon() {
  console.log('[Broadcast] Anon loop started (500ms)');
  while (!isShuttingDown) {
    try {
      const symbols = await operatingClient.smembers('subscribed:symbols');
      if (symbols.length > 0) {
        await Promise.all(symbols.map(s => broadcastSymbolData(s, 'anon')));
      }
      await new Promise(r => setTimeout(r, POLL_MS_ANON));
    } catch (err) {
      if (isShuttingDown) break;
      console.error('[Broadcast Anon] Loop error:', err.message);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  console.log('[Broadcast Anon] Loop terminated');
}

async function broadcastSymbolData(symbol, tier) {
  try {
    const mainConnections = await operatingClient.smembers(`symbol:${symbol}:main`);
    const subConnections = await operatingClient.smembers(`symbol:${symbol}:sub`);
    if (mainConnections.length === 0 && subConnections.length === 0) return;

    // 연결 분류 (auth/anon)
    const mainClassified = await classifyConnections(mainConnections);
    const subClassified = await classifyConnections(subConnections);

    const targetMain = tier === 'auth' ? mainClassified.auth : mainClassified.anon;
    const targetSub = tier === 'auth' ? subClassified.auth : subClassified.anon;

    if (targetMain.length === 0 && targetSub.length === 0) return;

    // 캐시별로 분리된 데이터 가져오기
    const [depthJson, tickerJson, candleData, prevClose] = await Promise.all([
      depthClient.get(`depth:${symbol}`),
      depthClient.get(`ticker:${symbol}`),
      candleClient.hgetall(`candle:1m:${symbol}`),
      depthClient.get(`prev:${symbol}`)
    ]);

    let tickerData = tickerJson ? JSON.parse(tickerJson) : null;
    if (tickerData && prevClose) {
      let pcValue;
      try {
        const parsed = JSON.parse(prevClose);
        pcValue = typeof parsed === 'object' ? parsed.close : parsed;
      } catch {
        pcValue = parseFloat(prevClose);
      }
      if (pcValue && !isNaN(pcValue)) {
        tickerData.pc = pcValue;
      }
    }

    // Main에게 depth + ticker + candle
    if (targetMain.length > 0) {
      if (depthJson) {
        const depthData = JSON.parse(depthJson);
        await Promise.all(targetMain.map(id => sendToConnection(id, depthData)));
      }
      if (tickerData) {
        await Promise.all(targetMain.map(id => sendToConnection(id, tickerData)));
      }
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
        await Promise.all(targetMain.map(id => sendToConnection(id, candle)));
      }
    }

    // Sub에게 ticker만
    if (targetSub.length > 0 && tickerData) {
      await Promise.all(targetSub.map(id => sendToConnection(id, tickerData)));
    }
  } catch (err) {
    console.error(`[Broadcast ${tier}] Error for ${symbol}:`, err.message);
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

// === MM 상태 Pub/Sub 구독 (Operating Cache) ===
async function subscribeMMStatus() {
  console.log('[MM Pub/Sub] Subscribing to mm:status channel...');

  operatingSub.subscribe('mm:status', (err) => {
    if (err) {
      console.error('[MM Pub/Sub] Subscribe error:', err.message);
    } else {
      console.log('[MM Pub/Sub] Subscribed to mm:status');
    }
  });
}

// === 랭킹 Pub/Sub 구독 (Backup Cache) ===
async function subscribeRankings() {
  console.log('[Rankings Pub/Sub] Subscribing to rankings:broadcast channel...');

  backupSub.subscribe('rankings:broadcast', (err) => {
    if (err) {
      console.error('[Rankings Pub/Sub] Subscribe error:', err.message);
    } else {
      console.log('[Rankings Pub/Sub] Subscribed to rankings:broadcast');
    }
  });
}

// === Admin Events Pub/Sub 구독 (Operating Cache) ===
async function subscribeAdminEvents() {
  console.log('[Admin Events] Subscribing to admin:events channel...');
  operatingSub.subscribe('admin:events', (err) => {
    if (err) console.error('[Admin Events] Subscribe error:', err.message);
    else console.log('[Admin Events] Subscribed to admin:events');
  });
}

// === Pub/Sub 메시지 핸들러 ===
function setupPubSubHandlers() {
  // Operating Cache Sub — mm:status + admin:events
  operatingSub.on('message', async (channel, message) => {
    if (channel === 'admin:events') {
      try {
        const event = JSON.parse(message);
        await broadcastToAdmins(event);
      } catch (err) {
        console.error('[Admin Events] Parse error:', err.message);
      }
    } else if (channel === 'mm:status') {
      try {
        const rawData = JSON.parse(message);
        console.log('[MM Raw] symbols count:', rawData.symbols?.length, 'running:', rawData.running);

        // 빈 symbols 배열은 무시 (깜빡임 방지)
        if (!rawData.symbols || rawData.symbols.length === 0) {
          console.log('[MM Status] Ignoring empty symbols message');
          return;
        }

        // 각 심볼의 실제 체결가(ohlc.c) + phase_time 조회
        const symbolsWithPrice = await Promise.all(
          (rawData.symbols || []).map(async (s) => {
            const [ohlcJson, startedAtStr] = await Promise.all([
              depthClient.get(`ohlc:${s.symbol}`),
              operatingClient.get(`mm:started_at:${s.symbol}`),
            ]);
            const ohlc = ohlcJson ? JSON.parse(ohlcJson) : null;

            // phase_time 계산 (getMMData와 동일 로직)
            const period = s.config?.period || 600;
            let phaseTime = null;
            if (s.isRunning && startedAtStr && period > 0) {
              const elapsed = (Date.now() - parseInt(startedAtStr)) / 1000;
              phaseTime = elapsed % period;
            }

            return {
              symbol: s.symbol,
              base_price: s.basePrice,
              current_price: ohlc?.c || s.price,
              mm_target_price: s.price,
              order_count: s.orders,
              is_running: s.isRunning,
              // v10 fields
              strategy: s.strategy || s.config?.strategy || 'legacy_sine',
              period: period,
              amplitude: s.config?.amplitude || 0.1,
              tick_interval: s.config?.tickInterval || 1000,
              trade_interval: s.config?.tradeInterval || 3,
              trade_quantity: s.config?.tradeQuantity || 50,
              spread: s.config?.spread || 0.005,
              // OHLC
              volume: ohlc?.v || 0,
              high: ohlc?.h || null,
              low: ohlc?.l || null,
              // phase_time
              phase_time: phaseTime,
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
          `${s.symbol}:${s.is_running}:${s.base_price}:${Math.round(s.current_price || 0)}:${s.order_count}`
        ));
        if (dataHash !== lastMMDataHash) {
          console.log('[MM Hash] Changed:', dataHash.substring(0, 100));
          lastMMDataHash = dataHash;
          await broadcastToAdmins(formattedData);
        }
      } catch (err) {
        console.error('[MM Pub/Sub] Message parse error:', err.message);
      }
    }
  });

  // Backup Cache Sub — rankings:broadcast only
  backupSub.on('message', async (channel, message) => {
    if (channel === 'rankings:broadcast') {
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

// === 어드민 연결 동기화 (Operating Cache에서 읽어오기) ===
async function syncAdminConnections() {
  try {
    const connections = await operatingClient.smembers('admin:connections');
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

// Admin Events Pub/Sub 구독
subscribeAdminEvents();

// 듀얼 브로드캐스트 루프 (인증 200ms / 익명 500ms)
Promise.all([
  broadcastLoopAuth(),
  broadcastLoopAnon()
]).catch(err => {
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
      depthClient.quit(),
      candleClient.quit(),
      operatingClient.quit(),
      operatingSub.quit(),
      backupSub.quit()
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
