/**
 * Supernoba Valkey/Redis Client Layer
 *
 * Lambda 함수의 Redis 설정을 통합 관리 (4개 캐시 아키텍처)
 *
 * 환경변수:
 * - VALKEY_HOST: 기본 Redis 호스트
 * - VALKEY_PORT: Redis 포트 (기본: 6379)
 * - VALKEY_TLS: TLS 사용 여부 ('true' | 'false')
 * - DEPTH_CACHE_HOST: Depth Cache 전용 호스트 (depth:*, ticker:*)
 * - BACKUP_CACHE_HOST: Backup Cache 전용 호스트 (snapshot:*, checkpoint:*)
 * - OPERATING_CACHE_HOST: Operating Cache 전용 호스트 (ws:*, mm:*, rankings:*)
 * - CANDLE_CACHE_HOST: Candle Cache 전용 호스트 (candle:*, supernoba:trades)
 */

import Redis from 'ioredis';

// 캐시 타입별 호스트 설정 (4개 캐시 아키텍처)
const CACHE_CONFIGS = {
  depth: {
    getHost: () => process.env.DEPTH_CACHE_HOST || process.env.VALKEY_HOST,
    name: 'depth-cache',
  },
  backup: {
    getHost: () => process.env.BACKUP_CACHE_HOST || process.env.VALKEY_HOST,
    name: 'backup-cache',
  },
  operating: {
    getHost: () => process.env.OPERATING_CACHE_HOST || process.env.VALKEY_HOST,
    name: 'operating-cache',
  },
  candle: {
    getHost: () => process.env.CANDLE_CACHE_HOST || process.env.VALKEY_HOST,
    name: 'candle-cache',
  },
  default: {
    getHost: () => process.env.VALKEY_HOST,
    name: 'default-cache',
  },
};

// 연결 프리셋 정의
const CONNECTION_PRESETS = {
  // WebSocket 핸들러용 (빠른 실패, 재시도 없음)
  websocket: {
    connectTimeout: 3000,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    retryStrategy: () => null,
    enableOfflineQueue: false,
  },
  // Admin 함수용 (안정적 연결)
  admin: {
    connectTimeout: 5000,
    maxRetriesPerRequest: 3,
    lazyConnect: false,
    retryStrategy: (times) => (times <= 3 ? Math.min(times * 100, 1000) : null),
    enableOfflineQueue: true,
  },
  // 기본 설정
  default: {
    connectTimeout: 5000,
    maxRetriesPerRequest: 2,
    lazyConnect: true,
    retryStrategy: (times) => (times <= 2 ? Math.min(times * 100, 500) : null),
    enableOfflineQueue: false,
  },
};

// 싱글톤 인스턴스 캐시
const instances = new Map();

/**
 * Valkey/Redis 클라이언트 생성 또는 기존 인스턴스 반환
 *
 * @param {Object} options - 클라이언트 옵션
 * @param {string} [options.type='default'] - 캐시 타입 ('depth' | 'backup' | 'operating' | 'candle' | 'default')
 * @param {string} [options.preset='default'] - 연결 프리셋 ('websocket' | 'admin' | 'default')
 * @param {Object} [options.overrides={}] - 추가 Redis 옵션 (프리셋 덮어쓰기)
 * @returns {Redis} Redis 클라이언트 인스턴스
 *
 * @example
 * // WebSocket 핸들러용
 * const valkey = getValkeyClient({ type: 'depth', preset: 'websocket' });
 *
 * // Admin 함수용
 * const valkey = getValkeyClient({ preset: 'admin' });
 *
 * // 커스텀 설정
 * const valkey = getValkeyClient({ overrides: { connectTimeout: 10000 } });
 */
export function getValkeyClient(options = {}) {
  const { type = 'default', preset = 'default', overrides = {} } = options;

  const config = CACHE_CONFIGS[type] || CACHE_CONFIGS.default;
  const host = config.getHost();

  if (!host) {
    console.warn(`[valkeyClient] Warning: No host configured for type '${type}'`);
  }

  const cacheKey = `${type}-${host}-${preset}`;

  if (instances.has(cacheKey)) {
    return instances.get(cacheKey);
  }

  const presetOptions = CONNECTION_PRESETS[preset] || CONNECTION_PRESETS.default;
  const tls = process.env.VALKEY_TLS === 'true' ? {} : undefined;

  // 캐시 타입별 포트 매핑 (EC2 4-Cache 아키텍처)
  const CACHE_PORTS = {
    depth: parseInt(process.env.DEPTH_CACHE_PORT || '6379', 10),
    backup: parseInt(process.env.BACKUP_CACHE_PORT || '6381', 10),
    operating: parseInt(process.env.OPERATING_CACHE_PORT || '6382', 10),
    candle: parseInt(process.env.CANDLE_CACHE_PORT || '6380', 10),
  };

  const client = new Redis({
    host,
    port: CACHE_PORTS[type] || parseInt(process.env.VALKEY_PORT || '6379', 10),
    tls,
    ...presetOptions,
    ...overrides,
  });

  // 에러 핸들링 (무시하지만 로깅)
  client.on('error', (err) => {
    console.error(`[valkeyClient] ${config.name} error:`, err.message);
  });

  instances.set(cacheKey, client);
  return client;
}

/**
 * 모든 클라이언트 연결 종료
 */
export async function closeAllValkeyClients() {
  const closePromises = [];
  for (const [key, client] of instances) {
    closePromises.push(
      client.quit().catch(() => {}).then(() => instances.delete(key))
    );
  }
  await Promise.all(closePromises);
}

/**
 * 레거시 호환용: 기존 Lambda 코드와 동일한 방식으로 클라이언트 생성
 *
 * @param {Object} legacyOptions - 기존 Redis 옵션
 * @returns {Redis} Redis 클라이언트
 *
 * @example
 * // 기존 코드
 * const valkey = new Redis({ host: VALKEY_HOST, port: 6379, tls: {}, ... });
 *
 * // 마이그레이션 후
 * const valkey = createLegacyClient({ host: VALKEY_HOST, port: 6379, tls: {}, ... });
 */
export function createLegacyClient(legacyOptions) {
  const client = new Redis(legacyOptions);
  client.on('error', () => {});
  return client;
}

// 기본 export
export default { getValkeyClient, closeAllValkeyClients, createLegacyClient };
