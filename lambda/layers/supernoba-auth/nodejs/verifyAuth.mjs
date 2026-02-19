/**
 * Supernoba Auth Layer - JWT Verification
 *
 * Cognito (RS256) 및 Supabase (HS256) JWT 검증
 *
 * 환경변수:
 * - COGNITO_USER_POOL_ID: Cognito User Pool ID (RS256)
 * - COGNITO_REGION: Cognito 리전 (기본: ap-northeast-2)
 * - SUPABASE_JWT_SECRET: Supabase JWT 시크릿 키 (HS256, 레거시)
 * - USERS_TABLE: 사용자 캐시 테이블 (기본: supernoba-user-cache)
 */

import { createHmac, createVerify } from 'crypto';
import https from 'https';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

// DynamoDB 클라이언트 (관리자 확인용)
const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' })
);
const USERS_TABLE = process.env.USERS_TABLE || 'supernoba-users';

// Cognito JWKS 캐시
let cognitoJwksCache = null;
let cognitoJwksCacheTime = 0;
const JWKS_CACHE_TTL = 3600000; // 1시간

// Cognito 설정
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const COGNITO_REGION = process.env.COGNITO_REGION || 'ap-northeast-2';
const COGNITO_ISSUER = COGNITO_USER_POOL_ID
  ? `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}`
  : null;

// Base64URL 디코딩
function base64UrlDecode(str) {
  // Base64URL to Base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  // 패딩 추가
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

// JWT 검증 (HS256)
function verifyHS256(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('INVALID_TOKEN_FORMAT');
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // 헤더 검증
  const header = JSON.parse(base64UrlDecode(headerB64));
  if (header.alg !== 'HS256') {
    throw new Error('UNSUPPORTED_ALGORITHM');
  }

  // 서명 검증
  const signatureInput = `${headerB64}.${payloadB64}`;
  const expectedSignature = createHmac('sha256', secret)
    .update(signatureInput)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  if (signatureB64 !== expectedSignature) {
    throw new Error('INVALID_SIGNATURE');
  }

  // 페이로드 파싱
  const payload = JSON.parse(base64UrlDecode(payloadB64));

  // 만료 시간 검증
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new Error('TOKEN_EXPIRED');
  }

  // 발행 시간 검증 (선택적)
  if (payload.iat && payload.iat > now + 60) {
    throw new Error('TOKEN_NOT_YET_VALID');
  }

  return payload;
}

// JWKS 가져오기 (Cognito)
async function getCognitoJwks() {
  const now = Date.now();
  if (cognitoJwksCache && (now - cognitoJwksCacheTime) < JWKS_CACHE_TTL) {
    return cognitoJwksCache;
  }

  const jwksUrl = `${COGNITO_ISSUER}/.well-known/jwks.json`;

  return new Promise((resolve, reject) => {
    https.get(jwksUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          cognitoJwksCache = JSON.parse(data);
          cognitoJwksCacheTime = now;
          resolve(cognitoJwksCache);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// JWK를 PEM 공개키로 변환
function jwkToPem(jwk) {
  const n = Buffer.from(jwk.n, 'base64');
  const e = Buffer.from(jwk.e, 'base64');

  // RSA 공개키 DER 인코딩
  const nLen = n.length;
  const eLen = e.length;

  // INTEGER 인코딩
  const nInt = Buffer.concat([
    Buffer.from([0x02]),
    nLen > 127 ? Buffer.from([0x82, (nLen + 1) >> 8, (nLen + 1) & 0xff]) : Buffer.from([nLen + 1]),
    Buffer.from([0x00]),
    n
  ]);

  const eInt = Buffer.concat([
    Buffer.from([0x02]),
    eLen > 127 ? Buffer.from([0x82, eLen >> 8, eLen & 0xff]) : Buffer.from([eLen]),
    e
  ]);

  // SEQUENCE (n, e)
  const rsaSeqContent = Buffer.concat([nInt, eInt]);
  const rsaSeqLen = rsaSeqContent.length;
  const rsaSeq = Buffer.concat([
    Buffer.from([0x30]),
    rsaSeqLen > 127 ? Buffer.from([0x82, rsaSeqLen >> 8, rsaSeqLen & 0xff]) : Buffer.from([rsaSeqLen]),
    rsaSeqContent
  ]);

  // BIT STRING
  const bitString = Buffer.concat([
    Buffer.from([0x03]),
    (rsaSeq.length + 1) > 127
      ? Buffer.from([0x82, (rsaSeq.length + 1) >> 8, (rsaSeq.length + 1) & 0xff])
      : Buffer.from([rsaSeq.length + 1]),
    Buffer.from([0x00]),
    rsaSeq
  ]);

  // Algorithm OID (RSA)
  const algorithmOid = Buffer.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
    0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00
  ]);

  // 최종 SEQUENCE
  const pubKeyContent = Buffer.concat([algorithmOid, bitString]);
  const pubKeyLen = pubKeyContent.length;
  const pubKey = Buffer.concat([
    Buffer.from([0x30]),
    pubKeyLen > 127 ? Buffer.from([0x82, pubKeyLen >> 8, pubKeyLen & 0xff]) : Buffer.from([pubKeyLen]),
    pubKeyContent
  ]);

  const pem = `-----BEGIN PUBLIC KEY-----\n${pubKey.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;
  return pem;
}

// RS256 검증 (Cognito)
async function verifyRS256(token) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('INVALID_TOKEN_FORMAT');
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(base64UrlDecode(headerB64));

  if (header.alg !== 'RS256') {
    throw new Error('UNSUPPORTED_ALGORITHM');
  }

  // JWKS에서 공개키 찾기
  const jwks = await getCognitoJwks();
  const key = jwks.keys.find(k => k.kid === header.kid);

  if (!key) {
    throw new Error('KEY_NOT_FOUND');
  }

  // JWK를 PEM으로 변환
  const pem = jwkToPem(key);

  // 서명 검증
  const signatureInput = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(signatureB64, 'base64url');

  const verifier = createVerify('RSA-SHA256');
  verifier.update(signatureInput);

  if (!verifier.verify(pem, signature)) {
    throw new Error('INVALID_SIGNATURE');
  }

  // 페이로드 파싱 및 검증
  const payload = JSON.parse(base64UrlDecode(payloadB64));
  const now = Math.floor(Date.now() / 1000);

  if (payload.exp && payload.exp < now) {
    throw new Error('TOKEN_EXPIRED');
  }

  // issuer 검증
  if (payload.iss !== COGNITO_ISSUER) {
    throw new Error('INVALID_ISSUER');
  }

  return payload;
}

/**
 * 인증 결과 타입
 * @typedef {Object} AuthResult
 * @property {boolean} success - 인증 성공 여부
 * @property {string} [userId] - 사용자 ID (성공 시)
 * @property {string} [email] - 사용자 이메일 (성공 시)
 * @property {string} [role] - 사용자 역할 (성공 시)
 * @property {Object} [payload] - JWT 전체 페이로드 (성공 시)
 * @property {string} [error] - 에러 코드 (실패 시)
 * @property {string} [message] - 에러 메시지 (실패 시)
 */

/**
 * JWT 토큰 검증
 *
 * @param {Object} event - Lambda 이벤트 객체
 * @param {Object} options - 옵션
 * @param {boolean} options.required - 인증 필수 여부 (기본: true)
 * @param {string[]} options.allowedRoles - 허용된 역할 목록 (선택적)
 * @returns {AuthResult} 인증 결과
 */
export async function verifyAuth(event, options = {}) {
  const { required = true, allowedRoles = null } = options;

  try {
    // 0. 개발 모드 체크
    const jwtSecret = process.env.SUPABASE_JWT_SECRET;
    if (!jwtSecret && !COGNITO_USER_POOL_ID) {
      console.warn('[verifyAuth] DEV MODE: No auth configured, skipping');
      return { success: true, userId: null, anonymous: true, devMode: true };
    }

    // 1. Authorization 헤더에서 토큰 추출
    const authHeader = event.headers?.Authorization || event.headers?.authorization;

    if (!authHeader) {
      if (!required) {
        return { success: true, userId: null, anonymous: true };
      }
      return { success: false, error: 'NO_TOKEN', message: '인증 토큰이 필요합니다' };
    }

    // Bearer 토큰 추출
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : authHeader;

    if (!token || token.trim() === '') {
      return { success: false, error: 'EMPTY_TOKEN', message: '토큰이 비어있습니다' };
    }

    // 2. 토큰 알고리즘 확인 및 검증
    let payload;
    let provider = 'unknown';

    const headerB64 = token.split('.')[0];
    const header = JSON.parse(base64UrlDecode(headerB64));

    if (header.alg === 'RS256' && COGNITO_ISSUER) {
      // Cognito JWT (RS256)
      payload = await verifyRS256(token);
      provider = 'cognito';
    } else if (header.alg === 'HS256' && jwtSecret) {
      // Supabase JWT (HS256)
      payload = verifyHS256(token, jwtSecret);
      provider = 'supabase';
    } else {
      throw new Error('UNSUPPORTED_ALGORITHM');
    }

    // 3. 사용자 정보 추출 (provider에 따라 다름)
    let userId, email, role;

    if (provider === 'cognito') {
      userId = payload.sub; // Cognito는 sub에 username (x_12345)
      email = payload.email;
      role = payload['custom:role'] || 'authenticated';
      console.log('[verifyAuth] Cognito JWT decoded:', {
        sub: payload.sub,
        email: payload.email,
        role: role,
        customXUserId: payload['custom:x_user_id'],
        username: payload['cognito:username'] || payload.username
      });
    } else {
      userId = payload.sub;
      email = payload.email;
      role = payload.role || 'authenticated';
      console.log('[verifyAuth] Supabase JWT decoded:', { sub: payload.sub, email, role });
    }

    // 5. 역할 검증 (설정된 경우)
    if (allowedRoles && !allowedRoles.includes(role)) {
      return {
        success: false,
        error: 'FORBIDDEN',
        message: '접근 권한이 없습니다',
        userId,
        role
      };
    }

    return {
      success: true,
      userId,
      email,
      role,
      payload,
      provider
    };

  } catch (error) {
    const errorMap = {
      'INVALID_TOKEN_FORMAT': { code: 'INVALID_TOKEN', message: '잘못된 토큰 형식입니다' },
      'UNSUPPORTED_ALGORITHM': { code: 'INVALID_TOKEN', message: '지원하지 않는 알고리즘입니다' },
      'INVALID_SIGNATURE': { code: 'INVALID_TOKEN', message: '토큰 서명이 유효하지 않습니다' },
      'TOKEN_EXPIRED': { code: 'TOKEN_EXPIRED', message: '토큰이 만료되었습니다' },
      'TOKEN_NOT_YET_VALID': { code: 'INVALID_TOKEN', message: '토큰이 아직 유효하지 않습니다' },
      'KEY_NOT_FOUND': { code: 'INVALID_TOKEN', message: 'JWT 키를 찾을 수 없습니다' },
      'INVALID_ISSUER': { code: 'INVALID_TOKEN', message: '유효하지 않은 토큰 발급자입니다' }
    };

    const errorInfo = errorMap[error.message] || { code: 'AUTH_ERROR', message: error.message };

    console.error('[verifyAuth] Error:', error.message);
    return { success: false, error: errorInfo.code, message: errorInfo.message };
  }
}

/**
 * 관리자 인증 (Cognito JWT 전용)
 *
 * @param {Object} event - Lambda 이벤트 객체
 * @returns {AuthResult} 인증 결과
 */
export async function verifyAdmin(event) {
  // JWT 인증 시도 (5초 타임아웃)
  const authPromise = verifyAuth(event);
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('AUTH_TIMEOUT')), 5000)
  );
  
  let authResult;
  try {
    authResult = await Promise.race([authPromise, timeoutPromise]);
  } catch (timeoutErr) {
    console.error('[verifyAdmin] JWT verification timeout - VPC may not have internet access');
    return { success: false, error: 'AUTH_TIMEOUT', message: '인증 서버 연결 실패. 관리자에게 문의하세요.' };
  }

  if (!authResult.success) {
    return authResult;
  }

  // 3. 관리자 권한 확인
  // JWT 클레임 또는 DynamoDB user-cache에서 is_admin 확인

  // 부트스트랩 관리자: Cognito sub로 직접 인식 (DynamoDB 설정 전 임시)
  const BOOTSTRAP_ADMINS = [
    '3438cdec-f071-700b-e035-dc6fc4f68009', // njg7194@gmail.com
  ];

  let isAdmin =
    authResult.role === 'admin' ||
    authResult.role === 'service_role' ||
    authResult.payload?.app_metadata?.is_admin === true ||
    authResult.payload?.user_metadata?.is_admin === true ||
    BOOTSTRAP_ADMINS.includes(authResult.userId);

  // JWT 클레임에 admin이 없으면 DynamoDB user-cache 조회
  if (!isAdmin && authResult.userId) {
    try {
      // X 로그인 사용자의 경우 email 또는 custom:x_user_id에서 user_id 추출
      let userId = authResult.userId;

      // 1. custom:x_user_id가 있으면 그것을 사용 (가장 정확함)
      const xUserId = authResult.payload?.['custom:x_user_id'];
      if (xUserId) {
        userId = `x_${xUserId}`;
      }
      // 2. email이 X 형식이면 email에서 추출 (Cognito sub는 UUID이므로 email 사용)
      else if (authResult.email?.includes('@x.supernoba.com')) {
        const xId = authResult.email.split('@')[0];
        userId = `x_${xId}`;
      }
      // 3. userId가 이미 X 형식이면 (fallback)
      else if (userId.includes('@x.supernoba.com')) {
        const xId = userId.split('@')[0];
        userId = `x_${xId}`;
      }

      console.log(`[verifyAdmin] Looking up user in DynamoDB:`, {
        finalUserId: userId,
        originalUserId: authResult.userId,
        email: authResult.email,
        customXUserId: authResult.payload?.['custom:x_user_id'],
        table: USERS_TABLE
      });

      const { Item } = await dynamodb.send(new GetCommand({
        TableName: USERS_TABLE,
        Key: { user_id: userId }
      }));

      if (Item?.is_admin === true) {
        isAdmin = true;
        console.log(`[verifyAdmin] Admin confirmed from user-cache: ${userId}`);
      } else {
        console.log(`[verifyAdmin] Not admin or not found: ${userId}, is_admin=${Item?.is_admin}`);
      }
    } catch (dbError) {
      console.warn('[verifyAdmin] DynamoDB lookup failed:', dbError.message);
      // DB 조회 실패 시 admin 거부 (안전한 기본값)
    }
  }

  if (!isAdmin) {
    return {
      success: false,
      error: 'FORBIDDEN',
      message: '관리자 권한이 필요합니다',
      userId: authResult.userId,
      role: authResult.role
    };
  }

  return {
    ...authResult,
    method: 'jwt'
  };
}

/**
 * 사용자 본인 확인 (자신의 리소스에만 접근 가능)
 *
 * @param {Object} event - Lambda 이벤트 객체
 * @param {string} resourceUserId - 리소스 소유자 ID
 * @returns {AuthResult} 인증 결과
 */
export async function verifySelf(event, resourceUserId) {
  const authResult = await verifyAuth(event);

  if (!authResult.success) {
    return authResult;
  }

  // 개발 모드 (devMode: true 또는 anonymous: true)면 userId 검증 스킵
  if (authResult.devMode || authResult.anonymous) {
    return { ...authResult, userId: resourceUserId };
  }

  // X 로그인 사용자: Cognito sub(UUID)와 요청의 x_ user_id 매핑
  let resolvedUserId = authResult.userId;
  const xUserId = authResult.payload?.['custom:x_user_id'];
  if (xUserId) {
    resolvedUserId = `x_${xUserId}`;
  } else if (authResult.email?.includes('@x.supernoba.com')) {
    const xId = authResult.email.split('@')[0];
    resolvedUserId = `x_${xId}`;
  }

  // Google 로그인 사용자: identities 클레임에서 Google sub 추출 → google_{sub} 형식
  if (resolvedUserId === authResult.userId && resourceUserId?.startsWith('google_')) {
    let googleSub = null;
    try {
      const identities = typeof authResult.payload?.identities === 'string'
        ? JSON.parse(authResult.payload.identities)
        : authResult.payload?.identities;
      if (Array.isArray(identities)) {
        const googleId = identities.find(id => id.providerName === 'Google');
        if (googleId) googleSub = googleId.userId;
      }
    } catch { /* ignore parse errors */ }

    // Fallback: cognito:username "Google_123456" 패턴
    if (!googleSub) {
      const cognitoUsername = authResult.payload?.['cognito:username'] || '';
      if (cognitoUsername.startsWith('Google_')) {
        googleSub = cognitoUsername.replace('Google_', '');
      }
    }

    if (googleSub) {
      resolvedUserId = `google_${googleSub}`;
    }
  }

  if (resolvedUserId !== resourceUserId) {
    console.warn('[verifySelf] User ID mismatch:', { resolved: resolvedUserId, resource: resourceUserId, original: authResult.userId });
    return {
      success: false,
      error: 'FORBIDDEN',
      message: '자신의 리소스에만 접근할 수 있습니다',
      userId: resolvedUserId
    };
  }

  return { ...authResult, userId: resolvedUserId };
}

/**
 * 인증 실패 시 HTTP 응답 생성
 *
 * @param {AuthResult} authResult - 인증 결과
 * @param {Object} headers - CORS 헤더 등
 * @returns {Object} Lambda 응답 객체
 */
export function authErrorResponse(authResult, headers = {}) {
  const defaultHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    ...headers
  };

  const statusCode =
    authResult.error === 'NO_TOKEN' || authResult.error === 'EMPTY_TOKEN' ? 401 :
    authResult.error === 'TOKEN_EXPIRED' || authResult.error === 'INVALID_TOKEN' ? 401 :
    authResult.error === 'FORBIDDEN' ? 403 :
    authResult.error === 'CONFIG_ERROR' ? 500 : 401;

  return {
    statusCode,
    headers: defaultHeaders,
    body: JSON.stringify({
      error: authResult.error,
      message: authResult.message
    })
  };
}

/**
 * Auth Layer 로딩 헬퍼 (Fallback 포함)
 * 각 Lambda에서 중복되는 try-catch fallback 코드를 제거
 *
 * @param {string} context - 로깅용 컨텍스트 이름
 * @returns {Object} { verifyAuth, verifyAdmin, verifySelf, authErrorResponse }
 */
export function createFallbackAuth(context = 'lambda') {
  console.warn(`[${context}] Auth layer not available, using fallback`);

  const fallbackVerify = async () => ({ success: true, userId: null, anonymous: true });
  const fallbackAdmin = async () => {
    return { success: false, error: 'UNAUTHORIZED', message: '인증이 필요합니다' };
  };
  const fallbackErrorResponse = (result, headers = {}) => ({
    statusCode: 401,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ error: result.error, message: result.message })
  });

  return {
    verifyAuth: fallbackVerify,
    verifySelf: fallbackVerify,
    verifyAdmin: fallbackAdmin,
    authErrorResponse: fallbackErrorResponse
  };
}

export default { verifyAuth, verifyAdmin, verifySelf, authErrorResponse, createFallbackAuth };
