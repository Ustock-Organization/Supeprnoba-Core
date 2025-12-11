import Redis from 'ioredis';

// Valkey 연결 설정
const VALKEY_TLS = process.env.VALKEY_TLS === 'true';

const valkey = new Redis({
  host: process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com',
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  tls: VALKEY_TLS ? {} : undefined,
  connectTimeout: 5000,
  maxRetriesPerRequest: 1,
});

valkey.on('error', (err) => {
  console.error('Redis connection error:', err.message);
});

/**
 * subscribe-handler Lambda
 * 
 * 요청 형식:
 * - Main 구독: {"action":"subscribe","main":"TEST"}
 * - Sub 구독: {"action":"subscribe","sub":["AAPL","GOOGL"]}
 * - 복합: {"action":"subscribe","main":"TEST","sub":["AAPL","GOOGL"]}
 * 
 * 한 클라이언트(connectionId)는:
 * - Main: 1개만 (변경 시 이전 main 자동 해제)
 * - Sub: 무제한
 */
export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const body = JSON.parse(event.body);
  const { main, sub } = body;
  
  console.log(`Subscribe request from ${connectionId}: main=${main}, sub=${JSON.stringify(sub)}`);
  
  try {
    // === Main 구독 처리 (1개만) ===
    if (main) {
      // 기존 main 구독 해제
      const prevMain = await valkey.get(`conn:${connectionId}:main`);
      if (prevMain && prevMain !== main) {
        await valkey.srem(`symbol:${prevMain}:main`, connectionId);
        console.log(`Released prev main subscription: ${prevMain}`);
      }
      
      // 새 main 등록
      await valkey.set(`conn:${connectionId}:main`, main);
      await valkey.sadd(`symbol:${main}:main`, connectionId);
      await valkey.sadd('active:symbols', main);
      console.log(`Main subscribed: ${main}`);
    }
    
    // === Sub 구독 처리 (무제한) ===
    for (const symbol of sub || []) {
      await valkey.sadd(`symbol:${symbol}:sub`, connectionId);
      await valkey.sadd('active:symbols', symbol);
      console.log(`Sub subscribed: ${symbol}`);
    }
    
    return { 
      statusCode: 200, 
      body: JSON.stringify({ 
        main: main || null, 
        sub: sub || [] 
      }) 
    };
  } catch (error) {
    console.error('Redis error:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
