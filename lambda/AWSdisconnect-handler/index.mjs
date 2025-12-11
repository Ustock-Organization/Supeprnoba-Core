// disconnect-handler Lambda
// Main + Sub 구독 모두 정리

import Redis from 'ioredis';

const VALKEY_TLS = process.env.VALKEY_TLS === 'true';

const valkey = new Redis({
  host: process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com',
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  tls: VALKEY_TLS ? {} : undefined,
});

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  
  console.log(`Disconnecting: ${connectionId}`);
  
  try {
    // === Main 구독 해제 ===
    const mainSymbol = await valkey.get(`conn:${connectionId}:main`);
    if (mainSymbol) {
      await valkey.srem(`symbol:${mainSymbol}:main`, connectionId);
      await valkey.del(`conn:${connectionId}:main`);
      console.log(`Removed main subscription: ${mainSymbol}`);
    }
    
    // === Sub 구독 해제 (SCAN으로 패턴 매칭) ===
    let cursor = '0';
    do {
      const [newCursor, keys] = await valkey.scan(cursor, 'MATCH', 'symbol:*:sub', 'COUNT', 100);
      cursor = newCursor;
      
      for (const key of keys) {
        const removed = await valkey.srem(key, connectionId);
        if (removed > 0) {
          console.log(`Removed from ${key}`);
        }
      }
    } while (cursor !== '0');
    
    // === 사용자 연결 정보 정리 ===
    const connInfo = await valkey.get(`ws:${connectionId}`);
    if (connInfo) {
      try {
        const { userId } = JSON.parse(connInfo);
        if (userId) {
          await valkey.srem(`user:${userId}:connections`, connectionId);
        }
      } catch (e) {}
    }
    await valkey.del(`ws:${connectionId}`);
    
    console.log(`Cleaned up all subscriptions for: ${connectionId}`);
    
    return { statusCode: 200, body: 'Disconnected' };
  } catch (error) {
    console.error('Disconnect error:', error.message);
    return { statusCode: 500, body: 'Error' };
  }
};
