/**
 * Supernoba CORS Headers Layer
 *
 * 20개+ Lambda 함수의 CORS 설정을 통합 관리
 * 8가지 변형을 4가지 프리셋으로 표준화
 */

// CORS 프리셋 정의
export const CORS = Object.freeze({
  /**
   * Type FULL: 전체 CRUD (Admin, 사용자 관리 등)
   * Methods: DELETE, GET, OPTIONS, POST, PUT
   */
  FULL: Object.freeze({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'DELETE, GET, OPTIONS, POST, PUT',
    'Content-Type': 'application/json',
  }),

  /**
   * Type STANDARD: 표준 API (인증, 주문 등)
   * Methods: GET, OPTIONS, POST
   */
  STANDARD: Object.freeze({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS, POST',
    'Content-Type': 'application/json',
  }),

  /**
   * Type READONLY: 읽기 전용 (자산 조회, 차트 데이터 등)
   * Methods: GET, OPTIONS
   */
  READONLY: Object.freeze({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  }),

  /**
   * Type WITH_API_KEY: API Key 포함 (레거시 지원)
   * Methods: GET, OPTIONS, POST
   */
  WITH_API_KEY: Object.freeze({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
    'Access-Control-Allow-Methods': 'GET, OPTIONS, POST',
    'Content-Type': 'application/json',
  }),
});

/**
 * 응답 헬퍼 함수들
 */
export const response = {
  /**
   * 성공 응답
   * @param {*} data - 응답 데이터
   * @param {Object} [headers=CORS.STANDARD] - CORS 헤더
   * @param {number} [statusCode=200] - HTTP 상태 코드
   */
  ok: (data, headers = CORS.STANDARD, statusCode = 200) => ({
    statusCode,
    headers,
    body: JSON.stringify(data),
  }),

  /**
   * 에러 응답
   * @param {number} code - HTTP 상태 코드
   * @param {string} message - 에러 메시지
   * @param {Object} [headers=CORS.STANDARD] - CORS 헤더
   */
  error: (code, message, headers = CORS.STANDARD) => ({
    statusCode: code,
    headers,
    body: JSON.stringify({ error: message }),
  }),

  /**
   * 상세 에러 응답 (개발 환경용)
   * @param {number} code - HTTP 상태 코드
   * @param {string} errorCode - 에러 코드
   * @param {string} message - 에러 메시지
   * @param {Object} [details=null] - 추가 상세 정보
   * @param {Object} [headers=CORS.STANDARD] - CORS 헤더
   */
  errorDetail: (code, errorCode, message, details = null, headers = CORS.STANDARD) => ({
    statusCode: code,
    headers,
    body: JSON.stringify({
      error: errorCode,
      message,
      ...(details && process.env.NODE_ENV !== 'production' && { details }),
    }),
  }),

  /**
   * OPTIONS 프리플라이트 응답
   * @param {Object} [headers=CORS.STANDARD] - CORS 헤더
   */
  options: (headers = CORS.STANDARD) => ({
    statusCode: 200,
    headers,
    body: '',
  }),

  /**
   * 201 Created 응답
   * @param {*} data - 생성된 리소스 데이터
   * @param {Object} [headers=CORS.STANDARD] - CORS 헤더
   */
  created: (data, headers = CORS.STANDARD) => ({
    statusCode: 201,
    headers,
    body: JSON.stringify(data),
  }),

  /**
   * 204 No Content 응답
   * @param {Object} [headers=CORS.STANDARD] - CORS 헤더
   */
  noContent: (headers = CORS.STANDARD) => ({
    statusCode: 204,
    headers,
    body: '',
  }),
};

/**
 * OPTIONS 프리플라이트 요청 핸들러
 *
 * @param {Object} event - Lambda 이벤트
 * @param {Object} [headers=CORS.STANDARD] - CORS 헤더
 * @returns {Object|null} OPTIONS 응답 또는 null (다른 메서드인 경우)
 *
 * @example
 * export const handler = async (event) => {
 *   const optionsResponse = handleOptions(event, CORS.FULL);
 *   if (optionsResponse) return optionsResponse;
 *
 *   // 실제 요청 처리...
 * };
 */
export function handleOptions(event, headers = CORS.STANDARD) {
  const method = event.httpMethod || event.requestContext?.http?.method;
  if (method === 'OPTIONS') {
    return response.options(headers);
  }
  return null;
}

/**
 * HTTP 메서드 추출
 *
 * @param {Object} event - Lambda 이벤트
 * @returns {string} HTTP 메서드 (대문자)
 */
export function getHttpMethod(event) {
  return (event.httpMethod || event.requestContext?.http?.method || 'GET').toUpperCase();
}

/**
 * 에러 코드별 응답 생성
 */
export const ErrorCodes = Object.freeze({
  UNAUTHORIZED: { code: 401, error: 'UNAUTHORIZED', message: '인증이 필요합니다' },
  FORBIDDEN: { code: 403, error: 'FORBIDDEN', message: '권한이 없습니다' },
  NOT_FOUND: { code: 404, error: 'NOT_FOUND', message: '리소스를 찾을 수 없습니다' },
  BAD_REQUEST: { code: 400, error: 'BAD_REQUEST', message: '잘못된 요청입니다' },
  VALIDATION_ERROR: { code: 400, error: 'VALIDATION_ERROR', message: '입력값이 유효하지 않습니다' },
  CONFLICT: { code: 409, error: 'CONFLICT', message: '리소스가 이미 존재합니다' },
  INTERNAL_ERROR: { code: 500, error: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다' },
});

/**
 * 에러 코드로 응답 생성
 *
 * @param {string} errorKey - ErrorCodes의 키
 * @param {string} [customMessage] - 커스텀 메시지 (선택)
 * @param {Object} [headers=CORS.STANDARD] - CORS 헤더
 */
export function errorByCode(errorKey, customMessage, headers = CORS.STANDARD) {
  const errDef = ErrorCodes[errorKey] || ErrorCodes.INTERNAL_ERROR;
  return response.error(errDef.code, customMessage || errDef.message, headers);
}

// 기본 export
export default { CORS, response, handleOptions, getHttpMethod, ErrorCodes, errorByCode };
