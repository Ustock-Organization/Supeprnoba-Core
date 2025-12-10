// connect-handler Lambda
import Redis from 'ioredis'; // Valkey 호환

// 새 ElastiCache (Non-TLS)
const VALKEY_TLS = process.env.VALKEY_TLS === 'true';

const valkey = new Redis({
  host: process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com',
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  tls: VALKEY_TLS ? {} : undefined,
});

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const userId = event.queryStringParameters?.userId || 'anonymous';
  
  console.log(`New connection: ${connectionId}, userId: ${userId}`);
  
  // 연결 정보 저장 (24시간 TTL)
  await valkey.setex(`ws:${connectionId}`, 86400, JSON.stringify({
    userId,
    connectedAt: Date.now(),
  }));
  
  // 사용자별 연결 목록에 추가
  await valkey.sadd(`user:${userId}:connections`, connectionId);
  
  return { statusCode: 200, body: 'Connected' };
};
