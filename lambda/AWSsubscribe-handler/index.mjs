import Redis from 'ioredis';

// 새 ElastiCache (Non-TLS)
const VALKEY_TLS = process.env.VALKEY_TLS === 'true'; // 기본값 false

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

// subscribe-handler Lambda
export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const body = JSON.parse(event.body);
  const { symbols } = body; // ["AAPL", "GOOGL"]
  
  console.log(`Subscribe request from ${connectionId}: ${symbols?.join(', ')}`);
  
  try {
    for (const symbol of symbols || []) {
      // 심볼 구독자 추가
      const result = await valkey.sadd(`symbol:${symbol}:subscribers`, connectionId);
      // 활성 심볼 목록에 추가 (Streamer가 조회)
      await valkey.sadd('active:symbols', symbol);
      console.log(`Added ${connectionId} to symbol:${symbol}:subscribers, result: ${result}`);
    }
    
    return { statusCode: 200, body: JSON.stringify({ subscribed: symbols }) };
  } catch (error) {
    console.error('Redis error:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
