/**
 * Supernoba Market Maker Service v10
 *
 * Admin Panel에서 제어하는 경량 마켓메이커
 * - Redis pub/sub으로 시작/정지 신호 수신
 * - Kinesis에 주문 발행하여 실제 오더북/캔들 데이터 생성
 * - 실시간 상태를 mm:status 채널로 브로드캐스트
 *
 * v10 변경사항:
 * - Strategy Pattern 도입 (legacy_sine, spread, depth)
 * - OrderManager 기반 주문 추적/취소
 * - InventoryTracker 5단계 방어선 (포지션 추적, 비대칭 스프레드, 수량 감소, 서킷 브레이커, 모니터링)
 * - PriceFeed (외부 Binance 시세) / InternalFeed (내부 Valkey 캐시) 연동
 * - 100% 하위 호환: strategy 필드 미설정 시 legacy_sine 동작 (v9 동일)
 *
 * v9 변경사항:
 * - SELL을 먼저 발행하여 잔존 매수호가에 체결되는 문제 해결
 *
 * v8 변경사항:
 * - mm:config 키를 STRING(JSON)과 HASH 둘 다 지원 (하위 호환)
 *
 * v7 변경사항:
 * - mm:config 키가 HASH 타입이므로 HGETALL 사용
 *
 * 배포: server (stock-bastion) 인스턴스
 * 실행: ./run_mm.sh
 */

import Redis from "ioredis";
import { KinesisClient } from "@aws-sdk/client-kinesis";

// v10 modules
import OrderManager from "./utils/order-manager.mjs";
import InventoryTracker from "./utils/inventory.mjs";
import SineStrategy from "./strategies/sine-strategy.mjs";
import SpreadStrategy from "./strategies/spread-mm.mjs";
import DepthStrategy from "./strategies/depth-mm.mjs";
import OrganicStrategy from "./strategies/organic-strategy.mjs";
import PriceFeed from "./feeds/price-feed.mjs";
import InternalFeed from "./feeds/internal-feed.mjs";

// === Configuration ===
const CONFIG = {
  // Redis (Operating Cache - MM 설정 및 상태 관리)
  operatingCacheHost: process.env.OPERATING_CACHE_HOST || process.env.BACKUP_CACHE_HOST || "master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com",
  operatingCachePort: parseInt(process.env.OPERATING_CACHE_PORT || process.env.BACKUP_CACHE_PORT || "6382"),

  // Kinesis (주문 발행)
  kinesisStream: process.env.KINESIS_STREAM || "supernoba-orders",
  awsRegion: process.env.AWS_REGION || "ap-northeast-2",

  // MM 기본 설정
  defaultTickInterval: 1000,  // 1초
  statusPublishInterval: 2000,  // 2초마다 상태 발행
};

console.log("=== Supernoba Market Maker Service v10 ===");
console.log("Operating Cache:", CONFIG.operatingCacheHost + ":" + CONFIG.operatingCachePort);
console.log("Kinesis Stream:", CONFIG.kinesisStream);

// === Clients ===
const kinesis = new KinesisClient({ region: CONFIG.awsRegion });

// TLS: ElastiCache는 TLS 필수, localhost(EC2)는 비활성
const useTls = process.env.VALKEY_TLS === 'true' && CONFIG.operatingCacheHost !== '127.0.0.1' && CONFIG.operatingCacheHost !== 'localhost';

// Operating Cache - 설정 읽기/쓰기용 (MM 관련 데이터)
const operatingCache = new Redis({
  host: CONFIG.operatingCacheHost,
  port: CONFIG.operatingCachePort,
  ...(useTls ? { tls: {} } : {}),
  connectTimeout: 5000,
  lazyConnect: true,
});

// Operating Cache - Pub/Sub 구독용 (별도 연결 필요)
const operatingCacheSub = new Redis({
  host: CONFIG.operatingCacheHost,
  port: CONFIG.operatingCachePort,
  ...(useTls ? { tls: {} } : {}),
  connectTimeout: 5000,
  lazyConnect: true,
});

operatingCache.on("error", (e) => console.error("[OperatingCache] Error:", e.message));
operatingCache.on("connect", () => console.log("[OperatingCache] Connected"));
operatingCacheSub.on("error", (e) => console.error("[OperatingCache Sub] Error:", e.message));
operatingCacheSub.on("connect", () => console.log("[OperatingCache Sub] Connected"));

// === State ===
const activeSymbols = new Map();  // symbol -> { config, strategy, interval, orderCount, startedAt, tickCount }
let isRunning = false;
let statusInterval = null;

// === v10 Shared Instances (initialized in main()) ===
let orderManager = null;
let inventory = null;
let priceFeed = null;
let internalFeed = null;

// === v10 Default Config (v9 fields + v10 extensions) ===
const DEFAULT_CONFIG = {
  // v9 legacy
  basePrice: 100,
  period: 600,
  amplitude: 0.1,
  tickInterval: 1000,
  tradeInterval: 1,
  tradeQuantity: 10,
  // v10 extensions
  // 기본 전략은 organic. legacy_sine은 결정론적 사인파(basePrice·period·amplitude·
  // started_at만 알면 미래 가격이 계산된다)라 무위험 차익 익스플로잇의 원본이며,
  // 봇 예산이 무한이라 무한 발권으로 이어진다. 명시적으로 선택할 때만 쓴다.
  strategy: "organic",
  spread: 0.02,
  depthLevels: 3,
  depthDecay: 0.5,
  externalFeed: "none",
  externalSymbol: "btcusdt",
  correlation: 0.3,
  cancelInterval: 5,
  maxOpenOrders: 10,
  trendBias: 0,
  positionLimit: 500,
  riskAversion: 0.5,
  volatility: 0.0001,
  // organic 전략 전용
  agentCount: 4,          // MM 에이전트 풀 크기(자가체결 시그니처 분산)
  maxOrderSize: 1000,     // 주문 크기 상한
  crossProb: 0.5,         // 매 틱 교차(체결) 발생 확률
};

// === Strategy Factory ===
const VALID_STRATEGIES = new Set(["organic", "spread", "depth", "legacy_sine"]);

function createStrategy(symbol, config) {
  let strategyName = config.strategy || DEFAULT_CONFIG.strategy;
  // 화이트리스트: 오타("Organic"·"ORGANIC")가 조용히 default로 떨어져 legacy_sine으로
  // 기동하던 경로를 막는다. 로그 한 줄만 남아 운영자가 알아채기 어려웠다.
  if (!VALID_STRATEGIES.has(strategyName)) {
    console.error(`[MM] 알 수 없는 전략 "${strategyName}" → ${DEFAULT_CONFIG.strategy} 사용 (${symbol})`);
    strategyName = DEFAULT_CONFIG.strategy;
  }
  // legacy_sine은 결정론적이라 익스플로잇 대상 — 명시적 옵트인을 요구한다.
  if (strategyName === "legacy_sine" && process.env.MM_ALLOW_LEGACY_SINE !== "true") {
    console.error(`[MM] legacy_sine은 MM_ALLOW_LEGACY_SINE=true 없이는 사용할 수 없습니다 ` +
                  `(결정론적 가격 → 무위험 차익). organic으로 대체합니다. (${symbol})`);
    strategyName = "organic";
  }
  const deps = {
    kinesis,
    operatingCache,
    orderManager,
    inventory,
    priceFeed: null,
    internalFeed,
    config: { kinesisStream: CONFIG.kinesisStream },
  };

  // External feed setup (lazy — only connect if needed)
  if (config.externalFeed === "binance" && !priceFeed) {
    priceFeed = new PriceFeed(config.externalSymbol || "btcusdt");
    priceFeed.connect().catch(e => console.error("[PriceFeed] connect error:", e.message));
  }
  if (priceFeed) deps.priceFeed = priceFeed;

  switch (strategyName) {
    case "organic": return new OrganicStrategy(symbol, config, deps);
    case "spread": return new SpreadStrategy(symbol, config, deps);
    case "depth": return new DepthStrategy(symbol, config, deps);
    case "legacy_sine": return new SineStrategy(symbol, config, deps);
    // 위 화이트리스트를 통과한 값만 도달하므로 default는 도달 불가.
    default: return new OrganicStrategy(symbol, config, deps);
  }
}

// === Config Parsing Helper ===
// 범위 강제 헬퍼 — `parseFloat(x) || 기본값` 패턴은 음수를 그대로 통과시킨다.
// 예: spread=-0.5면 bid = reservation×1.25가 되어 봇이 현재가보다 25% 높은 값에
// 매수 호가를 깔고(가격밴드도 통과) 매도 물량을 전부 받아준다.
function clampNum(v, fallback, min, max, isInt = false) {
  let n = isInt ? parseInt(v) : parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < min || n > max) {
    console.error(`[MM] config 값 ${n}이 허용 범위 [${min}, ${max}] 밖 → 기본값 ${fallback} 사용`);
    return fallback;
  }
  return n;
}

function parseConfigFields(raw) {
  return {
    // v9 legacy fields
    basePrice: clampNum(raw.basePrice, DEFAULT_CONFIG.basePrice, 0.01, 1e9),
    period: clampNum(raw.period, DEFAULT_CONFIG.period, 1, 86400),
    amplitude: clampNum(raw.amplitude, DEFAULT_CONFIG.amplitude, 0, 1),
    tickInterval: clampNum(raw.tickInterval, DEFAULT_CONFIG.tickInterval, 100, 600000, true),
    tradeInterval: clampNum(raw.tradeInterval, DEFAULT_CONFIG.tradeInterval, 0.001, 3600),
    tradeQuantity: clampNum(raw.tradeQuantity, DEFAULT_CONFIG.tradeQuantity, 1, 1e6, true),
    // v10 extensions
    strategy: raw.strategy || DEFAULT_CONFIG.strategy,   // 화이트리스트는 createStrategy에서
    spread: clampNum(raw.spread, DEFAULT_CONFIG.spread, 0.0001, 0.5),
    depthLevels: clampNum(raw.depthLevels, DEFAULT_CONFIG.depthLevels, 1, 10, true),
    depthDecay: clampNum(raw.depthDecay, DEFAULT_CONFIG.depthDecay, 0.01, 1),
    externalFeed: raw.externalFeed || DEFAULT_CONFIG.externalFeed,
    externalSymbol: raw.externalSymbol || DEFAULT_CONFIG.externalSymbol,
    correlation: clampNum(raw.correlation, DEFAULT_CONFIG.correlation, -1, 1),
    cancelInterval: clampNum(raw.cancelInterval, DEFAULT_CONFIG.cancelInterval, 1, 1000, true),
    maxOpenOrders: clampNum(raw.maxOpenOrders, DEFAULT_CONFIG.maxOpenOrders, 1, 1000, true),
    trendBias: clampNum(raw.trendBias, DEFAULT_CONFIG.trendBias, -1, 1),
    positionLimit: clampNum(raw.positionLimit, DEFAULT_CONFIG.positionLimit, 1, 1e7, true),
    riskAversion: clampNum(raw.riskAversion, DEFAULT_CONFIG.riskAversion, 0, 10),
    volatility: clampNum(raw.volatility, DEFAULT_CONFIG.volatility, 0, 1),
    // organic 전략 전용
    agentCount: clampNum(raw.agentCount, DEFAULT_CONFIG.agentCount, 2, 50, true),
    maxOrderSize: clampNum(raw.maxOrderSize, DEFAULT_CONFIG.maxOrderSize, 1, 1e6, true),
    crossProb: clampNum(raw.crossProb, DEFAULT_CONFIG.crossProb, 0, 1),
  };
}

// === Load Config (supports both STRING and HASH types) ===
async function loadConfig(symbol) {
  const key = "mm:config:" + symbol;

  // Check key type first for backward compatibility
  const keyType = await operatingCache.type(key);

  if (keyType === "none") {
    console.log("[Config] No config found for " + symbol + ", using defaults");
    return { ...DEFAULT_CONFIG };
  }

  let config;

  if (keyType === "string") {
    // Legacy format: JSON string (Admin Lambda v1)
    const jsonStr = await operatingCache.get(key);
    try {
      const parsed = JSON.parse(jsonStr);
      config = parseConfigFields(parsed);
      console.log("[Config] Loaded STRING config for " + symbol + ":", JSON.stringify(config));
    } catch (e) {
      console.error("[Config] Failed to parse JSON for " + symbol + ":", e.message);
      return { ...DEFAULT_CONFIG };
    }
  } else if (keyType === "hash") {
    // New format: HASH type (Admin Lambda v2)
    const hashData = await operatingCache.hgetall(key);
    config = parseConfigFields(hashData);
    console.log("[Config] Loaded HASH config for " + symbol + ":", JSON.stringify(config));
  } else {
    console.error("[Config] Unexpected key type for " + symbol + ":", keyType);
    return { ...DEFAULT_CONFIG };
  }

  return config;
}

// === Symbol Management ===
async function startSymbol(symbol) {
  if (activeSymbols.has(symbol)) {
    console.log("[MM] " + symbol + " already running");
    return;
  }

  const config = await loadConfig(symbol);
  const tickInterval = config.tickInterval || CONFIG.defaultTickInterval;
  const strategy = createStrategy(symbol, config);

  const instance = {
    config,
    strategy,
    orderCount: 0,
    currentPrice: config.basePrice || 100,
    startedAt: Date.now(),
    tickCount: 0,
    interval: null,
  };

  instance.interval = setInterval(async () => {
    instance.tickCount++;
    const elapsed = (Date.now() - instance.startedAt) / 1000;
    try {
      await strategy.execute({ elapsed, tickCount: instance.tickCount });
      instance.currentPrice = strategy.currentPrice;
      instance.orderCount = strategy._orderCount;
    } catch (e) {
      console.error(`[MM] ${symbol} tick error:`, e.message);
    }
  }, tickInterval);

  activeSymbols.set(symbol, instance);

  // Redis에 시작 시간 기록
  await operatingCache.set("mm:started_at:" + symbol, Date.now().toString());

  console.log(`[MM] Started ${symbol} (strategy: ${strategy.strategyName}) - basePrice: ${config.basePrice}, period: ${config.period}s`);
}

async function stopSymbol(symbol) {
  const instance = activeSymbols.get(symbol);
  if (instance) {
    clearInterval(instance.interval);
    if (instance.strategy) await instance.strategy.cleanup();
    activeSymbols.delete(symbol);
    console.log("[MM] Stopped " + symbol + " - orders: " + instance.orderCount);
  }
}

async function stopAllSymbols() {
  for (const [symbol, instance] of activeSymbols) {
    clearInterval(instance.interval);
    if (instance.strategy) await instance.strategy.cleanup();
    console.log("[MM] Stopped " + symbol + " - orders: " + instance.orderCount);
  }
  activeSymbols.clear();
}

// === Status Publishing ===
async function publishStatus() {
  const symbols = [];

  for (const [symbol, instance] of activeSymbols) {
    let inventoryStatus = null;
    if (instance.strategy && instance.strategy.strategyName !== "legacy_sine") {
      try {
        inventoryStatus = await inventory.getStatus(symbol);
      } catch (_) {}
    }

    symbols.push({
      symbol,
      basePrice: instance.config.basePrice || 100,
      price: instance.currentPrice,
      orders: instance.orderCount,
      isRunning: true,
      strategy: instance.strategy?.strategyName || "legacy_sine",
      config: instance.config,
      inventory: inventoryStatus,
    });
  }

  const status = {
    e: "mm_status",
    running: activeSymbols.size > 0,
    symbols,
    timestamp: Date.now(),
  };

  // mm:status 채널로 publish (Streamer가 Admin에게 전달)
  await operatingCache.publish("mm:status", JSON.stringify(status));
}

// === Control Message Handler ===
async function handleControlMessage(message) {
  try {
    const cmd = JSON.parse(message);
    console.log("[Control] Received:", cmd.action, cmd.symbol || "");

    switch (cmd.action) {
      case "start":
        if (cmd.symbol) {
          await startSymbol(cmd.symbol);
        }
        break;

      case "stop":
        if (cmd.symbol) {
          await stopSymbol(cmd.symbol);
        }
        break;

      case "startAll": {
        // Redis에서 모든 running symbols 가져오기
        const runningSymbols = await operatingCache.smembers("mm:running:symbols");
        for (const symbol of runningSymbols) {
          await startSymbol(symbol);
        }
        break;
      }

      case "stopAll":
        await stopAllSymbols();
        break;

      case "reload":
        // 설정 리로드 — 전략 변경 시 stop + restart
        if (cmd.symbol && activeSymbols.has(cmd.symbol)) {
          const newConfig = await loadConfig(cmd.symbol);
          const instance = activeSymbols.get(cmd.symbol);
          const oldStrategy = instance.config.strategy || "legacy_sine";
          const newStrategy = newConfig.strategy || "legacy_sine";

          if (oldStrategy !== newStrategy) {
            // Strategy type changed — full restart
            console.log(`[MM] Strategy changed for ${cmd.symbol}: ${oldStrategy} → ${newStrategy}`);
            await stopSymbol(cmd.symbol);
            await startSymbol(cmd.symbol);
          } else {
            // Same strategy — update config in place
            instance.config = newConfig;
            if (instance.strategy) instance.strategy.config = { ...instance.strategy.config, ...newConfig };
            console.log("[MM] Reloaded config for " + cmd.symbol);
          }
        }
        break;

      case "sync":
        // Redis 상태와 동기화
        await syncWithRedis();
        break;

      default:
        console.log("[Control] Unknown action:", cmd.action);
    }

    // 상태 즉시 발행
    await publishStatus();

  } catch (e) {
    console.error("[Control] Error handling message:", e.message);
  }
}

// === Redis Sync ===
async function syncWithRedis() {
  const runningSymbols = await operatingCache.smembers("mm:running:symbols");
  const currentSymbols = new Set(activeSymbols.keys());

  // 시작해야 할 심볼
  for (const symbol of runningSymbols) {
    if (!currentSymbols.has(symbol)) {
      await startSymbol(symbol);
    }
  }

  // 중지해야 할 심볼
  for (const symbol of currentSymbols) {
    if (!runningSymbols.includes(symbol)) {
      await stopSymbol(symbol);
    }
  }

  console.log("[Sync] Active symbols:", activeSymbols.size);
}

// === Main ===
async function main() {
  console.log("[MM] Connecting to Redis...");

  await operatingCache.connect();
  await operatingCacheSub.connect();

  // v10: Initialize shared instances
  orderManager = new OrderManager(kinesis, CONFIG.kinesisStream);
  inventory = new InventoryTracker(operatingCache);
  internalFeed = new InternalFeed();
  await internalFeed.connect();

  // mm:control 채널 구독
  await operatingCacheSub.subscribe("mm:control");
  console.log("[MM] Subscribed to mm:control channel");

  operatingCacheSub.on("message", (channel, message) => {
    if (channel === "mm:control") {
      handleControlMessage(message);
    }
  });

  // 주기적 상태 발행
  // .catch 필수: setInterval은 반환된 Promise를 잡지 않으므로, Valkey 페일오버 등으로
  // publish가 reject되면 unhandled rejection이 되어 Node가 프로세스를 종료시킨다.
  // MM이 죽으면 오더북에 고아 호가가 남고(추적은 인메모리) 재시작 시 정리되지 않는다.
  statusInterval = setInterval(
    () => publishStatus().catch((e) => console.error("[MM] publishStatus 실패:", e.message)),
    CONFIG.statusPublishInterval
  );

  // 시작 시 Redis 상태와 동기화
  await syncWithRedis();

  console.log("[MM] Market Maker Service v10 ready");
  console.log("[MM] Strategies: legacy_sine, spread, depth");
  console.log("[MM] Waiting for control messages on mm:control channel...");
}

// === Graceful Shutdown ===
async function shutdown(signal) {
  console.log(`\n[MM] ${signal} received, shutting down...`);

  await stopAllSymbols();

  if (statusInterval) clearInterval(statusInterval);

  if (orderManager) orderManager.clearAll();
  if (priceFeed) priceFeed.disconnect();
  if (internalFeed) await internalFeed.disconnect();

  await operatingCache.quit();
  await operatingCacheSub.quit();

  console.log("[MM] Goodbye!");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// 안전망: 일시적 인프라 오류(Valkey 페일오버·Kinesis 스로틀)로 프로세스가 죽으면
// 오더북에 고아 MM 호가가 남는다(주문 추적이 인메모리라 재시작해도 취소 불가).
// 로그만 남기고 계속 돌린다 — streamer와 동일한 정책.
process.on("unhandledRejection", (reason) => {
  console.error("[MM] Unhandled rejection:", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[MM] Uncaught exception:", err?.message || err);
});

// Start
main().catch((e) => {
  console.error("[MM] Fatal error:", e);
  process.exit(1);
});
