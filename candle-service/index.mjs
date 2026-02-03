/**
 * Supernoba Candle Aggregation Service - LOCAL VERSION
 *
 * 기능:
 * - supernoba:trades 채널 구독하여 체결 데이터 수신
 * - 1분봉 실시간 생성 (candle:1m:SYMBOL 해시)
 * - 1분 경과시 candle:closed:1m:SYMBOL 리스트에 마감 캔들 추가
 * - 상위 타임프레임 집계 (5m, 15m, 1h, 4h, 1d)
 * - 실시간 캔들 업데이트 발행 (supernoba:candle 채널)
 *
 * 실행: node index.mjs
 */

import Redis from 'ioredis';

// === Configuration ===
const CONFIG = {
  redisHost: process.env.REDIS_HOST || 'localhost',
  redisPort: parseInt(process.env.REDIS_PORT || '6379'),
  maxClosedCandles: 1000,  // 각 타임프레임별 최대 저장 캔들 수
};

// === Timeframes ===
const TIMEFRAMES = [
  { interval: '1m', seconds: 60 },
  { interval: '5m', seconds: 300 },
  { interval: '15m', seconds: 900 },
  { interval: '1h', seconds: 3600 },
  { interval: '4h', seconds: 14400 },
  { interval: '1d', seconds: 86400 },
];

console.log('=== Supernoba Candle Aggregation Service - LOCAL ===');
console.log(`Redis: ${CONFIG.redisHost}:${CONFIG.redisPort}`);

// === Redis Clients ===
const redis = new Redis({
  host: CONFIG.redisHost,
  port: CONFIG.redisPort,
  connectTimeout: 5000,
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 100, 3000),
});

const redisSub = new Redis({
  host: CONFIG.redisHost,
  port: CONFIG.redisPort,
  connectTimeout: 5000,
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 100, 3000),
});

redis.on('error', (e) => console.error('[Redis] Error:', e.message));
redis.on('connect', () => console.log('[Redis] Connected'));
redisSub.on('error', (e) => console.error('[Redis Sub] Error:', e.message));
redisSub.on('connect', () => console.log('[Redis Sub] Connected'));

// === State: 진행중인 캔들 ===
// { symbol: { interval: { open, high, low, close, volume, startTime, count } } }
const currentCandles = new Map();

// === Utility Functions ===
function getTimeframeStart(epoch, seconds) {
  return Math.floor(epoch / 1000 / seconds) * seconds * 1000;
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').substr(0, 19);
}

// === Candle Management ===
function getOrCreateCandle(symbol, interval, seconds, timestamp) {
  if (!currentCandles.has(symbol)) {
    currentCandles.set(symbol, new Map());
  }
  
  const symbolCandles = currentCandles.get(symbol);
  const tfStart = getTimeframeStart(timestamp, seconds);
  
  // 현재 캔들이 같은 타임프레임인지 확인
  const existing = symbolCandles.get(interval);
  if (existing && existing.startTime === tfStart) {
    return { candle: existing, isNew: false };
  }
  
  // 새 캔들 생성 (기존 캔들이 있으면 마감 필요)
  const closedCandle = existing || null;
  
  const newCandle = {
    symbol,
    interval,
    startTime: tfStart,
    open: 0,
    high: 0,
    low: Infinity,
    close: 0,
    volume: 0,
    count: 0,
  };
  
  symbolCandles.set(interval, newCandle);
  return { candle: newCandle, isNew: true, closedCandle };
}

async function updateCandle(symbol, price, quantity, timestamp) {
  const updatedCandles = [];
  const closedCandles = [];
  
  for (const tf of TIMEFRAMES) {
    const { candle, isNew, closedCandle } = getOrCreateCandle(
      symbol, tf.interval, tf.seconds, timestamp
    );
    
    // 마감된 캔들 처리
    if (closedCandle && closedCandle.count > 0) {
      closedCandles.push({ ...closedCandle });
    }
    
    // 캔들 업데이트
    if (candle.count === 0) {
      candle.open = price;
      candle.high = price;
      candle.low = price;
    } else {
      candle.high = Math.max(candle.high, price);
      candle.low = Math.min(candle.low, price);
    }
    candle.close = price;
    candle.volume += quantity;
    candle.count++;
    
    updatedCandles.push(candle);
  }
  
  return { updatedCandles, closedCandles };
}

// === Redis Storage ===
async function saveCurrentCandle(candle) {
  const key = `candle:${candle.interval}:${candle.symbol}`;
  
  // 진행중인 캔들을 해시로 저장
  await redis.hset(key, {
    t: candle.startTime.toString(),
    o: candle.open.toString(),
    h: candle.high.toString(),
    l: candle.low.toString(),
    c: candle.close.toString(),
    v: candle.volume.toString(),
  });
}

async function saveClosedCandle(candle) {
  const key = `candle:closed:${candle.interval}:${candle.symbol}`;
  
  // 마감된 캔들을 JSON으로 리스트에 추가
  const candleJson = JSON.stringify({
    t: candle.startTime,
    o: candle.open,
    h: candle.high,
    l: candle.low,
    c: candle.close,
    v: candle.volume,
  });
  
  await redis.rpush(key, candleJson);
  
  // 최대 개수 유지 (오래된 것 제거)
  const len = await redis.llen(key);
  if (len > CONFIG.maxClosedCandles) {
    await redis.ltrim(key, len - CONFIG.maxClosedCandles, -1);
  }
  
  console.log(`[Closed] ${candle.symbol} ${candle.interval} @ ${formatTimestamp(candle.startTime)} | O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close} V:${candle.volume}`);
}

async function publishCandleUpdate(candle) {
  const data = {
    e: 'candle',
    s: candle.symbol,
    i: candle.interval,
    t: candle.startTime,
    o: candle.open,
    h: candle.high,
    l: candle.low,
    c: candle.close,
    v: candle.volume,
  };
  
  await redis.publish('supernoba:candle', JSON.stringify(data));
}

// === Trade Handler ===
async function handleTrade(trade) {
  const { symbol, price, quantity, timestamp } = trade;
  
  if (!symbol || !price) {
    return;
  }
  
  const ts = timestamp || Date.now();
  const qty = quantity || 1;
  
  // 모든 타임프레임 캔들 업데이트
  const { updatedCandles, closedCandles } = await updateCandle(symbol, price, qty, ts);
  
  // 마감된 캔들 저장
  for (const closed of closedCandles) {
    await saveClosedCandle(closed);
  }
  
  // 현재 캔들 저장 및 발행
  for (const candle of updatedCandles) {
    await saveCurrentCandle(candle);
    await publishCandleUpdate(candle);
  }
}

// === Periodic Candle Check (분 경계 마감 처리) ===
async function checkCandleClosures() {
  const now = Date.now();
  
  for (const [symbol, symbolCandles] of currentCandles) {
    for (const tf of TIMEFRAMES) {
      const candle = symbolCandles.get(tf.interval);
      if (!candle || candle.count === 0) continue;
      
      const tfEnd = candle.startTime + tf.seconds * 1000;
      
      // 타임프레임 종료 확인
      if (now >= tfEnd) {
        // 마감 처리
        await saveClosedCandle(candle);
        
        // 새 캔들 시작 (마지막 종가를 시가로)
        const newStart = getTimeframeStart(now, tf.seconds);
        const newCandle = {
          symbol,
          interval: tf.interval,
          startTime: newStart,
          open: candle.close,
          high: candle.close,
          low: candle.close,
          close: candle.close,
          volume: 0,
          count: 0,
        };
        symbolCandles.set(tf.interval, newCandle);
        await saveCurrentCandle(newCandle);
      }
    }
  }
}

// === Initialize from existing ticker data ===
async function initializeFromTickers() {
  console.log('[Init] Initializing candles from existing ticker data...');
  
  const symbols = await redis.smembers('active:symbols');
  const now = Date.now();
  
  for (const symbol of symbols) {
    const tickerJson = await redis.get(`ticker:${symbol}`);
    if (tickerJson) {
      try {
        const ticker = JSON.parse(tickerJson);
        const price = ticker.c || ticker.price || 0;
        
        if (price > 0) {
          // 초기 캔들 생성
          for (const tf of TIMEFRAMES) {
            const { candle } = getOrCreateCandle(symbol, tf.interval, tf.seconds, now);
            candle.open = price;
            candle.high = price;
            candle.low = price;
            candle.close = price;
            candle.volume = 0;
            candle.count = 1;
            
            await saveCurrentCandle(candle);
          }
          
          console.log(`[Init] ${symbol}: initialized at price ${price}`);
        }
      } catch (e) {
        console.error(`[Init] Error parsing ticker for ${symbol}:`, e.message);
      }
    }
  }
}

// === Main ===
async function main() {
  console.log('[Candle] Connecting to Redis...');
  
  await redis.connect();
  await redisSub.connect();
  
  // 기존 ticker 데이터로 초기화
  await initializeFromTickers();
  
  // supernoba:trades 채널 구독
  await redisSub.subscribe('supernoba:trades');
  console.log('[Candle] Subscribed to supernoba:trades channel');
  
  redisSub.on('message', async (channel, message) => {
    if (channel === 'supernoba:trades') {
      try {
        const trade = JSON.parse(message);
        await handleTrade(trade);
      } catch (e) {
        console.error('[Trade] Parse error:', e.message);
      }
    }
  });
  
  // 주기적 캔들 마감 체크 (매 초)
  setInterval(checkCandleClosures, 1000);
  
  console.log('[Candle] Candle Aggregation Service ready');
  console.log('[Candle] Aggregating: 1m, 5m, 15m, 1h, 4h, 1d');
}

// === Graceful Shutdown ===
process.on('SIGINT', async () => {
  console.log('\n[Candle] Shutting down...');
  
  // 진행중인 모든 캔들 마감 저장
  for (const [symbol, symbolCandles] of currentCandles) {
    for (const [interval, candle] of symbolCandles) {
      if (candle.count > 0) {
        await saveClosedCandle(candle);
      }
    }
  }
  
  await redis.quit();
  await redisSub.quit();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[Candle] SIGTERM received');
  await redis.quit();
  await redisSub.quit();
  process.exit(0);
});

main().catch((e) => {
  console.error('[Candle] Fatal error:', e);
  process.exit(1);
});
