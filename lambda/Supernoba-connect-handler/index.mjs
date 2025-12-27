// connect-handler Lambda
// Supabase JWT 검증 + 로그인 사용자 구분
import Redis from 'ioredis';
import { createClient } from '@supabase/supabase-js';

// 환경변수
const VALKEY_TLS = process.env.VALKEY_TLS === 'true';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const valkey = new Redis({
  host: process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com',
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  tls: VALKEY_TLS ? {} : undefined,
  connectTimeout: 5000,
  maxRetriesPerRequest: 1,
});

valkey.on('error', (err) => console.error('Redis error:', err.message));

// Supabase 클라이언트 (지연 초기화)
let supabase = null;
function getSupabase() {
  if (!supabase && SUPABASE_URL && SUPABASE_ANON_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return supabase;
}

// 익명 userId 생성
function generateAnonymousId() {
  return `anonymous_${Math.random().toString(36).substr(2, 6)}`;
}

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const token = event.queryStringParameters?.token;
  const legacyUserId = event.queryStringParameters?.userId;
  const testMode = event.queryStringParameters?.testMode === 'true';
  
  console.log(`[connect] Connection: ${connectionId}, token: ${token ? 'present' : 'missing'}, userId param: ${legacyUserId}`);
  
  let userId = legacyUserId || generateAnonymousId();
  let isLoggedIn = false;
  let userEmail = null;
  
  // === 테스트 모드: JWT 없이 로그인 처리 (개발/테스트 환경 전용) ===
  if (testMode && process.env.ALLOW_TEST_MODE === 'true') {
    userId = legacyUserId || 'test-user-default';
    isLoggedIn = true;
    console.log(`[TEST MODE] Authenticated as: ${userId}`);
  }
  // === JWT 토큰 검증 (운영 환경) ===
  else if (token && getSupabase()) {
    try {
      console.log(`[connect] Validating JWT token...`);
      const { data: { user }, error } = await getSupabase().auth.getUser(token);
      
      if (user && !error) {
        userId = user.id;
        userEmail = user.email;
        isLoggedIn = true;
        console.log(`[connect] Authenticated user: ${userId} (${userEmail})`);
      } else {
        console.warn(`[connect] JWT validation failed:`, error?.message || 'Unknown error');
      }
    } catch (e) {
      console.warn(`[connect] JWT validation error:`, e.message);
    }
  } else if (legacyUserId && !legacyUserId.startsWith('anonymous')) {
    // 레거시 호환: userId가 명시적으로 주어진 경우 (테스트용)
    console.log(`[connect] Legacy userId provided: ${legacyUserId} (not authenticated)`);
  } else {
    console.log(`[connect] No token provided, using anonymous userId: ${userId}`);
  }
  
  console.log(`[connect] New connection: ${connectionId}, userId: ${userId}, isLoggedIn: ${isLoggedIn}`);
  
  // 연결 정보 저장 (24시간 TTL)
  await valkey.setex(`ws:${connectionId}`, 86400, JSON.stringify({
    userId,
    isLoggedIn,
    userEmail,
    connectedAt: Date.now(),
  }));
  
  // 사용자별 연결 목록에 추가
  await valkey.sadd(`user:${userId}:connections`, connectionId);
  
  // === [Optimized] Stale Connection Cleanup ===
  // 연결 시점에도 만료된 연결 정리 (Disconnect 이벤트 누락 대비)
  const allConns = await valkey.smembers(`user:${userId}:connections`);
  if (allConns.length > 5) { // 너무 자주 체크하지 않도록 5개 이상일 때만
    const pipeline = valkey.pipeline();
    for (const connId of allConns) {
      if (connId !== connectionId) {
        pipeline.exists(`ws:${connId}`);
      }
    }
    const results = await pipeline.exec();
    
    // 결과 확인 및 삭제
    const staleConns = [];
    let resultIdx = 0;
    for (const connId of allConns) {
      if (connId !== connectionId) {
        const [err, exists] = results[resultIdx++];
        if (!err && exists === 0) {
          staleConns.push(connId);
        }
      }
    }
    
    if (staleConns.length > 0) {
      await valkey.srem(`user:${userId}:connections`, ...staleConns);
      console.log(`Cleaned ${staleConns.length} stale connections for ${userId}`);
    }
  }

  // 로그인 사용자는 별도 Set에 추가 (Streamer가 빠르게 조회)
  if (isLoggedIn) {
    await valkey.sadd('realtime:connections', connectionId);
  }
  
  return { statusCode: 200, body: 'Connected' };
};
