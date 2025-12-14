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
 * 신구 형식 모두 지원:
 * - 구버전: {"action":"subscribe","symbols":["TEST","AAPL"]}
 * - 신버전: {"action":"subscribe","main":"TEST","sub":["AAPL"]}
 */
export const handler = async (event) => {
  const connectionId = event.requestContext?.connectionId;
  
  // connectionId가 없으면 WebSocket이 아닌 요청
  if (!connectionId) {
    console.error('No connectionId - event:', JSON.stringify(event));
    return { statusCode: 400, body: JSON.stringify({ error: 'Not a WebSocket request' }) };
  }
  
  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};
  } catch (e) {
    console.error('Failed to parse body:', e.message);
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  
  // 신구 형식 모두 지원
  let { main, sub, symbols } = body;
  
  // 구버전: symbols 배열 → 첫 번째가 main
  if (!main && symbols && Array.isArray(symbols)) {
    main = symbols[0];
    sub = symbols.slice(1);
  }
  
  console.log(`Subscribe: ${connectionId} main=${main}, sub=${JSON.stringify(sub || [])}`);
  
  try {
    if (main) {
      // 기존 main 구독 해제
      const prevMain = await valkey.get(`conn:${connectionId}:main`);
      if (prevMain && prevMain !== main) {
        await valkey.srem(`symbol:${prevMain}:subscribers`, connectionId);
        await valkey.srem(`symbol:${prevMain}:main`, connectionId);
      }
      
      // 구버전 키도 함께 설정 (Streamer 호환)
      await valkey.sadd(`symbol:${main}:subscribers`, connectionId);
      await valkey.sadd(`symbol:${main}:main`, connectionId);
      await valkey.set(`conn:${connectionId}:main`, main);
      await valkey.sadd('subscribed:symbols', main);
    }
    
    for (const symbol of sub || []) {
      await valkey.sadd(`symbol:${symbol}:subscribers`, connectionId);
      await valkey.sadd(`symbol:${symbol}:sub`, connectionId);
      await valkey.sadd('subscribed:symbols', symbol);
    }
    
    return { 
      statusCode: 200, 
      body: JSON.stringify({ main: main || null, sub: sub || [] }) 
    };
  } catch (error) {
    console.error('Error:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
