/**
 * Supernoba Auth Layer - JWT Verification
 *
 * Supabase JWT 검증 및 사용자 인증 처리
 *
 * 환경변수:
 * - SUPABASE_JWT_SECRET: Supabase JWT 시크릿 키
 * - ADMIN_API_KEY: 관리자 API 키 (선택적, 기존 인증과 병행)
 */

import { createHmac } from 'crypto';

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

    // 2. JWT 시크릿 확인
    const jwtSecret = process.env.SUPABASE_JWT_SECRET;
    if (!jwtSecret) {
      console.error('[verifyAuth] SUPABASE_JWT_SECRET not configured');
      return { success: false, error: 'CONFIG_ERROR', message: '서버 설정 오류' };
    }

    // 3. JWT 검증
    const payload = verifyHS256(token, jwtSecret);

    // 4. 사용자 정보 추출
    const userId = payload.sub;
    const email = payload.email;
    const role = payload.role || 'authenticated';

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
      payload
    };

  } catch (error) {
    const errorMap = {
      'INVALID_TOKEN_FORMAT': { code: 'INVALID_TOKEN', message: '잘못된 토큰 형식입니다' },
      'UNSUPPORTED_ALGORITHM': { code: 'INVALID_TOKEN', message: '지원하지 않는 알고리즘입니다' },
      'INVALID_SIGNATURE': { code: 'INVALID_TOKEN', message: '토큰 서명이 유효하지 않습니다' },
      'TOKEN_EXPIRED': { code: 'TOKEN_EXPIRED', message: '토큰이 만료되었습니다' },
      'TOKEN_NOT_YET_VALID': { code: 'INVALID_TOKEN', message: '토큰이 아직 유효하지 않습니다' }
    };

    const errorInfo = errorMap[error.message] || { code: 'AUTH_ERROR', message: error.message };

    console.error('[verifyAuth] Error:', error.message);
    return { success: false, error: errorInfo.code, message: errorInfo.message };
  }
}

/**
 * 관리자 인증 (기존 API 키 방식과 JWT 병행)
 *
 * @param {Object} event - Lambda 이벤트 객체
 * @param {Object} options - 옵션
 * @param {boolean} options.allowApiKey - API 키 인증 허용 여부 (기본: true)
 * @returns {AuthResult} 인증 결과
 */
export async function verifyAdmin(event, options = {}) {
  const { allowApiKey = true } = options;

  // 1. 기존 API 키 방식 확인 (하위 호환성)
  if (allowApiKey) {
    const adminApiKey = process.env.ADMIN_API_KEY;
    const authHeader = event.headers?.Authorization || event.headers?.authorization;

    if (adminApiKey && authHeader === adminApiKey) {
      return { success: true, userId: 'admin', role: 'admin', method: 'api_key' };
    }
  }

  // 2. JWT 인증 시도
  const authResult = await verifyAuth(event);

  if (!authResult.success) {
    return authResult;
  }

  // 3. 관리자 권한 확인
  // Supabase JWT의 app_metadata에서 admin 확인 또는 하드코딩된 관리자 이메일
  const isAdmin =
    authResult.role === 'admin' ||
    authResult.role === 'service_role' ||
    authResult.payload?.app_metadata?.is_admin === true ||
    authResult.payload?.user_metadata?.is_admin === true ||
    ['admin@supernoba.com', 'tchinnom@gmail.com'].includes(authResult.email?.toLowerCase());

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

  if (authResult.userId !== resourceUserId) {
    return {
      success: false,
      error: 'FORBIDDEN',
      message: '자신의 리소스에만 접근할 수 있습니다',
      userId: authResult.userId
    };
  }

  return authResult;
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

export default { verifyAuth, verifyAdmin, verifySelf, authErrorResponse };
