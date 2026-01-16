/**
 * Supernoba-treemap-data Lambda
 * Treemap 시각화를 위한 시장 데이터 집계 API
 *
 * 엔드포인트:
 * - GET /treemap - 섹터별 종목 데이터 (시가총액, 변동률, 거래량)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ScanCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Common Layer - Valkey, CORS
import { getValkeyClient, CORS, response } from '/opt/nodejs/index.mjs';

// 환경변수
const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';

// Layer를 통한 클라이언트 초기화
const valkey = getValkeyClient({ preset: 'depth' });
const backupValkey = getValkeyClient({ type: 'backup' });
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));

// Rankings snapshot 캐시 키
const RANKINGS_SNAPSHOT_KEY = 'rankings:snapshot';

// Layer의 CORS.FULL 사용
const H = CORS.FULL;

const ok = (d) => response.ok(d, H);
const err = (c, m) => response.error(c, m, H);

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

      // 3. Valkey에서 ticker 데이터 일괄 조회 (캐시 보완용)
      const tickerKeys = symbols.map(s => `ticker:${s.symbol}`);
      let tickerDataRaw = [];

      try {
        tickerDataRaw = await valkey.mget(...tickerKeys);
      } catch (redisErr) {
        console.warn('[treemap] Valkey MGET failed:', redisErr.message);
        tickerDataRaw = new Array(symbols.length).fill(null);
      }

      // 4. 데이터 병합 - Rankings 캐시 우선, ticker fallback
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

        // Rankings 캐시에서 데이터 가져오기
        const rankingData = rankingsBySymbol.get(sym.symbol) || {};

        // 가격: ticker 우선 (실시간), 캐시에서 marketCap 역산 가능
        const price = ticker.price || ticker.c || sym.listingPrice || 0;
        const totalShares = sym.totalShares || 0;

        // MarketCap: 캐시 우선, 계산 fallback
        const marketCap = rankingData.marketCap || (price * totalShares);

        // Change: 캐시 우선, ticker fallback
        const change = rankingData.change !== undefined
          ? rankingData.change
          : (ticker.changePercent || ticker.yc || 0);

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
