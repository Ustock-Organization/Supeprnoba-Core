// disconnect-handler Lambda
// 연결 해제 시 모든 관련 캐시 정리 + 만료된 connectionId 정리

import { getValkeyClient } from '/opt/nodejs/index.mjs';

// Layer를 통한 Valkey 클라이언트 (websocket 프리셋)
const valkey = getValkeyClient({ type: 'operating', preset: 'websocket' });

export const handler = async (event) => {
  const connectionId = event.requestContext?.connectionId;
  
  if (!connectionId) {
    console.error('[disconnect] ❌ Missing connectionId');
    return { statusCode: 400, body: 'Missing connectionId' };
  }
  
  console.log(`[disconnect] Disconnecting: ${connectionId}`);
  
  // Valkey 연결 시도
  try {
    if (valkey.status !== 'ready') {
      await valkey.connect().catch(() => {});
    }
  } catch (e) {
    console.warn(`[disconnect] Valkey connection warning:`, e.message);
  }
  
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
      
      // 구독자 0명이면 subscribed:symbols에서 제거
      const remainingMain = await valkey.scard(`symbol:${mainSymbol}:main`);
      const remainingLegacy = await valkey.scard(`symbol:${mainSymbol}:subscribers`);
      if (remainingMain === 0 && remainingLegacy === 0) {
        await valkey.srem('subscribed:symbols', mainSymbol);
        console.log(`[disconnect] Removed ${mainSymbol} from subscribed:symbols (no subscribers)`);
      }
      
      console.log(`[disconnect] Removed main subscription: ${mainSymbol}`);
    }
    
    // === 3. Sub 구독 정리 (SCAN) ===
    let cursor = '0';
    do {
      const [newCursor, keys] = await valkey.scan(cursor, 'MATCH', 'symbol:*:*', 'COUNT', 100);
      cursor = newCursor;
      
      for (const key of keys) {
        if (key.endsWith(':subscribers') || key.endsWith(':main') || key.endsWith(':sub')) {
          const removed = await valkey.srem(key, connectionId);
          if (removed > 0) console.log(`[disconnect] Removed from ${key}`);
        }
      }
    } while (cursor !== '0');
    
    // === 4. user:userId:connections에서 제거 ===
    if (userId) {
      await valkey.srem(`user:${userId}:connections`, connectionId);
      console.log(`[disconnect] Removed ${connectionId} from user:${userId}:connections`);
      
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
        console.log(`[disconnect] Cleaned ${staleCount} stale connections for user:${userId}`);
      }
      
      // === 6. 연결이 모두 비어있으면 user 키 삭제 ===
      const remainingConns = await valkey.scard(`user:${userId}:connections`);
      if (remainingConns === 0) {
        await valkey.del(`user:${userId}:connections`);
        console.log(`[disconnect] Deleted empty user:${userId}:connections`);
      }
    }
    
    // === 7. ws:connectionId 삭제 ===
    await valkey.del(`ws:${connectionId}`);
    console.log(`[disconnect] Deleted ws:${connectionId}`);

    // realtime:connections 제거됨 - 브로드캐스트에서 미사용

    console.log(`[disconnect] ✅ Completed: ${connectionId}`);
    return { statusCode: 200, body: 'Disconnected' };
    
  } catch (error) {
    console.error('[disconnect] ❌ Disconnect error:', error.message, error.stack);
    return { statusCode: 500, body: 'Error' };
  }
};
