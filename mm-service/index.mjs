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
  strategy: "legacy_sine",
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
};

// === Strategy Factory ===
function createStrategy(symbol, config) {
  const strategyName = config.strategy || "legacy_sine";
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
    case "spread": return new SpreadStrategy(symbol, config, deps);
    case "depth": return new DepthStrategy(symbol, config, deps);
    case "legacy_sine":
    default: return new SineStrategy(symbol, config, deps);
  }
}

// === Config Parsing Helper ===
function parseConfigFields(raw) {
  return {
    // v9 legacy fields
    basePrice: parseFloat(raw.basePrice) || DEFAULT_CONFIG.basePrice,
    period: parseFloat(raw.period) || DEFAULT_CONFIG.period,
    amplitude: parseFloat(raw.amplitude) || DEFAULT_CONFIG.amplitude,
    tickInterval: parseInt(raw.tickInterval) || DEFAULT_CONFIG.tickInterval,
    tradeInterval: parseFloat(raw.tradeInterval) || DEFAULT_CONFIG.tradeInterval,
    tradeQuantity: parseInt(raw.tradeQuantity) || DEFAULT_CONFIG.tradeQuantity,
    // v10 extensions
    strategy: raw.strategy || DEFAULT_CONFIG.strategy,
    spread: parseFloat(raw.spread) || DEFAULT_CONFIG.spread,
    depthLevels: parseInt(raw.depthLevels) || DEFAULT_CONFIG.depthLevels,
    depthDecay: parseFloat(raw.depthDecay) || DEFAULT_CONFIG.depthDecay,
    externalFeed: raw.externalFeed || DEFAULT_CONFIG.externalFeed,
    externalSymbol: raw.externalSymbol || DEFAULT_CONFIG.externalSymbol,
    correlation: parseFloat(raw.correlation) || DEFAULT_CONFIG.correlation,
    cancelInterval: parseInt(raw.cancelInterval) || DEFAULT_CONFIG.cancelInterval,
    maxOpenOrders: parseInt(raw.maxOpenOrders) || DEFAULT_CONFIG.maxOpenOrders,
    trendBias: parseFloat(raw.trendBias) || DEFAULT_CONFIG.trendBias,
    positionLimit: parseInt(raw.positionLimit) || DEFAULT_CONFIG.positionLimit,
    riskAversion: parseFloat(raw.riskAversion) || DEFAULT_CONFIG.riskAversion,
    volatility: parseFloat(raw.volatility) || DEFAULT_CONFIG.volatility,
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
  statusInterval = setInterval(publishStatus, CONFIG.statusPublishInterval);

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

// Start
main().catch((e) => {
  console.error("[MM] Fatal error:", e);
  process.exit(1);
});
