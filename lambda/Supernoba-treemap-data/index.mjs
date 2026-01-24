/**
 * Supernoba-treemap-data Lambda
 * Treemap 시각화를 위한 시장 데이터 집계 API
 *
 * 엔드포인트:
 * - GET /treemap - 섹터별 종목 데이터 (시가총액, 변동률, 거래량)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ScanCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Redis from 'ioredis';

// 환경변수
const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';
const DEPTH_CACHE_HOST = process.env.DEPTH_CACHE_HOST || 'master.supernoba-depth-cache.5vrxzz.apn2.cache.amazonaws.com';
const BACKUP_CACHE_HOST = process.env.BACKUP_CACHE_HOST || 'master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com';
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT || '6379');

// Redis 클라이언트 (Lambda 컨테이너 재사용)
let depthClient = null;
let backupClient = null;

function getDepthClient() {
  if (!depthClient) {
    depthClient = new Redis({
      host: DEPTH_CACHE_HOST,
      port: VALKEY_PORT,
      tls: {},
      connectTimeout: 5000,
      maxRetriesPerRequest: 1
    });
    depthClient.on('error', () => {}); // 에러 무시
  }
  return depthClient;
}

function getBackupClient() {
  if (!backupClient) {
    backupClient = new Redis({
      host: BACKUP_CACHE_HOST,
      port: VALKEY_PORT,
      tls: {},
      connectTimeout: 5000,
      maxRetriesPerRequest: 1
    });
    backupClient.on('error', () => {}); // 에러 무시
  }
  return backupClient;
}

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));

// Rankings snapshot 캐시 키
const RANKINGS_SNAPSHOT_KEY = 'rankings:snapshot';

// CORS 헤더
const H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'DELETE, GET, OPTIONS, POST, PUT',
  'Content-Type': 'application/json'
};

const ok = (d) => ({ statusCode: 200, headers: H, body: JSON.stringify(d) });
const err = (c, m) => ({ statusCode: c, headers: H, body: JSON.stringify({ error: m }) });

/**
 * 섹터 이름 정규화 (플랫폼 → 표시명)
 */
const SECTOR_DISPLAY_NAMES = {
  'YouTube': 'YouTube',
  'Twitch': 'Twitch',
  'TikTok': 'TikTok',
  'Instagram': 'Instagram',
  'Twitter': 'Twitter',
  'X': 'X',
  'ETC': 'Others',
  'Other': 'Others',
  'UNKNOWN': 'Others'
};

const normalizeSector = (platform) => {
  if (!platform) return 'Others';
  return SECTOR_DISPLAY_NAMES[platform] || platform;
};

/**
 * 숫자 포맷팅 (시가총액 등)
 */
const formatMarketCap = (value) => {
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toString();
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: H, body: '' };
  }

  try {
    const m = event.httpMethod;
    const q = event.queryStringParameters || {};

    // ==========================================
    // GET: Treemap 데이터 조회
    // ==========================================
    if (m === 'GET') {
      const startTime = Date.now();
      const valkey = getDepthClient();
      const backupValkey = getBackupClient();

      // 1. DynamoDB에서 ACTIVE 종목 목록 조회
      const { Items: symbols } = await dynamodb.send(
        new ScanCommand({
          TableName: SYMBOLS_TABLE,
          FilterExpression: '#status = :active',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':active': 'ACTIVE' }
        })
      );

      if (!symbols || symbols.length === 0) {
        return ok({
          timestamp: new Date().toISOString(),
          totalMarketCap: 0,
          totalVolume: 0,
          symbolCount: 0,
          sectors: [],
          processingTime: Date.now() - startTime
        });
      }

      // 2. Rankings snapshot 캐시 조회 (우선)
      let rankingsCache = null;
      let rankingsBySymbol = new Map();

      try {
        const snapshotJson = await backupValkey.get(RANKINGS_SNAPSHOT_KEY);
        if (snapshotJson) {
          rankingsCache = JSON.parse(snapshotJson);
          console.log('[treemap] Rankings cache hit, timestamp:', rankingsCache.timestamp);

          // Symbol로 빠른 조회를 위한 맵 생성
          for (const r of (rankingsCache.marketcap || [])) {
            rankingsBySymbol.set(r.symbol, { marketCap: r.marketCap, rank: r.rank });
          }
          for (const r of (rankingsCache.volume || [])) {
            const existing = rankingsBySymbol.get(r.symbol) || {};
            rankingsBySymbol.set(r.symbol, { ...existing, volume: r.volume });
          }
          for (const r of (rankingsCache.gainers || [])) {
            const existing = rankingsBySymbol.get(r.symbol) || {};
            rankingsBySymbol.set(r.symbol, { ...existing, change: r.change });
          }
          for (const r of (rankingsCache.losers || [])) {
            const existing = rankingsBySymbol.get(r.symbol) || {};
            rankingsBySymbol.set(r.symbol, { ...existing, change: r.change });
          }
        }
      } catch (cacheErr) {
        console.warn('[treemap] Rankings cache miss or parse error:', cacheErr.message);
      }

      // 3. Valkey에서 ticker 및 prevClose 데이터 일괄 조회
      const tickerKeys = symbols.map(s => `ticker:${s.symbol}`);
      const prevCloseKeys = symbols.map(s => `prev:${s.symbol}`);
      let tickerDataRaw = [];
      let prevCloseDataRaw = [];

      try {
        // 병렬로 ticker와 prevClose 조회
        [tickerDataRaw, prevCloseDataRaw] = await Promise.all([
          valkey.mget(...tickerKeys),
          valkey.mget(...prevCloseKeys)
        ]);
        console.log('[treemap] Valkey MGET success, tickers:', tickerDataRaw.filter(Boolean).length, 'prevClose:', prevCloseDataRaw.filter(Boolean).length);
      } catch (redisErr) {
        console.warn('[treemap] Valkey MGET failed:', redisErr.message);
        tickerDataRaw = new Array(symbols.length).fill(null);
        prevCloseDataRaw = new Array(symbols.length).fill(null);
      }

      // 4. 데이터 병합 - Rankings 캐시 우선, ticker fallback, prevClose 직접 계산
      const enrichedSymbols = symbols.map((sym, idx) => {
        // Ticker 데이터 파싱
        let ticker = {};
        try {
          if (tickerDataRaw[idx]) {
            ticker = JSON.parse(tickerDataRaw[idx]);
          }
        } catch (parseErr) {
          console.warn(`[treemap] Ticker parse error for ${sym.symbol}:`, parseErr.message);
        }

        // prevClose 데이터 파싱
        let prevClose = 0;
        try {
          if (prevCloseDataRaw[idx]) {
            const prevData = JSON.parse(prevCloseDataRaw[idx]);
            prevClose = prevData.close || 0;
          }
        } catch (parseErr) {
          console.warn(`[treemap] PrevClose parse error for ${sym.symbol}:`, parseErr.message);
        }

        // Rankings 캐시에서 데이터 가져오기
        const rankingData = rankingsBySymbol.get(sym.symbol) || {};

        // 가격: ticker 우선 (실시간)
        const price = ticker.p || ticker.price || ticker.c || sym.listingPrice || 0;
        const totalShares = sym.totalShares || 0;

        // MarketCap: 캐시 우선, 계산 fallback
        const marketCap = rankingData.marketCap || (price * totalShares);

        // Change: prevClose 기반 실시간 계산 우선, 캐시 fallback
        let change = 0;
        if (prevClose > 0 && price > 0) {
          // 실시간 변동률 계산: (현재가 - 전일종가) / 전일종가 * 100
          change = ((price - prevClose) / prevClose) * 100;
        } else if (rankingData.change !== undefined && rankingData.change !== 0) {
          // Rankings 캐시의 값 사용 (0이 아닌 경우만)
          change = rankingData.change;
        } else {
          // ticker의 changePercent 사용
          change = ticker.changePercent || ticker.yc || 0;
        }

        // Volume: 캐시 우선, ticker fallback
        const volume = rankingData.volume !== undefined
          ? rankingData.volume
          : (ticker.volume || ticker.v || 0);

        return {
          symbol: sym.symbol,
          name: sym.name || sym.symbol,
          sector: normalizeSector(sym.platform),
          logoUrl: sym.logoUrl || null,
          totalShares,
          price,
          change,
          volume,
          marketCap,
          marketCapFormatted: formatMarketCap(marketCap),
          // 추가 메타데이터
          categories: sym.categories || [],
          verified: sym.verified || false
        };
      });

      // 5. 섹터별 집계
      const sectorMap = new Map();

      for (const sym of enrichedSymbols) {
        if (!sectorMap.has(sym.sector)) {
          sectorMap.set(sym.sector, {
            sector: sym.sector,
            symbols: [],
            marketCap: 0,
            volume: 0,
            changeWeightedSum: 0,  // 가중평균 계산용
            symbolCount: 0
          });
        }

        const sector = sectorMap.get(sym.sector);
        sector.symbols.push(sym);
        sector.marketCap += sym.marketCap;
        sector.volume += sym.volume;
        sector.changeWeightedSum += sym.change * sym.marketCap;  // 시총 가중
        sector.symbolCount += 1;
      }

      // 6. 섹터별 가중평균 변동률 계산 및 정렬
      const sectors = Array.from(sectorMap.values()).map(s => ({
        sector: s.sector,
        marketCap: s.marketCap,
        marketCapFormatted: formatMarketCap(s.marketCap),
        volume: s.volume,
        // 시가총액 가중평균 변동률
        change: s.marketCap > 0 ? (s.changeWeightedSum / s.marketCap) : 0,
        symbolCount: s.symbolCount,
        // 시가총액 기준 내림차순 정렬
        symbols: s.symbols.sort((a, b) => b.marketCap - a.marketCap)
      }));

      // 7. 섹터도 시가총액 기준 정렬
      sectors.sort((a, b) => b.marketCap - a.marketCap);

      // 8. 전체 통계 계산
      const totalMarketCap = sectors.reduce((sum, s) => sum + s.marketCap, 0);
      const totalVolume = sectors.reduce((sum, s) => sum + s.volume, 0);
      const symbolCount = enrichedSymbols.length;

      // 9. 응답 구성
      const viewMode = q.view || 'marketCap';  // marketCap | volume | change

      return ok({
        timestamp: new Date().toISOString(),
        totalMarketCap,
        totalMarketCapFormatted: formatMarketCap(totalMarketCap),
        totalVolume,
        symbolCount,
        sectorCount: sectors.length,
        viewMode,
        sectors,
        processingTime: Date.now() - startTime
      });
    }

    return err(405, 'Method not allowed. Use GET.');
  } catch (e) {
    console.error('[treemap] Error:', e);
    return err(500, e.message);
  }
};
