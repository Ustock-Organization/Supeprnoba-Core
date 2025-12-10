// disconnect-handler Lambda
import Redis from 'ioredis';

// 새 ElastiCache (Non-TLS)
const VALKEY_TLS = process.env.VALKEY_TLS === 'true';

const valkey = new Redis({
  host: process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com',
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  tls: VALKEY_TLS ? {} : undefined,
});

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  
  console.log(`Disconnecting: ${connectionId}`);
  
  // 연결 정보 조회
  const connInfo = await valkey.get(`ws:${connectionId}`);
  if (connInfo) {
    const { userId } = JSON.parse(connInfo);
    await valkey.srem(`user:${userId}:connections`, connectionId);
  }
  
  // 모든 심볼 구독에서 제거 (SCAN으로 패턴 매칭)
  let cursor = '0';
  do {
    const [newCursor, keys] = await valkey.scan(cursor, 'MATCH', 'symbol:*:subscribers', 'COUNT', 100);
    cursor = newCursor;
    
    for (const key of keys) {
      await valkey.srem(key, connectionId);
    }
  } while (cursor !== '0');
  
  // 연결 정보 삭제
  await valkey.del(`ws:${connectionId}`);
  
  console.log(`Cleaned up subscriptions for: ${connectionId}`);
  
  return { statusCode: 200, body: 'Disconnected' };
};
