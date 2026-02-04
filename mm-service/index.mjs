/**
 * Supernoba Market Maker Service v9
 *
 * Admin Panel에서 제어하는 경량 마켓메이커
 * - Redis pub/sub으로 시작/정지 신호 수신
 * - Kinesis에 주문 발행하여 실제 오더북/캔들 데이터 생성
 * - 실시간 상태를 mm:status 채널로 브로드캐스트
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
import { KinesisClient, PutRecordCommand } from "@aws-sdk/client-kinesis";
import { v4 as uuidv4 } from "uuid";

// === Configuration ===
const CONFIG = {
  // Redis (Operating Cache - MM 설정 및 상태 관리, 4개 Redis 아키텍처)
  operatingCacheHost: process.env.OPERATING_CACHE_HOST || process.env.BACKUP_CACHE_HOST || "localhost",
  operatingCachePort: parseInt(process.env.OPERATING_CACHE_PORT || process.env.BACKUP_CACHE_PORT || "6379"),

  // Kinesis (주문 발행)
  kinesisStream: process.env.KINESIS_STREAM || "supernoba-orders",
  awsRegion: process.env.AWS_REGION || "ap-northeast-2",

  // MM 기본 설정
  defaultTickInterval: 1000,  // 1초
  statusPublishInterval: 2000,  // 2초마다 상태 발행
};

console.log("=== Supernoba Market Maker Service v9 ===");
console.log("Operating Cache:", CONFIG.operatingCacheHost + ":" + CONFIG.operatingCachePort);
console.log("Kinesis Stream:", CONFIG.kinesisStream);

// === Clients ===
const kinesis = new KinesisClient({ region: CONFIG.awsRegion });

// TLS 설정 (VALKEY_TLS=false이면 비활성화)
const useTls = process.env.VALKEY_TLS !== "false";
const redisOptions = {
  host: CONFIG.operatingCacheHost,
  port: CONFIG.operatingCachePort,
  connectTimeout: 5000,
  lazyConnect: true,
  ...(useTls ? { tls: {} } : {}),
};

// Operating Cache - MM 설정 읽기/쓰기용
const operatingCache = new Redis(redisOptions);

// Backup Cache - Pub/Sub 구독용 (별도 연결 필요)
const operatingCacheSub = new Redis(redisOptions);

operatingCache.on("error", (e) => console.error("[BackupCache] Error:", e.message));
operatingCache.on("connect", () => console.log("[BackupCache] Connected"));
operatingCacheSub.on("error", (e) => console.error("[BackupCache Sub] Error:", e.message));
operatingCacheSub.on("connect", () => console.log("[BackupCache Sub] Connected"));

// === State ===
const activeSymbols = new Map();  // symbol -> { config, interval, orderCount, startedAt }
let isRunning = false;
let statusInterval = null;

// === Price Calculation ===
function calculatePrice(basePrice, config, t) {
  const period = config.period || 600;  // 기본 10분 주기
  const amplitude = config.amplitude || 0.1;  // 기본 10% 진폭

  // 사인파 가격 계산
  const swing = amplitude * Math.sin((2 * Math.PI * t) / period);
  const price = Math.round(basePrice * (1 + swing));

  return Math.max(1, price);  // 최소 가격 1
}

// === Order Publishing ===
async function sendOrder(symbol, side, price, quantity) {
  const userId = side === "BUY" ? "mm-buyer" : "mm-seller";
  const order = {
    user_id: userId,
    order_id: uuidv4(),
    symbol,
    side,
    order_type: "LIMIT",
    quantity,
    price,
    timestamp: Date.now(),
  };

  try {
    const result = await kinesis.send(new PutRecordCommand({
      StreamName: CONFIG.kinesisStream,
      Data: Buffer.from(JSON.stringify(order)),
      PartitionKey: symbol,
    }));
    console.log("[Order] Sent " + side + " order for " + symbol + " @ " + price + " x " + quantity + " -> shard: " + result.ShardId);
    return true;
  } catch (e) {
    console.error("[Order] Failed to send " + side + " order for " + symbol + ":", e.message);
    return false;
  }
}

// === Symbol Runner ===
async function runSymbol(symbol) {
  const instance = activeSymbols.get(symbol);
  if (!instance) return;

  const config = instance.config;
  const basePrice = config.basePrice || 100;
  const quantity = config.tradeQuantity || 10;

  // 경과 시간 (초)
  const t = (Date.now() - instance.startedAt) / 1000;
  const price = calculatePrice(basePrice, config, t);

  // SELL을 먼저 발행 → BUY가 방금 발행한 SELL과 체결 (잔존 매수호가에 체결 방지)
  // Kinesis 파티션 키가 같으므로 순서 보장됨
  const sellSuccess = await sendOrder(symbol, "SELL", price, quantity);
  const buySuccess = await sendOrder(symbol, "BUY", price, quantity);

  if (buySuccess && sellSuccess) {
    instance.orderCount += 2;
    instance.currentPrice = price;
  }

  // Redis에 현재 가격 저장
  await operatingCache.set("mm:price:" + symbol, price.toString());
  await operatingCache.set("mm:orderCount:" + symbol, instance.orderCount.toString());
}

// === Load Config (supports both STRING and HASH types) ===
async function loadConfig(symbol) {
  const key = "mm:config:" + symbol;

  // Check key type first for backward compatibility
  const keyType = await operatingCache.type(key);

  if (keyType === "none") {
    console.log("[Config] No config found for " + symbol + ", using defaults");
    return { basePrice: 100, period: 600, amplitude: 0.1, tickInterval: 1000, tradeQuantity: 10 };
  }

  let config;

  if (keyType === "string") {
    // Legacy format: JSON string (Admin Lambda v1)
    const jsonStr = await operatingCache.get(key);
    try {
      const parsed = JSON.parse(jsonStr);
      config = {
        basePrice: parseFloat(parsed.basePrice) || 100,
        period: parseFloat(parsed.period) || 600,
        amplitude: parseFloat(parsed.amplitude) || 0.1,
        tickInterval: parseInt(parsed.tickInterval) || 1000,
        tradeInterval: parseFloat(parsed.tradeInterval) || 1,
        tradeQuantity: parseInt(parsed.tradeQuantity) || 10,
      };
      console.log("[Config] Loaded STRING config for " + symbol + ":", JSON.stringify(config));
    } catch (e) {
      console.error("[Config] Failed to parse JSON for " + symbol + ":", e.message);
      return { basePrice: 100, period: 600, amplitude: 0.1, tickInterval: 1000, tradeQuantity: 10 };
    }
  } else if (keyType === "hash") {
    // New format: HASH type (Admin Lambda v2)
    const hashData = await operatingCache.hgetall(key);
    config = {
      basePrice: parseFloat(hashData.basePrice) || 100,
      period: parseFloat(hashData.period) || 600,
      amplitude: parseFloat(hashData.amplitude) || 0.1,
      tickInterval: parseInt(hashData.tickInterval) || 1000,
      tradeInterval: parseFloat(hashData.tradeInterval) || 1,
      tradeQuantity: parseInt(hashData.tradeQuantity) || 10,
    };
    console.log("[Config] Loaded HASH config for " + symbol + ":", JSON.stringify(config));
  } else {
    console.error("[Config] Unexpected key type for " + symbol + ":", keyType);
    return { basePrice: 100, period: 600, amplitude: 0.1, tickInterval: 1000, tradeQuantity: 10 };
  }

  return config;
}

// === Symbol Management ===
async function startSymbol(symbol) {
  if (activeSymbols.has(symbol)) {
    console.log("[MM] " + symbol + " already running");
    return;
  }

  // v7: Load config from HASH
  const config = await loadConfig(symbol);
  const tickInterval = config.tickInterval || CONFIG.defaultTickInterval;

  const instance = {
    config,
    orderCount: 0,
    currentPrice: config.basePrice || 100,
    startedAt: Date.now(),
    interval: setInterval(() => runSymbol(symbol), tickInterval),
  };

  activeSymbols.set(symbol, instance);

  // Redis에 시작 시간 기록
  await operatingCache.set("mm:started_at:" + symbol, Date.now().toString());

  console.log("[MM] Started " + symbol + " - basePrice: " + config.basePrice + ", period: " + config.period + "s, amplitude: " + (config.amplitude * 100).toFixed(1) + "%");
}

function stopSymbol(symbol) {
  const instance = activeSymbols.get(symbol);
  if (instance) {
    clearInterval(instance.interval);
    activeSymbols.delete(symbol);
    console.log("[MM] Stopped " + symbol + " - orders: " + instance.orderCount);
  }
}

function stopAllSymbols() {
  for (const [symbol, instance] of activeSymbols) {
    clearInterval(instance.interval);
    console.log("[MM] Stopped " + symbol + " - orders: " + instance.orderCount);
  }
  activeSymbols.clear();
}

// === Status Publishing ===
async function publishStatus() {
  const symbols = [];

  for (const [symbol, instance] of activeSymbols) {
    symbols.push({
      symbol,
      basePrice: instance.config.basePrice || 100,
      price: instance.currentPrice,
      orders: instance.orderCount,
      isRunning: true,
      config: instance.config,
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
          stopSymbol(cmd.symbol);
        }
        break;

      case "startAll":
        // Redis에서 모든 running symbols 가져오기
        const runningSymbols = await operatingCache.smembers("mm:running:symbols");
        for (const symbol of runningSymbols) {
          await startSymbol(symbol);
        }
        break;

      case "stopAll":
        stopAllSymbols();
        break;

      case "reload":
        // 설정 리로드
        if (cmd.symbol && activeSymbols.has(cmd.symbol)) {
          const config = await loadConfig(cmd.symbol);
          const instance = activeSymbols.get(cmd.symbol);
          instance.config = config;
          console.log("[MM] Reloaded config for " + cmd.symbol);
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
      stopSymbol(symbol);
    }
  }

  console.log("[Sync] Active symbols:", activeSymbols.size);
}

// === Main ===
async function main() {
  console.log("[MM] Connecting to Redis...");

  await operatingCache.connect();
  await operatingCacheSub.connect();

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

  console.log("[MM] Market Maker Service ready");
  console.log("[MM] Waiting for control messages on mm:control channel...");
}

// === Graceful Shutdown ===
process.on("SIGINT", async () => {
  console.log("\n[MM] Shutting down...");

  stopAllSymbols();

  if (statusInterval) clearInterval(statusInterval);

  await operatingCache.quit();
  await operatingCacheSub.quit();

  console.log("[MM] Goodbye!");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n[MM] Received SIGTERM, shutting down...");
  stopAllSymbols();
  if (statusInterval) clearInterval(statusInterval);
  await operatingCache.quit();
  await operatingCacheSub.quit();
  process.exit(0);
});

// Start
main().catch((e) => {
  console.error("[MM] Fatal error:", e);
  process.exit(1);
});
