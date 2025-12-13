// disconnect-handler Lambda
// 연결 해제 시 모든 관련 캐시 정리 + 만료된 connectionId 정리

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
    // === 1. ws:connectionId에서 userId 조회 ===
    const connInfo = await valkey.get(`ws:${connectionId}`);
    let userId = null;
    
    if (connInfo) {
      try {
        const parsed = JSON.parse(connInfo);
        userId = parsed.userId;
      } catch (e) {
        console.warn('Failed to parse connection info:', e.message);
      }
    }
    
    // === 2. Main 구독 해제 ===
    const mainSymbol = await valkey.get(`conn:${connectionId}:main`);
    if (mainSymbol) {
      await valkey.srem(`symbol:${mainSymbol}:main`, connectionId);
      await valkey.srem(`symbol:${mainSymbol}:subscribers`, connectionId);
      await valkey.del(`conn:${connectionId}:main`);
      console.log(`Removed main subscription: ${mainSymbol}`);
    }
    
    // === 3. Sub 구독 정리 (SCAN) ===
    let cursor = '0';
    do {
      const [newCursor, keys] = await valkey.scan(cursor, 'MATCH', 'symbol:*:*', 'COUNT', 100);
      cursor = newCursor;
      
      for (const key of keys) {
        if (key.endsWith(':subscribers') || key.endsWith(':main') || key.endsWith(':sub')) {
          const removed = await valkey.srem(key, connectionId);
          if (removed > 0) console.log(`Removed from ${key}`);
        }
      }
    } while (cursor !== '0');
    
    // === 4. user:userId:connections에서 제거 ===
    if (userId) {
      await valkey.srem(`user:${userId}:connections`, connectionId);
      console.log(`Removed ${connectionId} from user:${userId}:connections`);
      
      // === 5. 만료된 connectionId 정리 (해당 userId) ===
      const allConns = await valkey.smembers(`user:${userId}:connections`);
      let staleCount = 0;
      
      for (const connId of allConns) {
        // ws:connId 키가 존재하는지 확인
        const exists = await valkey.exists(`ws:${connId}`);
        if (!exists) {
          // ws 키가 없으면 이미 만료된 연결 → 제거
          await valkey.srem(`user:${userId}:connections`, connId);
          staleCount++;
        }
      }
      
      if (staleCount > 0) {
        console.log(`Cleaned ${staleCount} stale connections for user:${userId}`);
      }
      
      // === 6. 연결이 모두 비어있으면 user 키 삭제 ===
      const remainingConns = await valkey.scard(`user:${userId}:connections`);
      if (remainingConns === 0) {
        await valkey.del(`user:${userId}:connections`);
        console.log(`Deleted empty user:${userId}:connections`);
      }
    }
    
    // === 7. ws:connectionId 삭제 ===
    await valkey.del(`ws:${connectionId}`);
    console.log(`Deleted ws:${connectionId}`);
    
    return { statusCode: 200, body: 'Disconnected' };
    
  } catch (error) {
    console.error('Disconnect error:', error.message);
    return { statusCode: 500, body: 'Error' };
  }
};
