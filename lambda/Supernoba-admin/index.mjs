/**
 * Supernoba-admin Lambda (축소 버전)
 * Settings 및 Alerts 전용 관리 API
 *
 * 엔드포인트:
 * - GET ?type=auth - 관리자 권한 확인 (공개)
 * - GET ?type=alerts - 관리자 알림
 * - GET/PUT ?type=siteConfig - 사이트 기본 설정
 * - GET/PUT ?type=tickerTape - 티커테이프 설정 (레거시, tickerTape_pc 폴백)
 * - GET/PUT ?type=tickerTape_pc - PC 티커테이프 설정
 * - GET/PUT ?type=tickerTape_mobile - 모바일 티커테이프 설정
 * - GET/PUT ?type=gameSettings - 게임 밸런스 설정
 *
 * Symbol 관련 기능은 Supernoba-symbol-admin으로 이동됨
 * User 관련 기능은 Supernoba-admin-users로 이동됨
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ScanCommand, GetCommand, PutCommand, UpdateCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Common Layer - Valkey, CORS
import { getValkeyClient, CORS, response } from '/opt/nodejs/index.mjs';

// Auth Layer - Cognito JWT 검증
import { verifyAdmin, authErrorResponse } from '/opt/nodejs/verifyAuth.mjs';

// 환경변수
const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';
const SETTINGS_TABLE = process.env.SETTINGS_TABLE || 'supernoba-settings';
const USER_CACHE_TABLE = process.env.USER_CACHE_TABLE || 'supernoba-users';

// Layer를 통한 클라이언트 초기화
const valkey = getValkeyClient({ preset: 'admin' });
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));

// Layer의 CORS.FULL 사용
const H = CORS.FULL;

// 관리자 인증 체크
const checkAdmin = async (event) => {
  const result = await verifyAdmin(event);
  if (!result.success) {
    return { authorized: false, response: authErrorResponse(result, H) };
  }
  return { authorized: true, userId: result.userId, method: result.method };
};

const ok = (d) => response.ok(d, H);
const err = (c, m) => response.error(c, m, H);

// 기본 티커테이프 설정
const DEFAULT_TICKER_TAPE = {
  mode: 'auto',
  manualSymbols: [],
  autoCount: 10,
  scrollSpeed: 40
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  try {
    const m = event.httpMethod;
    const q = event.queryStringParameters || {};

    // ==========================================
    // auth - 관리자 권한 체크 (공개 엔드포인트)
    // ==========================================
    if (q.type === 'auth') {
      if (m === 'GET') {
        const { userId } = q;
        let admin = false;

        // DynamoDB user-cache에서 is_admin 확인 (SSoT)
        if (userId) {
          try {
            const { Item } = await dynamodb.send(new GetCommand({ TableName: USER_CACHE_TABLE, Key: { user_id: userId } }));
            if (Item?.is_admin === true) {
              admin = true;
              console.log(`[auth] Admin confirmed: ${userId}`);
            }
          } catch (e) {
            console.error('[auth] User cache lookup error:', e.message);
          }
        }
        return ok({ isAdmin: admin });
      }
      if (m === 'POST') {
        return err(410, 'Authentication moved to Cognito. Use /auth/login endpoint instead.');
      }
    }

    // ==========================================
    // alerts - 관리자 알림 (관리자 전용)
    // ==========================================
    if (q.type === 'alerts' && m === 'GET') {
      const adminCheck = await checkAdmin(event);
      if (!adminCheck.authorized) return adminCheck.response;

      const alerts = [];

      // 엔진 오류
      const engineErrors = await valkey.lrange('engine:errors', 0, 99);
      if (engineErrors.length > 0) {
        alerts.push({
          type: 'ENGINE_ERRORS',
          severity: 'high',
          count: engineErrors.length,
          items: engineErrors.map(e => {
            try { return JSON.parse(e); } catch { return { message: e }; }
          })
        });
      }

      // 가격 데이터 누락 심볼
      const { Items } = await dynamodb.send(new ScanCommand({ TableName: SYMBOLS_TABLE }));
      const missingPriceSymbols = [];

      for (const item of (Items || [])) {
        const hasPrevClose = item.prevClose !== null && item.prevClose !== undefined && item.prevClose > 0;
        const hasListingPrice = item.listingPrice !== null && item.listingPrice !== undefined && item.listingPrice > 0;
        const redisListingPrice = await valkey.get(`symbol:${item.symbol}:listingPrice`);

        if (!hasPrevClose && !hasListingPrice && !redisListingPrice) {
          missingPriceSymbols.push({
            symbol: item.symbol,
            name: item.name,
            status: item.status,
            hasPrevClose,
            hasListingPrice,
            hasRedisListingPrice: !!redisListingPrice
          });
        }
      }

      if (missingPriceSymbols.length > 0) {
        alerts.push({
          type: 'MISSING_PRICE_DATA',
          severity: 'medium',
          count: missingPriceSymbols.length,
          description: 'Symbols without prevClose or listingPrice - engine may not work correctly',
          items: missingPriceSymbols
        });
      }

      // 마켓메이커 상태
      const runningSymbols = await valkey.smembers('mm:running:symbols');
      if (runningSymbols.length > 0) {
        alerts.push({
          type: 'MARKET_MAKER_RUNNING',
          severity: 'info',
          count: runningSymbols.length,
          items: runningSymbols
        });
      }

      return ok({
        timestamp: new Date().toISOString(),
        totalAlerts: alerts.length,
        alerts
      });
    }

    // ==========================================
    // siteConfig - 사이트 기본 설정
    // ==========================================
    if (q.type === 'siteConfig') {
      // GET: 공개
      if (m === 'GET') {
        try {
          const { Item } = await dynamodb.send(new GetCommand({
            TableName: SETTINGS_TABLE,
            Key: { setting_id: 'SITE_CONFIG' }
          }));
          return ok({ defaultSymbol: Item?.defaultSymbol || null });
        } catch (e) {
          console.error('[siteConfig GET] Error:', e.message);
          return ok({ defaultSymbol: null });
        }
      }

      // PUT: 관리자 전용
      if (m === 'PUT') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        const { defaultSymbol } = JSON.parse(event.body || '{}');
        if (!defaultSymbol) return err(400, 'defaultSymbol required');

        // 종목 존재 및 ACTIVE 상태 검증
        const { Item: symbolItem } = await dynamodb.send(new GetCommand({
          TableName: SYMBOLS_TABLE,
          Key: { symbol: defaultSymbol.toUpperCase() }
        }));
        if (!symbolItem) return err(400, `${defaultSymbol} does not exist`);
        if (symbolItem.status !== 'ACTIVE') return err(400, `${defaultSymbol} is not active (status: ${symbolItem.status})`);

        await dynamodb.send(new PutCommand({
          TableName: SETTINGS_TABLE,
          Item: {
            setting_id: 'SITE_CONFIG',
            defaultSymbol,
            updated_at: new Date().toISOString()
          }
        }));

        console.log(`[siteConfig] Default symbol set to: ${defaultSymbol}`);
        return ok({ success: true, defaultSymbol });
      }
    }

    // ==========================================
    // tickerTape - 티커테이프 설정 (PC/모바일 분리)
    // ==========================================
    const TICKER_TYPES = ['tickerTape', 'tickerTape_pc', 'tickerTape_mobile'];
    if (TICKER_TYPES.includes(q.type)) {
      // tickerTape (레거시) → tickerTape_pc 폴백
      const settingsKey = q.type === 'tickerTape' ? 'tickerTape_pc' : q.type;
      const TICKER_CACHE_KEY = `${settingsKey}:activeSymbols`;
      const TICKER_CACHE_TTL = 300;

      // GET: 공개
      if (m === 'GET') {
        let tickerTapeSettings = DEFAULT_TICKER_TAPE;
        try {
          const { Item: settingsItem } = await dynamodb.send(new GetCommand({
            TableName: SETTINGS_TABLE,
            Key: { setting_id: 'SYSTEM_SETTINGS' }
          }));

          const allSettings = settingsItem?.settings || {};

          // 마이그레이션: tickerTape_pc가 없으면 기존 tickerTape에서 복사
          if (!allSettings[settingsKey] && allSettings.tickerTape && settingsKey === 'tickerTape_pc') {
            tickerTapeSettings = allSettings.tickerTape;
            // 자동 마이그레이션 저장
            try {
              const newSettings = { ...allSettings, tickerTape_pc: allSettings.tickerTape };
              if (!allSettings.tickerTape_mobile) {
                newSettings.tickerTape_mobile = { ...DEFAULT_TICKER_TAPE };
              }
              await dynamodb.send(new UpdateCommand({
                TableName: SETTINGS_TABLE,
                Key: { setting_id: 'SYSTEM_SETTINGS' },
                UpdateExpression: 'SET settings = :settings',
                ExpressionAttributeValues: { ':settings': newSettings }
              }));
              console.log('[tickerTape] Auto-migrated tickerTape → tickerTape_pc + tickerTape_mobile');
            } catch (migErr) {
              console.error('[tickerTape] Migration error:', migErr.message);
            }
          } else {
            tickerTapeSettings = allSettings[settingsKey] || DEFAULT_TICKER_TAPE;
          }
        } catch (dbErr) {
          console.error(`[${settingsKey} GET] Settings fetch error:`, dbErr.message);
        }

        let activeSymbols = [];
        try {
          const cached = await valkey.get(TICKER_CACHE_KEY);
          if (cached) {
            activeSymbols = JSON.parse(cached);
          } else {
            // Rankings API에서 volume 기준 정렬된 목록 가져오기
            const rankApiUrl = process.env.RANKINGS_API_URL || 'https://4xs6g4w8l6.execute-api.ap-northeast-2.amazonaws.com/restV2/rankings';
            let rankedSymbols = [];
            try {
              const rankRes = await fetch(`${rankApiUrl}?type=volume&limit=100`);
              if (rankRes.ok) {
                const rankData = await rankRes.json();
                rankedSymbols = (rankData.rankings || []).map(r => r.symbol);
              }
            } catch (rankErr) {
              console.error(`[${settingsKey} GET] Rankings API error:`, rankErr.message);
            }

            // DynamoDB에서 종목 메타데이터(이름, 로고) 가져오기
            const { Items: allSymbols } = await dynamodb.send(new ScanCommand({ TableName: SYMBOLS_TABLE }));
            const symbolMap = {};
            (allSymbols || []).filter(s => s.status === 'ACTIVE').forEach(s => {
              symbolMap[s.symbol] = { symbol: s.symbol, name: s.name, logoUrl: s.logoUrl };
            });

            // Rankings 순서대로 메타데이터 합치기
            activeSymbols = rankedSymbols
              .filter(sym => symbolMap[sym])
              .map(sym => symbolMap[sym]);

            // Rankings에 없는 ACTIVE 종목도 뒤에 붙이기
            const rankedSet = new Set(rankedSymbols);
            Object.values(symbolMap).forEach(s => {
              if (!rankedSet.has(s.symbol)) activeSymbols.push(s);
            });

            await valkey.setex(TICKER_CACHE_KEY, TICKER_CACHE_TTL, JSON.stringify(activeSymbols));
          }
        } catch (cacheErr) {
          console.error(`[${settingsKey} GET] Cache/DB error:`, cacheErr.message);
        }

        let displaySymbols;
        if (tickerTapeSettings.mode === 'manual' && tickerTapeSettings.manualSymbols?.length > 0) {
          displaySymbols = tickerTapeSettings.manualSymbols;
        } else {
          displaySymbols = activeSymbols.slice(0, tickerTapeSettings.autoCount || 10).map(s => s.symbol);
        }

        return ok({
          settings: tickerTapeSettings,
          displaySymbols,
          allActiveSymbols: activeSymbols
        });
      }

      // PUT: 관리자 전용
      if (m === 'PUT') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        const b = JSON.parse(event.body || '{}');
        const { mode, manualSymbols, autoCount, scrollSpeed, rankingMode } = b;

        // 유효성 검사 (기존과 동일)
        if (mode !== undefined && !['auto', 'manual', 'ranking'].includes(mode)) {
          return err(400, 'mode must be "auto", "manual", or "ranking"');
        }
        if (mode === 'ranking' || rankingMode !== undefined) {
          if (rankingMode) {
            if (rankingMode.criteria !== undefined && !['marketcap', 'volume', 'gainers', 'losers'].includes(rankingMode.criteria)) {
              return err(400, 'rankingMode.criteria must be "marketcap", "volume", "gainers", or "losers"');
            }
            if (rankingMode.count !== undefined && (typeof rankingMode.count !== 'number' || rankingMode.count < 5 || rankingMode.count > 50)) {
              return err(400, 'rankingMode.count must be a number between 5 and 50');
            }
            if (rankingMode.realtime !== undefined && typeof rankingMode.realtime !== 'boolean') {
              return err(400, 'rankingMode.realtime must be a boolean');
            }
          }
        }
        if (manualSymbols !== undefined) {
          if (!Array.isArray(manualSymbols)) return err(400, 'manualSymbols must be an array');
          if (manualSymbols.length > 50) return err(400, 'manualSymbols cannot exceed 50 items');
          if (!manualSymbols.every(s => typeof s === 'string' && s.length > 0 && s.length <= 20)) {
            return err(400, 'manualSymbols must contain valid symbol strings (1-20 chars)');
          }
          if (manualSymbols.length > 0) {
            try {
              const { Items: existingSymbols } = await dynamodb.send(new ScanCommand({ TableName: SYMBOLS_TABLE }));
              const activeSymbolSet = new Set(
                (existingSymbols || [])
                  .filter(s => s.status === 'ACTIVE')
                  .map(s => s.symbol.toUpperCase())
              );
              const invalidSymbols = manualSymbols.filter(s => !activeSymbolSet.has(s.toUpperCase()));
              if (invalidSymbols.length > 0) {
                return err(400, `Invalid or inactive symbols: ${invalidSymbols.join(', ')}. Only ACTIVE symbols are allowed.`);
              }
            } catch (dbErr) {
              console.error(`[${settingsKey} PUT] Symbol validation error:`, dbErr.message);
            }
          }
        }
        if (autoCount !== undefined && (typeof autoCount !== 'number' || autoCount < 1 || autoCount > 20)) {
          return err(400, 'autoCount must be a number between 1 and 20');
        }
        if (scrollSpeed !== undefined && (typeof scrollSpeed !== 'number' || scrollSpeed < 10 || scrollSpeed > 200)) {
          return err(400, 'scrollSpeed must be a number between 10 and 200');
        }

        try {
          const { Item: currentSettings } = await dynamodb.send(new GetCommand({
            TableName: SETTINGS_TABLE,
            Key: { setting_id: 'SYSTEM_SETTINGS' }
          }));

          const currentTickerTape = currentSettings?.settings?.[settingsKey] || DEFAULT_TICKER_TAPE;

          const newTickerTape = {
            mode: mode !== undefined ? mode : currentTickerTape.mode,
            manualSymbols: manualSymbols !== undefined ? manualSymbols : currentTickerTape.manualSymbols,
            autoCount: autoCount !== undefined ? autoCount : currentTickerTape.autoCount,
            scrollSpeed: scrollSpeed !== undefined ? scrollSpeed : currentTickerTape.scrollSpeed,
            rankingMode: rankingMode !== undefined ? { ...currentTickerTape.rankingMode, ...rankingMode } : currentTickerTape.rankingMode,
            updatedAt: Date.now()
          };

          const newSettings = {
            ...currentSettings?.settings,
            [settingsKey]: newTickerTape
          };

          await dynamodb.send(new UpdateCommand({
            TableName: SETTINGS_TABLE,
            Key: { setting_id: 'SYSTEM_SETTINGS' },
            UpdateExpression: 'SET settings = :settings, updated_at = :updatedAt',
            ExpressionAttributeValues: {
              ':settings': newSettings,
              ':updatedAt': new Date().toISOString()
            }
          }));

          await valkey.del(TICKER_CACHE_KEY);

          return ok({ success: true, [settingsKey]: newTickerTape });
        } catch (dbErr) {
          console.error(`[${settingsKey} PUT] Update error:`, dbErr.message);
          return err(500, 'Failed to save settings: ' + dbErr.message);
        }
      }
    }

    // ==========================================
    // gameSettings - 게임 밸런스 설정
    // ==========================================
    if (q.type === 'gameSettings') {
      // GET: 공개 (게임 클라이언트도 읽어야 함)
      if (m === 'GET') {
        try {
          const { Item } = await dynamodb.send(new GetCommand({
            TableName: SETTINGS_TABLE,
            Key: { setting_id: 'GAME_SETTINGS' }
          }));
          return ok({ settings: Item?.settings || null });
        } catch (e) {
          console.error('[gameSettings GET] Error:', e.message);
          return ok({ settings: null });
        }
      }

      // PUT: 관리자 전용
      if (m === 'PUT') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        const body = JSON.parse(event.body || '{}');
        const { weapons, combatAllocation, respawn, scoring, system } = body;

        if (!weapons && !combatAllocation && !respawn && !scoring && !system) {
          return err(400, 'At least one settings section required (weapons, combatAllocation, respawn, scoring, system)');
        }

        try {
          // 기존 설정 가져와서 병합
          const { Item: current } = await dynamodb.send(new GetCommand({
            TableName: SETTINGS_TABLE,
            Key: { setting_id: 'GAME_SETTINGS' }
          }));
          const currentSettings = current?.settings || {};

          const newSettings = {
            weapons: weapons ? { ...currentSettings.weapons, ...weapons } : currentSettings.weapons,
            combatAllocation: combatAllocation ? { ...currentSettings.combatAllocation, ...combatAllocation } : currentSettings.combatAllocation,
            respawn: respawn ? { ...currentSettings.respawn, ...respawn } : currentSettings.respawn,
            scoring: scoring ? { ...currentSettings.scoring, ...scoring } : currentSettings.scoring,
            system: system ? { ...currentSettings.system, ...system } : currentSettings.system,
          };

          await dynamodb.send(new PutCommand({
            TableName: SETTINGS_TABLE,
            Item: {
              setting_id: 'GAME_SETTINGS',
              settings: newSettings,
              updated_at: new Date().toISOString()
            }
          }));

          console.log('[gameSettings] Updated by admin');
          return ok({ success: true, settings: newSettings });
        } catch (e) {
          console.error('[gameSettings PUT] Error:', e.message);
          return err(500, 'Failed to save game settings: ' + e.message);
        }
      }
    }

    // ==========================================
    // 기존 엔드포인트 안내 (마이그레이션 가이드)
    // ==========================================

    // symbols 관련 요청은 symbol-admin으로 안내
    if (q.type === 'symbols' || event.path?.includes('/symbols')) {
      return err(410, 'Symbol operations moved to /Supernoba-symbol-admin endpoint');
    }

    // users 관련 요청은 admin-users로 안내
    if (q.type === 'users' || event.path?.includes('/users')) {
      return err(410, 'User operations moved to /Supernoba-admin-users endpoint');
    }

    // requests는 creator-requests로 안내
    if (q.type === 'requests') {
      return err(410, 'Moved to /creator-requests endpoint in Main API');
    }

    // sync, cleanChart는 symbol-admin으로 안내
    if (event.path?.includes('sync') || q.type === 'cleanChart') {
      return err(410, 'Moved to /Supernoba-symbol-admin endpoint');
    }

    // approve, reject 액션은 symbol-admin으로 안내
    if (q.action === 'approve' || q.action === 'reject' || q.action === 'listing' || q.action === 'activate' || q.action === 'restore') {
      return err(410, 'Symbol actions moved to /Supernoba-symbol-admin endpoint');
    }

    // DELETE 메서드는 symbol-admin으로 안내
    if (event.httpMethod === 'DELETE') {
      return err(410, 'Symbol DELETE moved to /Supernoba-symbol-admin endpoint');
    }

    return err(404, 'Not found. Available endpoints: ?type=auth, ?type=alerts, ?type=siteConfig, ?type=tickerTape, ?type=tickerTape_pc, ?type=tickerTape_mobile, ?type=gameSettings');
  } catch (e) {
    console.error('Error:', e);
    return err(500, e.message);
  }
};
