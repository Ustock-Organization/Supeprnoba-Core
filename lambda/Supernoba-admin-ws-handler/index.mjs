/**
 * Supernoba Admin WebSocket Handler
 * - 어드민 전용 WebSocket 연결 관리
 * - MM 실시간 데이터 구독 및 푸시
 * - Cognito JWT 인증 (DynamoDB is_admin 확인)
 */
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

// Common Layer - Valkey
import { getValkeyClient } from '/opt/nodejs/index.mjs';

// Auth Layer - Cognito JWT 검증
import { verifyAdmin } from '/opt/nodejs/verifyAuth.mjs';

// Layer를 통한 Redis 클라이언트 (4개 캐시 아키텍처)
const depthCache = getValkeyClient({ type: 'depth', preset: 'admin' });
const operatingCache = getValkeyClient({ type: 'operating', preset: 'admin' });

// Lambda 클라이언트 (DB 동기화용)
const lambdaClient = new LambdaClient({ region: 'ap-northeast-2' });

// EC2 MM Service에 제어 신호 발송 (mm:control Pub/Sub)
async function sendMMControl(action, symbol = null) {
  const message = { action, symbol, timestamp: Date.now() };
  await operatingCache.publish('mm:control', JSON.stringify(message));
  console.log(`[admin-ws] MM Control sent: ${action}`, symbol || '');
}

// admin-mm Lambda를 비동기 invoke하여 PostgreSQL DB 동기화
async function syncToDb(action, data) {
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: 'Supernoba-admin-mm',
      InvocationType: 'Event',  // 비동기, 응답 안 기다림
      Payload: JSON.stringify({
        httpMethod: 'POST',
        body: JSON.stringify({ action, ...data }),
        // 내부 표식은 최상위 필드로 전달(클라이언트 위조 불가). event.headers는
        // API GW 프록시가 클라이언트 헤더를 그대로 실어오므로 인증 판별에 쓰지 않는다.
        internalInvoke: true,
      }),
    }));
    console.log(`[admin-ws] DB sync dispatched: ${action}`);
  } catch (e) {
    console.error('[admin-ws] DB sync failed:', e.message);
  }
}

async function ensureConnected(redis) {
  if (redis.status === 'ready') return true;
  try {
    if (redis.status === 'wait') {
      await redis.connect();
    }
    return redis.status === 'ready';
  } catch (err) {
    console.error('[Redis] Connect error:', err.message);
    return false;
  }
}

// API Gateway Management API 클라이언트 생성
function getApiClient(event) {
  const domain = event.requestContext?.domainName;
  const stage = event.requestContext?.stage;
  if (!domain || !stage) return null;

  return new ApiGatewayManagementApiClient({
    endpoint: `https://${domain}/${stage}`,
    region: process.env.AWS_REGION || 'ap-northeast-2',
  });
}

// 메시지 전송
async function sendToConnection(apiClient, connectionId, data) {
  try {
    console.log(`[admin-ws] PostToConnection ${connectionId}, data: ${JSON.stringify(data).substring(0, 100)}`);
    await apiClient.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: Buffer.from(JSON.stringify(data)),
    }));
    console.log(`[admin-ws] PostToConnection SUCCESS`);
    return true;
  } catch (err) {
    console.error(`[admin-ws] PostToConnection ERROR: ${err.name} - ${err.message}`);
    if (err.statusCode === 410) {
      // Connection gone, cleanup
      await operatingCache.srem('admin:connections', connectionId).catch(() => {});
    }
    return false;
  }
}

// === $connect 핸들러 ===
async function handleConnect(event) {
  const connectionId = event.requestContext?.connectionId;
  console.log(`[admin-ws] Connect request: ${connectionId}`);

  if (!connectionId) {
    return { statusCode: 400, body: 'Missing connectionId' };
  }

  // Cognito JWT 인증 (쿼리 파라미터에서 토큰 추출)
  const token = event.queryStringParameters?.auth;
  if (!token) {
    console.log(`[admin-ws] REJECT No auth token provided`);
    return { statusCode: 401, body: 'Unauthorized - No token' };
  }

  // verifyAdmin은 event.headers를 사용하므로 가짜 event 생성
  const authEvent = {
    headers: { Authorization: `Bearer ${token}` }
  };

  try {
    const authResult = await verifyAdmin(authEvent);
    if (!authResult.success) {
      console.log(`[admin-ws] REJECT Auth failed:`, authResult.error, authResult.message);
      return { statusCode: 401, body: `Unauthorized - ${authResult.message}` };
    }
    console.log(`[admin-ws] Auth OK - userId: ${authResult.userId}, method: ${authResult.method}`);
  } catch (authError) {
    console.error(`[admin-ws] Auth exception:`, authError.message);
    return { statusCode: 401, body: 'Unauthorized - Auth error' };
  }

  console.log(`[admin-ws] Connecting to cache...`);

  try {
    await ensureConnected(operatingCache);
  } catch (cacheErr) {
    console.error(`[admin-ws] Cache connect error:`, cacheErr.message);
    // 캐시 연결 실패해도 연결은 허용
  }

  // 어드민 연결 저장
  const connectionInfo = {
    connectedAt: Date.now(),
    subscriptions: [],
  };

  try {
    await operatingCache.setex(`admin:ws:${connectionId}`, 86400, JSON.stringify(connectionInfo));
    await operatingCache.sadd('admin:connections', connectionId);
    console.log(`[admin-ws] OK Admin connected: ${connectionId}`);
  } catch (e) {
    console.error(`[admin-ws] Failed to save connection:`, e.message);
  }

  return { statusCode: 200, body: 'Connected' };
}

// === $disconnect 핸들러 ===
async function handleDisconnect(event) {
  const connectionId = event.requestContext?.connectionId;
  console.log(`[admin-ws] Disconnect: ${connectionId}`);

  if (!connectionId) return { statusCode: 200, body: 'OK' };

  await ensureConnected(operatingCache);

  try {
    await operatingCache.del(`admin:ws:${connectionId}`);
    await operatingCache.srem('admin:connections', connectionId);
    await operatingCache.srem('admin:mm:subscribers', connectionId);  // 구독자 목록에서도 제거
    console.log(`[admin-ws] OK Admin disconnected: ${connectionId}`);
  } catch (e) {
    console.error(`[admin-ws] Disconnect cleanup failed:`, e.message);
  }

  return { statusCode: 200, body: 'Disconnected' };
}

// === MM 데이터 조회 ===
async function getMMData() {
  await ensureConnected(operatingCache);
  await ensureConnected(depthCache);

  // 모든 등록된 심볼 조회 (대기 상태 포함)
  let allSymbols = await operatingCache.smembers('mm:all:symbols').catch(() => []);
  const runningSymbols = await operatingCache.smembers('mm:running:symbols').catch(() => []);
  const runningSet = new Set(runningSymbols);

  // 마이그레이션: mm:all:symbols가 비어있으면 mm:running:symbols에서 복사
  if (allSymbols.length === 0 && runningSymbols.length > 0) {
    for (const sym of runningSymbols) {
      await operatingCache.sadd('mm:all:symbols', sym);
    }
    allSymbols = runningSymbols;
    console.log(`[admin-ws] Migrated ${runningSymbols.length} symbols to mm:all:symbols`);
  }

  const mmList = [];

  for (const symbol of allSymbols) {
    const [configStr, priceStr, orderCountStr, ohlcStr, startedAtStr, lastTickStr] = await Promise.all([
      operatingCache.get(`mm:config:${symbol}`),
      operatingCache.get(`mm:price:${symbol}`),
      operatingCache.get(`mm:orderCount:${symbol}`),
      depthCache.get(`ohlc:${symbol}`),
      operatingCache.get(`mm:started_at:${symbol}`),
      operatingCache.get(`mm:lastTick:${symbol}`),  // MM 생존 확인
    ]).catch(() => [null, null, null, null, null, null]);

    let config = { basePrice: 100 };
    try { if (configStr) config = JSON.parse(configStr); } catch (e) {}

    let ohlc = null;
    try { if (ohlcStr) ohlc = JSON.parse(ohlcStr); } catch (e) {}

    // phase_time 계산 (현재 사이클에서의 경과 시간, 초 단위)
    const period = config.period ?? 600;
    const isRunning = runningSet.has(symbol);
    let phaseTime = 0;

    // 실행 중인데 started_at이 없으면 자동 설정 (마이그레이션)
    if (isRunning && !startedAtStr) {
      const now = Date.now();
      await operatingCache.set(`mm:started_at:${symbol}`, now.toString());
      phaseTime = 0;  // 새로 시작한 것처럼 0부터
      console.log(`[admin-ws] Auto-set started_at for ${symbol}`);
    } else if (isRunning && startedAtStr) {
      const startedAt = parseInt(startedAtStr);
      const elapsedMs = Date.now() - startedAt;
      phaseTime = (elapsedMs / 1000) % period;  // 현재 주기 내 경과 시간 (초)
    }

    // v10 전체 필드 반환
    mmList.push({
      symbol,
      base_price: config.basePrice ?? 100,
      current_price: ohlc?.c ?? parseFloat(priceStr) ?? null,
      order_count: parseInt(orderCountStr) || 0,
      is_running: isRunning,
      period: period,
      amplitude: config.amplitude ?? 0.1,
      tick_interval: config.tickInterval ?? 1000,
      trade_interval: config.tradeInterval ?? 3,
      trade_quantity: config.tradeQuantity ?? 50,
      volume: ohlc?.v ?? 0,
      high: ohlc?.h ?? null,
      low: ohlc?.l ?? null,
      phase_time: phaseTime,
      last_tick: lastTickStr ? parseInt(lastTickStr) : null,
      // v10 fields
      strategy: config.strategy || 'legacy_sine',
      spread: config.spread ?? 0.02,
      depth_levels: config.depthLevels ?? 3,
      depth_decay: config.depthDecay ?? 0.50,
      external_feed: config.externalFeed || 'none',
      external_symbol: config.externalSymbol || 'btcusdt',
      correlation: config.correlation ?? 0.30,
      cancel_interval: config.cancelInterval ?? 5,
      max_open_orders: config.maxOpenOrders ?? 10,
      trend_bias: config.trendBias ?? 0,
      position_limit: config.positionLimit ?? 500,
      risk_aversion: config.riskAversion ?? 0.50,
      volatility: config.volatility ?? 0.0001,
    });
  }

  // mm:running 상태
  const isRunning = await operatingCache.get('mm:running').catch(() => 'false');

  // 연결 수 조회
  const connections = await operatingCache.scard('admin:connections').catch(() => 0);

  return {
    running: isRunning === 'true',
    symbols: mmList,
    connections: connections,
    timestamp: Date.now(),
  };
}

// === $default 메시지 핸들러 ===
async function handleMessage(event) {
  const connectionId = event.requestContext?.connectionId;
  const apiClient = getApiClient(event);

  if (!connectionId || !apiClient) {
    return { statusCode: 400, body: 'Invalid request' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { action } = body;
  console.log(`[admin-ws] Message from ${connectionId}: action=${action}`);

  switch (action) {
    case 'subscribe':
      // MM 데이터 구독 시작
      await ensureConnected(operatingCache);
      await operatingCache.sadd('admin:mm:subscribers', connectionId);

      // 즉시 현재 데이터 전송
      const mmData = await getMMData();
      console.log(`[admin-ws] subscribe - connections: ${mmData.connections}, symbols: ${mmData.symbols.length}, phase_times: ${JSON.stringify(mmData.symbols.map(s => ({sym: s.symbol, pt: s.phase_time})))}`);
      await sendToConnection(apiClient, connectionId, {
        type: 'mm_data',
        data: mmData,
      });

      console.log(`[admin-ws] OK Subscribed to MM data: ${connectionId}`);
      return { statusCode: 200, body: 'Subscribed' };

    case 'unsubscribe':
      await ensureConnected(operatingCache);
      await operatingCache.srem('admin:mm:subscribers', connectionId);
      console.log(`[admin-ws] OK Unsubscribed from MM data: ${connectionId}`);
      return { statusCode: 200, body: 'Unsubscribed' };

    case 'ping':
      console.log(`[admin-ws] Sending pong to ${connectionId}`);
      try {
        const sent = await sendToConnection(apiClient, connectionId, { type: 'pong', timestamp: Date.now() });
        console.log(`[admin-ws] Pong sent: ${sent}`);
      } catch (pingErr) {
        console.error(`[admin-ws] Pong error:`, pingErr.message);
      }
      return { statusCode: 200, body: 'Pong' };

    case 'get_mm_data':
      // 수동 데이터 요청
      const data = await getMMData();
      console.log(`[admin-ws] get_mm_data - connections: ${data.connections}, symbols: ${data.symbols.length}, running: ${data.running}`);
      await sendToConnection(apiClient, connectionId, {
        type: 'mm_data',
        data: data,
      });
      return { statusCode: 200, body: 'Data sent' };

    // MM 제어 액션들
    case 'start':
    case 'stop':
    case 'startAll':
    case 'stopAll':
    case 'save':
    case 'delete':
      return await handleMMControl(event, apiClient, connectionId, body);

    default:
      console.log(`[admin-ws] Unknown action: ${action}`);
      return { statusCode: 400, body: 'Unknown action' };
  }
}

// === MM 제어 핸들러 ===
async function handleMMControl(event, apiClient, connectionId, body) {
  const { action, symbol, basePrice, config } = body;
  await ensureConnected(operatingCache);

  const sym = (symbol || '').toUpperCase();
  const cfg = config || {};

  try {
    switch (action) {
      case 'start':
        if (!sym) {
          await sendToConnection(apiClient, connectionId, { type: 'error', message: 'Symbol required' });
          return { statusCode: 400, body: 'Symbol required' };
        }
        // 기존 설정 조회 (v10 기본값 포함)
        let existingConfig = {
          basePrice: 100, period: 600, amplitude: 0.1, tickInterval: 1000,
          tradeInterval: 3, tradeQuantity: 50,
          strategy: 'legacy_sine', spread: 0.02, depthLevels: 3, depthDecay: 0.50,
          externalFeed: 'none', externalSymbol: 'btcusdt', correlation: 0.30,
          cancelInterval: 5, maxOpenOrders: 10, trendBias: 0,
          positionLimit: 500, riskAversion: 0.50, volatility: 0.0001,
        };
        try {
          const existingStr = await operatingCache.get(`mm:config:${sym}`);
          if (existingStr) existingConfig = { ...existingConfig, ...JSON.parse(existingStr) };
        } catch (e) {}
        // v10 전체 필드 보존
        const startConfig = {
          basePrice: basePrice || existingConfig.basePrice || 100,
          period: cfg.period ?? existingConfig.period ?? 600,
          amplitude: cfg.amplitude ?? existingConfig.amplitude ?? 0.1,
          tickInterval: cfg.tickInterval ?? existingConfig.tickInterval ?? 1000,
          tradeInterval: cfg.tradeInterval ?? existingConfig.tradeInterval ?? 3,
          tradeQuantity: cfg.tradeQuantity ?? existingConfig.tradeQuantity ?? 50,
          strategy: cfg.strategy || existingConfig.strategy || 'legacy_sine',
          spread: cfg.spread ?? existingConfig.spread ?? 0.02,
          depthLevels: cfg.depthLevels ?? existingConfig.depthLevels ?? 3,
          depthDecay: cfg.depthDecay ?? existingConfig.depthDecay ?? 0.50,
          externalFeed: cfg.externalFeed || existingConfig.externalFeed || 'none',
          externalSymbol: cfg.externalSymbol || existingConfig.externalSymbol || 'btcusdt',
          correlation: cfg.correlation ?? existingConfig.correlation ?? 0.30,
          cancelInterval: cfg.cancelInterval ?? existingConfig.cancelInterval ?? 5,
          maxOpenOrders: cfg.maxOpenOrders ?? existingConfig.maxOpenOrders ?? 10,
          trendBias: cfg.trendBias ?? existingConfig.trendBias ?? 0,
          positionLimit: cfg.positionLimit ?? existingConfig.positionLimit ?? 500,
          riskAversion: cfg.riskAversion ?? existingConfig.riskAversion ?? 0.50,
          volatility: cfg.volatility ?? existingConfig.volatility ?? 0.0001,
        };
        await operatingCache.set('mm:running', 'true');
        await operatingCache.sadd('mm:all:symbols', sym);       // 전체 목록에 추가
        await operatingCache.sadd('mm:running:symbols', sym);   // 실행 목록에 추가
        await operatingCache.set(`mm:config:${sym}`, JSON.stringify(startConfig));
        // 시작 시간 저장 (phase_time 계산용)
        await operatingCache.set(`mm:started_at:${sym}`, Date.now().toString());
        // EC2 MM Service에 시작 명령 전송
        await sendMMControl('start', sym);
        await sendToConnection(apiClient, connectionId, { type: 'success', action: 'start', symbol: sym });
        syncToDb('start', { symbol: sym, basePrice: startConfig.basePrice, config: startConfig });
        break;

      case 'stop':
        if (sym) {
          await operatingCache.srem('mm:running:symbols', sym);
          // 시작 시간 제거
          await operatingCache.del(`mm:started_at:${sym}`);
          const remaining = await operatingCache.scard('mm:running:symbols');
          if (remaining === 0) {
            await operatingCache.set('mm:running', 'false');
          }
          // EC2 MM Service에 중지 명령 전송
          await sendMMControl('stop', sym);
        } else {
          await operatingCache.set('mm:running', 'false');
          await operatingCache.del('mm:running:symbols');
          // EC2 MM Service에 전체 중지 명령 전송
          await sendMMControl('stopAll');
        }
        await sendToConnection(apiClient, connectionId, { type: 'success', action: 'stop', symbol: sym || 'all' });
        syncToDb('stop', { symbol: sym || null });
        break;

      case 'startAll':
        await operatingCache.set('mm:running', 'true');
        // 모든 심볼에 대해 시작 시간 설정
        const allSymbols = await operatingCache.smembers('mm:all:symbols').catch(() => []);
        const now = Date.now().toString();
        for (const s of allSymbols) {
          await operatingCache.sadd('mm:running:symbols', s);
          await operatingCache.set(`mm:started_at:${s}`, now);
        }
        // EC2 MM Service에 전체 시작 명령 전송
        await sendMMControl('startAll');
        await sendToConnection(apiClient, connectionId, { type: 'success', action: 'startAll' });
        syncToDb('startAll', {});
        break;

      case 'stopAll':
        await operatingCache.set('mm:running', 'false');
        // 모든 심볼의 시작 시간 제거
        const runningSymbols = await operatingCache.smembers('mm:running:symbols').catch(() => []);
        for (const s of runningSymbols) {
          await operatingCache.del(`mm:started_at:${s}`);
        }
        await operatingCache.del('mm:running:symbols');
        // EC2 MM Service에 전체 중지 명령 전송
        await sendMMControl('stopAll');
        await sendToConnection(apiClient, connectionId, { type: 'success', action: 'stopAll' });
        syncToDb('stopAll', {});
        break;

      case 'save':
        if (!sym) {
          await sendToConnection(apiClient, connectionId, { type: 'error', message: 'Symbol required' });
          return { statusCode: 400, body: 'Symbol required' };
        }
        console.log('[admin-ws] Save request:', JSON.stringify({ symbol: sym, basePrice, config: cfg }));
        // 기존 설정 읽어서 v10 필드 병합
        let existingSaveConfig = {};
        try {
          const existingSaveStr = await operatingCache.get(`mm:config:${sym}`);
          if (existingSaveStr) existingSaveConfig = JSON.parse(existingSaveStr);
        } catch (e) {}
        // v10 전체 필드 보존
        const saveConfig = {
          basePrice: basePrice || existingSaveConfig.basePrice || 100,
          period: cfg.period ?? existingSaveConfig.period ?? 600,
          amplitude: cfg.amplitude ?? existingSaveConfig.amplitude ?? 0.1,
          tickInterval: cfg.tickInterval ?? existingSaveConfig.tickInterval ?? 1000,
          tradeInterval: cfg.tradeInterval ?? existingSaveConfig.tradeInterval ?? 3,
          tradeQuantity: cfg.tradeQuantity ?? existingSaveConfig.tradeQuantity ?? 50,
          strategy: cfg.strategy || existingSaveConfig.strategy || 'legacy_sine',
          spread: cfg.spread ?? existingSaveConfig.spread ?? 0.02,
          depthLevels: cfg.depthLevels ?? existingSaveConfig.depthLevels ?? 3,
          depthDecay: cfg.depthDecay ?? existingSaveConfig.depthDecay ?? 0.50,
          externalFeed: cfg.externalFeed || existingSaveConfig.externalFeed || 'none',
          externalSymbol: cfg.externalSymbol || existingSaveConfig.externalSymbol || 'btcusdt',
          correlation: cfg.correlation ?? existingSaveConfig.correlation ?? 0.30,
          cancelInterval: cfg.cancelInterval ?? existingSaveConfig.cancelInterval ?? 5,
          maxOpenOrders: cfg.maxOpenOrders ?? existingSaveConfig.maxOpenOrders ?? 10,
          trendBias: cfg.trendBias ?? existingSaveConfig.trendBias ?? 0,
          positionLimit: cfg.positionLimit ?? existingSaveConfig.positionLimit ?? 500,
          riskAversion: cfg.riskAversion ?? existingSaveConfig.riskAversion ?? 0.50,
          volatility: cfg.volatility ?? existingSaveConfig.volatility ?? 0.0001,
        };
        console.log('[admin-ws] Saving config:', JSON.stringify(saveConfig));
        await operatingCache.sadd('mm:all:symbols', sym);
        await operatingCache.set(`mm:config:${sym}`, JSON.stringify(saveConfig));
        // 실행 중인 심볼이면 즉시 reload 발행
        const isSaveRunning = await operatingCache.sismember('mm:running:symbols', sym);
        if (isSaveRunning) {
          await sendMMControl('reload', sym);
          console.log(`[admin-ws] Reload sent for running symbol: ${sym}`);
        }
        await sendToConnection(apiClient, connectionId, { type: 'success', action: 'save', symbol: sym });
        syncToDb('save', { symbol: sym, basePrice: saveConfig.basePrice, config: saveConfig });
        break;

      case 'delete':
        if (!sym) {
          await sendToConnection(apiClient, connectionId, { type: 'error', message: 'Symbol required' });
          return { statusCode: 400, body: 'Symbol required' };
        }
        // 심볼을 모든 목록에서 제거
        await operatingCache.srem('mm:all:symbols', sym);
        await operatingCache.srem('mm:running:symbols', sym);
        await operatingCache.del(`mm:config:${sym}`);
        await operatingCache.del(`mm:price:${sym}`);
        await operatingCache.del(`mm:orderCount:${sym}`);
        await operatingCache.del(`mm:started_at:${sym}`);  // 시작 시간도 제거
        await sendToConnection(apiClient, connectionId, { type: 'success', action: 'delete', symbol: sym });
        syncToDb('delete', { symbol: sym });
        break;
    }

    // 변경 후 최신 데이터 브로드캐스트 (non-blocking)
    broadcastMMData(event).catch(e => console.error('[admin-ws] Broadcast error:', e.message));

    return { statusCode: 200, body: 'OK' };
  } catch (e) {
    console.error(`[admin-ws] MM control error:`, e.message);
    await sendToConnection(apiClient, connectionId, { type: 'error', message: e.message });
    return { statusCode: 500, body: e.message };
  }
}

// === MM 데이터 브로드캐스트 ===
async function broadcastMMData(event) {
  const apiClient = getApiClient(event);
  if (!apiClient) return;

  await ensureConnected(operatingCache);

  // 활성 연결 목록으로 구독자 필터링
  const [subscribers, connections] = await Promise.all([
    operatingCache.smembers('admin:mm:subscribers').catch(() => []),
    operatingCache.smembers('admin:connections').catch(() => []),
  ]);

  const connSet = new Set(connections);
  const validSubscribers = subscribers.filter(s => connSet.has(s));

  // 유효하지 않은 구독자 정리
  const staleSubscribers = subscribers.filter(s => !connSet.has(s));
  if (staleSubscribers.length > 0) {
    await Promise.all(staleSubscribers.map(s => operatingCache.srem('admin:mm:subscribers', s)));
    console.log(`[admin-ws] Cleaned up ${staleSubscribers.length} stale subscribers`);
  }

  if (validSubscribers.length === 0) return;

  const mmData = await getMMData();
  const message = { type: 'mm_data', data: mmData };

  // 병렬로 전송 (타임아웃 방지)
  const results = await Promise.allSettled(
    validSubscribers.map(connId => sendToConnection(apiClient, connId, message))
  );

  const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
  console.log(`[admin-ws] Broadcast MM data to ${successCount}/${validSubscribers.length} subscribers`);
}

// === 메인 핸들러 ===
export const handler = async (event, context) => {
  // 백그라운드 Promise가 완료되기 전에 Lambda 종료 허용
  context.callbackWaitsForEmptyEventLoop = false;

  const routeKey = event.requestContext?.routeKey;

  console.log(`[admin-ws] Route: ${routeKey}, ConnectionId: ${event.requestContext?.connectionId}`);

  try {
    switch (routeKey) {
      case '$connect':
        return await handleConnect(event);
      case '$disconnect':
        return await handleDisconnect(event);
      case '$default':
      default:
        return await handleMessage(event);
    }
  } catch (err) {
    console.error(`[admin-ws] Error:`, err);
    return { statusCode: 500, body: err.message };
  }
};

