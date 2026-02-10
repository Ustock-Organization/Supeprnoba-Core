import { verifyAuth } from '/opt/nodejs/verifyAuth.mjs';
import { getValkeyClient, createLegacyClient } from '/opt/nodejs/index.mjs';

// Layer를 통한 Valkey 클라이언트 (websocket 프리셋: 빠른 실패, 재시도 없음)
const valkey = getValkeyClient({ type: 'operating', preset: 'websocket' });

// 시작 시 환경변수 상태 로깅 (Cold Start 시)
console.log(`[connect-handler] STARTUP - Cognito config:`, {
  hasCOGNITO_USER_POOL_ID: !!process.env.COGNITO_USER_POOL_ID,
});

function generateAnonymousId() {
  return `anonymous_${Math.random().toString(36).substr(2, 6)}`;
}


const connectHandler = async (event) => {
  const connectionId = event.requestContext?.connectionId;
  
  console.log(`[connect] Connection request: ${connectionId}`);
  
  if (!connectionId) {
    console.error('[connect] ❌ Missing connectionId');
    return { statusCode: 400, body: 'Missing connectionId' };
  }
  
  const token = event.queryStringParameters?.token;
  const legacyUserId = event.queryStringParameters?.userId;
  const testMode = event.queryStringParameters?.testMode === 'true';
  
  // 상세 인증 로깅
  console.log(`[connect] Auth parameters:`, {
    hasToken: !!token,
    tokenLength: token?.length || 0,
    hasLegacyUserId: !!legacyUserId,
    testMode: testMode,
  });

  let userId = legacyUserId || generateAnonymousId();
  let isLoggedIn = false;
  let userEmail = null;

  if (testMode && process.env.ALLOW_TEST_MODE === 'true') {
    userId = legacyUserId || 'test-user-default';
    isLoggedIn = true;
    console.log(`[connect] ✅ Test mode auth: ${userId}`);
  } else if (token) {
    try {
      console.log(`[connect] 🔐 Validating JWT token...`);
      const authResult = await verifyAuth({ headers: { Authorization: `Bearer ${token}` } });
      if (authResult.success) {
        userId = authResult.userId;
        userEmail = authResult.email;
        isLoggedIn = true;
        console.log(`[connect] ✅ JWT validated (${authResult.provider}) - user: ${userId} (${userEmail})`);
      } else {
        console.log(`[connect] ❌ JWT validation failed:`, authResult.error);
      }
    } catch (e) {
      console.warn(`[connect] ❌ JWT validation error:`, e.message);
    }
  } else {
    console.log(`[connect] No token → anonymous user: ${userId}`);
  }

  // 정지 사용자 WebSocket 연결 거부 (로그인 사용자만 체크)
  if (isLoggedIn && userId) {
    try {
      if (valkey.status === 'ready') {
        const isSuspended = await valkey.get(`user:${userId}:suspended`);
        if (isSuspended === 'true') {
          console.log(`[connect] Blocked suspended user: ${userId}`);
          return { statusCode: 403, body: 'Account suspended' };
        }
      }
    } catch (e) {
      console.warn(`[connect] Suspend check failed (fail-open): ${e.message}`);
    }
  }

  // Valkey 연결 시도 (최대 3회 재시도)
  let valkeyConnected = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (valkey.status !== 'ready') {
        await valkey.connect();
      }
      valkeyConnected = true;
      console.log(`[connect] ✅ Valkey connected (attempt ${attempt})`);
      break;
    } catch (e) {
      console.warn(`[connect] Valkey connection attempt ${attempt}/3 failed:`, e.message);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 100 * attempt)); // 100ms, 200ms, 300ms
      }
    }
  }

  if (!valkeyConnected) {
    console.error('[connect] ❌ Valkey connection failed after 3 attempts - continuing without cache');
  }

  // 연결 정보 저장 (lastSeen 추가 - cleanup에서 활성 여부 판단용)
  const now = Date.now();
  const connectionInfo = {
    userId,
    isLoggedIn,
    userEmail,
    connectedAt: now,
    lastSeen: now,  // 하트비트마다 갱신됨
  };
  
  try {
    await Promise.race([
      valkey.setex(`ws:${connectionId}`, 86400, JSON.stringify(connectionInfo)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
    ]);
    console.log(`[connect] ✅ Saved connection info: ws:${connectionId}`);
    
    // 저장 확인 (읽기로 검증)
    const verify = await valkey.get(`ws:${connectionId}`).catch(() => null);
    if (verify) {
      console.log(`[connect] ✅ Verified connection info saved: ws:${connectionId}`);
    } else {
      console.warn(`[connect] ⚠️ Could not verify connection info save`);
    }
  } catch (e) {
    console.error(`[connect] ❌ Failed to save connection info:`, e.message);
    // 실패해도 계속 진행 (fallback 핸들러가 처리)
  }
  
  // 사용자별 연결 목록에 추가
  try {
    await Promise.race([
      valkey.sadd(`user:${userId}:connections`, connectionId),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
    ]);
    console.log(`[connect] ✅ Added to user:${userId}:connections`);
    
    // 저장 확인
    const userConns = await valkey.smembers(`user:${userId}:connections`).catch(() => []);
    if (userConns.includes(connectionId)) {
      console.log(`[connect] ✅ Verified connectionId in user:${userId}:connections`);
    } else {
      console.warn(`[connect] ⚠️ Could not verify connectionId in user connections`);
    }
  } catch (e) {
    console.error(`[connect] ❌ Failed to add to user connections:`, e.message);
  }

  // realtime:connections 제거됨 - 브로드캐스트에서 미사용, symbol:*:main/sub로 대체
  console.log(`[connect] ✅ Completed: ${connectionId}, userId: ${userId}, isLoggedIn: ${isLoggedIn}`);
  return { statusCode: 200, body: 'Connected' };
};

export const handler = async (event) => {
  try {
    return await connectHandler(event);
  } catch (err) {
    const connectionId = event.requestContext?.connectionId;
    if (connectionId) {
      try {
        // Fallback: Layer를 통한 레거시 클라이언트 생성
        const fallbackValkey = createLegacyClient({
          host: process.env.VALKEY_HOST,
          port: parseInt(process.env.VALKEY_PORT || '6379'),
          tls: process.env.VALKEY_TLS === 'true' ? {} : undefined,
          connectTimeout: 5000,
          maxRetriesPerRequest: 1,
        });
        const anonymousId = generateAnonymousId();
        const now = Date.now();
        await fallbackValkey.setex(`ws:${connectionId}`, 86400, JSON.stringify({
          userId: anonymousId,
          isLoggedIn: false,
          userEmail: null,
          connectedAt: now,
          lastSeen: now,
        })).catch(() => {});
        await fallbackValkey.sadd(`user:${anonymousId}:connections`, connectionId).catch(() => {});
        await fallbackValkey.quit().catch(() => {});
      } catch (e) {
        // Ignore
      }
    }
    return { statusCode: 200, body: 'Connected (fallback)' };
  }
};
