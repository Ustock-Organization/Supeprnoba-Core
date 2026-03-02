import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { getValkeyClient } from '/opt/nodejs/index.mjs';

// Auth Layer 로딩 (Cognito + Supabase 지원)
let verifyAuth = null;
try {
  const authModule = await import('/opt/nodejs/verifyAuth.mjs');
  verifyAuth = authModule.verifyAuth;
  console.log('[subscribe-handler] Auth layer loaded');
} catch (e) {
  console.warn('[subscribe-handler] Auth layer not available:', e.message);
}

// Layer를 통한 Valkey 클라이언트 (default 프리셋: 적절한 재시도)
const valkey = getValkeyClient({ type: 'operating', preset: 'default' });

// API Gateway Management API Client (이벤트별로 재생성)
function getApiClient(event) {
  let endpoint = null;
  
  if (event.requestContext) {
    const domain = event.requestContext.domainName;
    const stage = event.requestContext.stage;
    if (domain && stage) {
      endpoint = `https://${domain}/${stage}`;
    }
  }
  
  if (!endpoint && process.env.WS_ENDPOINT) {
    endpoint = process.env.WS_ENDPOINT.replace('wss://', 'https://').replace('ws://', 'https://');
    if (endpoint.endsWith('/')) {
      endpoint = endpoint.slice(0, -1);
    }
  }
  
  if (!endpoint) {
    endpoint = 'https://l2ptm85wub.execute-api.ap-northeast-2.amazonaws.com/production';
  }
  
  // 매번 새 클라이언트 생성 (이벤트별로 다른 endpoint일 수 있음)
  return new ApiGatewayManagementApiClient({
    region: process.env.AWS_REGION || 'ap-northeast-2',
    endpoint: endpoint
  });
}

// API Gateway Management API를 통해 클라이언트에 메시지 전송
async function sendToClient(connectionId, message, event) {
  if (!connectionId) return false;
  
  try {
    const client = getApiClient(event);
    if (!client) return false;
    
    const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
    const data = new TextEncoder().encode(messageStr);
    
    const command = new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: data
    });
    
    await client.send(command);
    return true;
  } catch (error) {
    if (error.$metadata?.httpStatusCode !== 410) {
      console.error('[subscribe-handler] SendToClient error:', error.message);
    }
    return false;
  }
}


/**
 * subscribe-handler Lambda
 * 
 * 신구 형식 모두 지원:
 * - 구버전: {"action":"subscribe","symbols":["TEST","AAPL"]}
 * - 신버전: {"action":"subscribe","main":"TEST","sub":["AAPL"]}
 */
export const handler = async (event) => {
  let connectionId = event.requestContext?.connectionId || event.connectionId;
  let body = {};
  
  // body가 있으면 파싱
  if (event.body) {
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || {};
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
  } else if (event.action) {
    body = {
      action: event.action,
      token: event.token,
      userId: event.userId,
      main: event.main,
      sub: event.sub,
      symbols: event.symbols
    };
  }
  
  // connectionId가 없으면 userId로 찾기 시도
  if (!connectionId) {
    if (body.action === 'auth' || body.action === 'subscribe') {
      // connectionId 없이는 Valkey 작업 불가, 하지만 응답은 보낼 수 있음
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: 'Not a WebSocket request' }) };
    }
  }
  
  const action = body.action;
  console.log(`[subscribe-handler] Action received: ${action}, connectionId: ${connectionId}`);

  // === ping 액션 처리 (heartbeat + lastSeen 갱신) ===
  if (action === 'ping') {
    if (connectionId) {
      try {
        const connInfo = await valkey.get(`ws:${connectionId}`);
        if (connInfo) {
          const parsed = JSON.parse(connInfo);
          parsed.lastSeen = Date.now();
          await valkey.setex(`ws:${connectionId}`, 86400, JSON.stringify(parsed));
        }
      } catch (e) {
        // lastSeen 갱신 실패해도 pong은 반환
        console.warn(`[subscribe-handler] lastSeen update failed:`, e.message);
      }
      // WebSocket 클라이언트에 pong 전송 (HTTP return은 클라이언트에 도달하지 않음)
      await sendToClient(connectionId, { action: 'pong' }, event);
    }
    return { statusCode: 200, body: JSON.stringify({ action: 'pong' }) };
  }

  // === auth 액션 처리 ===
  if (action === 'auth') {
    if (!connectionId) {
      const userId = body.userId;
      if (userId) {
        try {
          // $connect 핸들러가 완료될 시간을 주기 위해 재시도 (최대 2초 대기)
          let retries = 20; // 20번 재시도로 증가
          let waitTime = 100; // 초기 100ms
          while (retries > 0 && !connectionId) {
            console.log(`[subscribe-handler] Attempt ${11 - retries}/10: Checking user:${userId}:connections`);
            const userConnections = await valkey.smembers(`user:${userId}:connections`);
            console.log(`[subscribe-handler] User connections found: ${userConnections?.length || 0} (retries left: ${retries})`);
            
            if (userConnections && userConnections.length > 0) {
              // 가장 최근 연결 사용 (첫 번째)
              connectionId = userConnections[0];
              console.log(`[subscribe-handler] Found connectionId candidate: ${connectionId}`);
              
              // connectionId가 실제로 ws:connectionId에 존재하는지 확인
              const connInfo = await valkey.get(`ws:${connectionId}`).catch(() => null);
              if (connInfo) {
                console.log(`[subscribe-handler] ✅ Found and verified connectionId from user connections: ${connectionId}`);
                break;
              } else {
                console.log(`[subscribe-handler] ⚠️ ConnectionId ${connectionId} not found in ws:*, trying next`);
                connectionId = null; // 다음 재시도를 위해 리셋
              }
            } else {
              console.log(`[subscribe-handler] No connections found for user:${userId}:connections`);
            }
            
            // 재시도 전에 대기 (점진적으로 증가)
            if (retries > 1) {
              console.log(`[subscribe-handler] Waiting ${waitTime}ms before retry...`);
              await new Promise(resolve => setTimeout(resolve, waitTime));
              waitTime = Math.min(waitTime + 50, 200); // 최대 200ms까지 증가
            }
            retries--;
          }
        } catch (e) {
          console.error('[subscribe-handler] ❌ Failed to find connectionId from user connections:', e.message, e.stack);
        }
      } else {
        console.error('[subscribe-handler] ❌ No userId provided in auth message');
      }
      
      // 여전히 connectionId가 없으면 실패
      if (!connectionId) {
        const errorResponse = { action: 'auth', success: false, reason: 'no_connection_id' };
        return { statusCode: 200, body: JSON.stringify(errorResponse) };
      }
    }
    const token = body.token;

    if (!token) {
      const errorResponse = { action: 'auth', success: false, reason: 'missing_token' };
      if (connectionId) await sendToClient(connectionId, errorResponse, event);
      return { statusCode: 200, body: JSON.stringify(errorResponse) };
    }

    if (!verifyAuth) {
      const errorResponse = { action: 'auth', success: false, reason: 'auth_not_configured' };
      if (connectionId) await sendToClient(connectionId, errorResponse, event);
      return { statusCode: 200, body: JSON.stringify(errorResponse) };
    }

    try {
      // verifyAuth 레이어 사용 (Cognito + Supabase 지원)
      console.log(`[subscribe-handler] 🔐 Calling verifyAuth with token length: ${token?.length || 0}`);
      const authResult = await verifyAuth({ headers: { Authorization: `Bearer ${token}` } });
      console.log(`[subscribe-handler] 📋 verifyAuth result:`, JSON.stringify(authResult));

      if (authResult.success && authResult.userId) {
        const userId = authResult.userId;
        const email = authResult.email;

        // 기존 연결 정보 읽기 (connectedAt 유지, oldUserId 확인)
        const connInfoRaw = await valkey.get(`ws:${connectionId}`);
        let oldUserId = null;
        let originalConnectedAt = Date.now();
        if (connInfoRaw) {
          try {
            const parsed = JSON.parse(connInfoRaw);
            oldUserId = parsed.userId;
            originalConnectedAt = parsed.connectedAt || originalConnectedAt;
          } catch (e) {}
        }

        // 연결 정보 업데이트 (connectedAt 유지, lastSeen 갱신)
        const now = Date.now();
        await valkey.setex(`ws:${connectionId}`, 86400, JSON.stringify({
          userId,
          isLoggedIn: true,
          userEmail: email,
          connectedAt: originalConnectedAt,
          lastSeen: now,
          provider: authResult.provider
        }));

        // 사용자별 연결 목록 업데이트 (익명→로그인 전환 시 기존 데이터 정리)
        if (oldUserId && oldUserId !== userId) {
          await valkey.srem(`user:${oldUserId}:connections`, connectionId);
          console.log(`[subscribe-handler] Cleaned up old user connection: ${oldUserId}`);
        }
        await valkey.sadd(`user:${userId}:connections`, connectionId);
        // realtime:connections 제거됨 - 브로드캐스트에서 미사용

        console.log(`[subscribe-handler] ✅ Authenticated: ${userId} (${email}) via ${authResult.provider}`);

        const authResponse = { action: 'auth', success: true, userId, connectionId };
        if (connectionId) await sendToClient(connectionId, authResponse, event);
        return { statusCode: 200, body: JSON.stringify(authResponse) };
      } else {
        console.error(`[subscribe-handler] ❌ Auth failed:`, authResult.error, authResult.message);
        const errorResponse = { action: 'auth', success: false, reason: authResult.error || 'invalid_token' };
        if (connectionId) await sendToClient(connectionId, errorResponse, event);
        return { statusCode: 200, body: JSON.stringify(errorResponse) };
      }
    } catch (e) {
      console.error(`[subscribe-handler] ❌ Auth exception:`, e.message);
      const errorResponse = { action: 'auth', success: false, reason: 'validation_error' };
      if (connectionId) await sendToClient(connectionId, errorResponse, event);
      return { statusCode: 200, body: JSON.stringify(errorResponse) };
    }
  }
  
  // === subscribe 액션 처리 ===
  // subscribe 또는 명시적 action이 없는 경우 (하위 호환)
  if (action !== 'subscribe' && action !== undefined) {
    console.log(`[subscribe-handler] Unknown action: ${action}`);
    return { statusCode: 200, body: JSON.stringify({ action: 'unknown' }) };
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
    // 삭제된 종목 목록 가져오기
    const deletedSymbols = await valkey.smembers('deleted:symbols');
    const deletedSet = new Set(deletedSymbols);

    if (main) {
      // 삭제된 종목은 구독 불가
      if (deletedSet.has(main.toUpperCase())) {
        console.log(`[subscribe-handler] Blocked subscription to deleted symbol: ${main}`);
        if (connectionId) {
          await sendToClient(connectionId, { action: 'error', code: 'SYMBOL_DELETED', message: `Symbol ${main} has been deleted` }, event);
        }
        return { statusCode: 400, body: JSON.stringify({ error: `Symbol ${main} has been deleted` }) };
      }

      // 기존 main 구독 해제
      const prevMain = await valkey.get(`conn:${connectionId}:main`);
      if (prevMain && prevMain !== main) {
        await valkey.srem(`symbol:${prevMain}:subscribers`, connectionId);
        await valkey.srem(`symbol:${prevMain}:main`, connectionId);
      }

      // 구버전 키도 함께 설정 (Streamer 호환)
      await valkey.sadd(`symbol:${main}:subscribers`, connectionId);
      await valkey.sadd(`symbol:${main}:main`, connectionId);
      await valkey.setex(`conn:${connectionId}:main`, 86400, main);
      await valkey.sadd('subscribed:symbols', main);
    }

    for (const symbol of sub || []) {
      // 삭제된 종목은 구독 불가
      if (deletedSet.has(symbol.toUpperCase())) {
        console.log(`[subscribe-handler] Skipped subscription to deleted symbol: ${symbol}`);
        continue;
      }
      await valkey.sadd(`symbol:${symbol}:subscribers`, connectionId);
      await valkey.sadd(`symbol:${symbol}:sub`, connectionId);
      await valkey.sadd('subscribed:symbols', symbol);
    }
    
    // Send subscribed notification back to client
    if (connectionId && main) {
      await sendToClient(connectionId, { action: 'subscribed', symbol: main, sub: sub || [], connectionId }, event);
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

