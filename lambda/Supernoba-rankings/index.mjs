/**
 * Supernoba-rankings Lambda
 * 시장 랭킹 데이터 API (시가총액, 거래량, 급등, 급락)
 *
 * 엔드포인트:
 * - GET /rankings?type=marketcap|volume|gainers|losers&limit=100&offset=0
 */

// Common Layer - Valkey, CORS
import { getValkeyClient, CORS, response } from '/opt/nodejs/index.mjs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ScanCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));

// Lambda 인스턴스 단위 캐시 (5분 TTL) — 화이트리스트 방식
let activeSymbolsCache = { set: new Set(), expiry: 0 };

async function getActiveSymbols() {
  if (activeSymbolsCache.expiry > Date.now()) return activeSymbolsCache.set;
  try {
    const { Items } = await dynamodb.send(new ScanCommand({
      TableName: SYMBOLS_TABLE,
      ProjectionExpression: 'symbol, is_test, #s',
      ExpressionAttributeNames: { '#s': 'status' }
    }));
    const activeSet = new Set();
    (Items || []).forEach(item => {
      if (item.status === 'ACTIVE' && item.is_test !== true) activeSet.add(item.symbol);
    });
    activeSymbolsCache = { set: activeSet, expiry: Date.now() + 300000 };
    return activeSet;
  } catch (e) {
    console.error('[rankings] Active symbols load error:', e.message);
    return activeSymbolsCache.set;
  }
}

// 환경변수
const SNAPSHOT_KEY = 'rankings:snapshot';
const SNAPSHOT_TTL = 15;  // 초

// Layer를 통한 클라이언트 초기화 (backup + depth cache)
const backupCache = getValkeyClient({ type: 'backup', preset: 'admin' });
const depthCache = getValkeyClient({ type: 'depth', preset: 'admin' });

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
    const snapshotJson = await backupCache.get(SNAPSHOT_KEY);
    if (!snapshotJson) return null;

    const snapshot = JSON.parse(snapshotJson);
    let rankings = snapshot[type] || [];
    const activeSymbols = await getActiveSymbols();

    // 활성 종목이 없으면 fallback
    if (activeSymbols.size === 0) return null;

    // 스냅샷 데이터를 score map으로 변환
    const scoreField = type === 'marketcap' ? 'marketCap' : type === 'volume' ? 'volume' : 'change';
    const scoreMap = {};
    rankings.forEach(r => { scoreMap[r.symbol] = r[scoreField] || 0; });

    // 모든 활성 종목 merge (스냅샷에 없는 종목은 score=0)
    let merged = [];
    for (const symbol of activeSymbols) {
      merged.push({ symbol, [scoreField]: scoreMap[symbol] || 0 });
    }

    // 정렬 + 순위
    merged.sort((a, b) => (b[scoreField] || 0) - (a[scoreField] || 0));
    merged = merged.map((r, i) => ({ ...r, rank: i + 1 }));

    return {
      timestamp: snapshot.timestamp,
      type,
      total: merged.length,
      rankings: merged.slice(offset, offset + limit)
    };
  } catch (e) {
    console.warn('[rankings] Snapshot cache error:', e.message);
    return null;
  }
}

/**
 * 직접 Sorted Set에서 랭킹 조회 (캐시 미스 시)
 */
async function getRankingsFromSortedSet(type, limit, offset) {
  const key = `ranking:${type}`;
  const activeSymbols = await getActiveSymbols();

  // Valkey sorted set에서 전체 스코어 맵 구축
  const scoreMap = {};
  try {
    const all = await backupCache.zrevrange(key, 0, -1, 'WITHSCORES');
    for (let i = 0; i < all.length; i += 2) {
      scoreMap[all[i]] = parseFloat(all[i + 1]);
    }
  } catch (e) {
    console.warn('[rankings] Sorted set read error:', e.message);
  }

  // 모든 활성 종목에 대해 랭킹 항목 생성 (Valkey에 없으면 score=0)
  const scoreField = type === 'marketcap' ? 'marketCap' : type === 'volume' ? 'volume' : 'change';
  let rankings = [];
  for (const symbol of activeSymbols) {
    let score = scoreMap[symbol] || 0;
    if (type === 'gainers' || type === 'losers') {
      if (type === 'losers') score = -score;
      score = score / 1000000;
    }
    rankings.push({ symbol, [scoreField]: score });
  }

  // 정렬 (내림차순)
  rankings.sort((a, b) => (b[scoreField] || 0) - (a[scoreField] || 0));
  rankings = rankings.map((r, i) => ({ ...r, rank: i + 1 }));

  return {
    timestamp: new Date().toISOString(),
    type,
    total: rankings.length,
    rankings: rankings.slice(offset, offset + limit)
  };
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

      // 3. 가격 데이터 enrichment (prev:* 키에서 prevClose 직접 계산)
      if (result.rankings && result.rankings.length > 0) {
        try {
          const tickerKeys = result.rankings.map(r => `ticker:${r.symbol}`);
          const prevKeys = result.rankings.map(r => `prev:${r.symbol}`);
          const [tickerRaw, prevRaw] = await Promise.all([
            depthCache.mget(...tickerKeys),
            depthCache.mget(...prevKeys)
          ]);
          result.rankings = result.rankings.map((r, i) => {
            let price = 0, changePct = 0;
            try {
              if (tickerRaw[i]) { price = JSON.parse(tickerRaw[i]).p || 0; }
              if (prevRaw[i] && price > 0) {
                const prevClose = JSON.parse(prevRaw[i]).close || 0;
                if (prevClose > 0) changePct = ((price - prevClose) / prevClose) * 100;
              }
            } catch (e) {}
            return { ...r, price, changePct };
          });
        } catch (e) {
          console.warn('[rankings] Price enrichment error:', e.message);
        }
      }

      // 4. 응답 구성
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
