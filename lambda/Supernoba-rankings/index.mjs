/**
 * Supernoba-rankings Lambda
 * 시장 랭킹 데이터 API (시가총액, 거래량, 급등, 급락)
 *
 * 엔드포인트:
 * - GET /rankings?type=marketcap|volume|gainers|losers&limit=100&offset=0
 */

// Common Layer - Valkey, CORS
import { getValkeyClient, CORS, response } from '/opt/nodejs/index.mjs';

// 환경변수
const SNAPSHOT_KEY = 'rankings:snapshot';
const SNAPSHOT_TTL = 15;  // 초

// Layer를 통한 클라이언트 초기화 (backup cache)
const valkey = getValkeyClient({ type: 'backup' });

// Layer의 CORS.FULL 사용
const H = CORS.FULL;

const ok = (d) => response.ok(d, H);
const err = (c, m) => response.error(c, m, H);

/**
 * 랭킹 타입 검증
 */
const VALID_TYPES = ['marketcap', 'volume', 'gainers', 'losers'];

const isValidType = (type) => VALID_TYPES.includes(type);

/**
 * 스냅샷 캐시에서 랭킹 조회
 */
async function getRankingsFromSnapshot(type, limit, offset) {
  try {
    const snapshotJson = await valkey.get(SNAPSHOT_KEY);

    if (snapshotJson) {
      const snapshot = JSON.parse(snapshotJson);
      const rankings = snapshot[type] || [];

      return {
        timestamp: snapshot.timestamp,
        type,
        total: rankings.length,
        rankings: rankings.slice(offset, offset + limit)
      };
    }
  } catch (e) {
    console.warn('[rankings] Snapshot cache miss or parse error:', e.message);
  }

  return null;
}

/**
 * 직접 Sorted Set에서 랭킹 조회 (캐시 미스 시)
 */
async function getRankingsFromSortedSet(type, limit, offset) {
  const key = `ranking:${type}`;

  try {
    let results;

    if (type === 'losers') {
      // losers는 음수 점수로 저장되어 있으므로 zrange 사용
      results = await valkey.zrange(key, offset, offset + limit - 1, 'WITHSCORES');
    } else {
      // 나머지는 내림차순 (zrevrange)
      results = await valkey.zrevrange(key, offset, offset + limit - 1, 'WITHSCORES');
    }

    // WITHSCORES 결과: [member1, score1, member2, score2, ...]
    const rankings = [];
    for (let i = 0; i < results.length; i += 2) {
      const symbol = results[i];
      let score = parseFloat(results[i + 1]);

      // 등락률 복원 (gainers, losers는 1e6 스케일)
      if (type === 'gainers' || type === 'losers') {
        if (type === 'losers') score = -score;  // 음수 복원
        score = score / 1000000;
      }

      rankings.push({
        rank: offset + (i / 2) + 1,
        symbol,
        [type === 'marketcap' ? 'marketCap' : type === 'volume' ? 'volume' : 'change']: score
      });
    }

    return {
      timestamp: new Date().toISOString(),
      type,
      total: rankings.length,
      rankings
    };
  } catch (e) {
    console.error('[rankings] Sorted set query error:', e.message);
    throw e;
  }
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: H, body: '' };
  }

  try {
    const m = event.httpMethod;
    const q = event.queryStringParameters || {};

    // ==========================================
    // GET: 랭킹 데이터 조회
    // ==========================================
    if (m === 'GET') {
      const startTime = Date.now();

      // 파라미터 파싱
      const type = (q.type || 'marketcap').toLowerCase();
      const limit = Math.min(parseInt(q.limit) || 100, 500);  // 최대 500
      const offset = parseInt(q.offset) || 0;

      // 타입 검증
      if (!isValidType(type)) {
        return err(400, `Invalid type. Use one of: ${VALID_TYPES.join(', ')}`);
      }

      // 1. 스냅샷 캐시 조회 (우선)
      let result = await getRankingsFromSnapshot(type, limit, offset);

      // 2. 캐시 미스: 직접 조회
      if (!result) {
        console.log('[rankings] Cache miss, querying sorted set directly');
        result = await getRankingsFromSortedSet(type, limit, offset);
      }

      // 3. 응답 구성
      return ok({
        ...result,
        processingTime: Date.now() - startTime
      });
    }

    return err(405, 'Method not allowed. Use GET.');
  } catch (e) {
    console.error('[rankings] Error:', e);
    return err(500, e.message);
  }
};
