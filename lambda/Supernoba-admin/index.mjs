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
import { ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Common Layer - Valkey, CORS
import { getValkeyClient, CORS, response } from '/opt/nodejs/index.mjs';

// Auth Layer - Cognito JWT 검증
import { verifyAdmin, verifyAuth, authErrorResponse } from '/opt/nodejs/verifyAuth.mjs';

// 환경변수
const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';
const SETTINGS_TABLE = process.env.SETTINGS_TABLE || 'supernoba-settings';
const USERS_TABLE = process.env.USERS_TABLE || 'supernoba-users';
const ANNOUNCEMENTS_TABLE = process.env.ANNOUNCEMENTS_TABLE || 'supernoba-announcements';
const NOTIFICATIONS_TABLE = process.env.NOTIFICATIONS_TABLE || 'supernoba-notifications';
const WALLETS_TABLE = process.env.WALLETS_TABLE || 'supernoba-wallets';
const MEDIA_BUCKET = process.env.MEDIA_BUCKET || 'supernoba-announcements-media';
const s3 = new S3Client({ region: 'ap-northeast-2' });

// Layer를 통한 클라이언트 초기화
const operatingCache = getValkeyClient({ type: 'operating', preset: 'admin' });
const depthCache = getValkeyClient({ type: 'depth', preset: 'admin' });
const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: 'ap-northeast-2' }),
  { marshallOptions: { removeUndefinedValues: true } }
);

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

        // DynamoDB supernoba-users에서 is_admin 확인 (SSoT)
        if (userId) {
          try {
            const { Item } = await dynamodb.send(new GetCommand({ TableName: USERS_TABLE, Key: { user_id: userId } }));
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
    // betaMode - 베타 모드 ON/OFF (관리자 전용)
    // ON: 테스터만 거래 가능, OFF: 전체 유저 거래 가능
    // ==========================================
    if (q.type === 'betaMode') {
      if (m === 'GET') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        // Valkey 먼저 → 없으면 DynamoDB fallback → 없으면 false(OFF)
        let betaMode;
        try {
          betaMode = await operatingCache.get('platform:beta_mode');
        } catch (e) {
          console.error('[betaMode GET] Valkey error:', e.message);
        }

        if (betaMode === null || betaMode === undefined) {
          // DynamoDB fallback — Valkey 키 소실 대응
          try {
            const { Item } = await dynamodb.send(new GetCommand({
              TableName: SETTINGS_TABLE,
              Key: { setting_id: 'SYSTEM_SETTINGS' },
              ProjectionExpression: 'settings.platform',
            }));
            const dbValue = Item?.settings?.platform?.beta_mode;
            betaMode = dbValue === true ? 'true' : 'false';
            // Valkey에 워밍업 캐시
            await operatingCache.set('platform:beta_mode', betaMode).catch(() => {});
            console.log(`[betaMode GET] DynamoDB fallback: ${betaMode}`);
          } catch (dbErr) {
            console.error('[betaMode GET] DynamoDB fallback error:', dbErr.message);
            // 양쪽 다 실패 → 안전한 기본값: false (전체 개방)
          }
        }

        return ok({ betaMode: betaMode === 'true' });
      }

      if (m === 'PUT') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        const { enabled } = JSON.parse(event.body || '{}');
        if (typeof enabled !== 'boolean') {
          return err(400, 'enabled (boolean) required');
        }

        try {
          // Valkey + DynamoDB 이중 쓰기
          // 중첩 맵(settings.platform)이 없을 수 있으므로 if_not_exists로 초기화
          await Promise.all([
            operatingCache.set('platform:beta_mode', enabled ? 'true' : 'false'),
            dynamodb.send(new UpdateCommand({
              TableName: SETTINGS_TABLE,
              Key: { setting_id: 'SYSTEM_SETTINGS' },
              UpdateExpression: 'SET settings.platform = if_not_exists(settings.platform, :empty_map), updated_at = :now',
              ExpressionAttributeValues: {
                ':empty_map': {},
                ':now': new Date().toISOString(),
              },
            })).then(() => dynamodb.send(new UpdateCommand({
              TableName: SETTINGS_TABLE,
              Key: { setting_id: 'SYSTEM_SETTINGS' },
              UpdateExpression: 'SET settings.platform.beta_mode = :v',
              ExpressionAttributeValues: { ':v': enabled },
            }))),
          ]);
          console.log(`[betaMode] Beta mode set to: ${enabled} by admin ${adminCheck.userId}`);
          return ok({ success: true, betaMode: enabled });
        } catch (e) {
          console.error('[betaMode PUT] Error:', e.message);
          return err(500, 'Failed to set beta mode: ' + e.message);
        }
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
      const engineErrors = await operatingCache.lrange('engine:errors', 0, 99);
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
        const redisListingPrice = await operatingCache.get(`symbol:${item.symbol}:listingPrice`);

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
      const runningSymbols = await operatingCache.smembers('mm:running:symbols');
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

        // 'RANDOM'은 특수값 — 종목 검증 스킵
        if (defaultSymbol === 'RANDOM') {
          await dynamodb.send(new PutCommand({
            TableName: SETTINGS_TABLE,
            Item: {
              setting_id: 'SITE_CONFIG',
              defaultSymbol: 'RANDOM',
              updated_at: new Date().toISOString()
            }
          }));
          console.log('[siteConfig] Default symbol set to: RANDOM');
          return ok({ success: true, defaultSymbol: 'RANDOM' });
        }

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
          const cached = await operatingCache.get(TICKER_CACHE_KEY);
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
            (allSymbols || []).filter(s => s.status === 'ACTIVE' && s.is_test !== true).forEach(s => {
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

            await operatingCache.setex(TICKER_CACHE_KEY, TICKER_CACHE_TTL, JSON.stringify(activeSymbols));
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

        // Valkey ticker:* + prev:* 에서 가격 + prevClose 읽기
        let initialPrices = [];
        if (displaySymbols.length > 0) {
          try {
            const tickerKeys = displaySymbols.map(sym => `ticker:${sym}`);
            const prevKeys = displaySymbols.map(sym => `prev:${sym}`);
            const [tickerDataRaw, prevDataRaw] = await Promise.all([
              depthCache.mget(...tickerKeys),
              depthCache.mget(...prevKeys)
            ]);

            initialPrices = displaySymbols.map((sym, idx) => {
              let price = 0, prevClose = 0, change = 0, changePct = 0;
              try {
                if (tickerDataRaw[idx]) {
                  const td = JSON.parse(tickerDataRaw[idx]);
                  price = td.p || 0;
                }
                if (prevDataRaw[idx]) {
                  prevClose = JSON.parse(prevDataRaw[idx]).close || 0;
                }
                if (prevClose > 0 && price > 0) {
                  change = price - prevClose;
                  changePct = (change / prevClose) * 100;
                }
              } catch (e) {}
              return { symbol: sym, price, prevClose, change, changePct };
            });
          } catch (e) {
            console.error(`[${settingsKey} GET] Ticker price read error:`, e.message);
          }
        }

        return ok({
          settings: tickerTapeSettings,
          displaySymbols,
          initialPrices,
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
            rankingMode: rankingMode !== undefined
              ? { ...currentTickerTape.rankingMode, ...rankingMode }
              : (currentTickerTape.rankingMode || undefined),
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

          await operatingCache.del(TICKER_CACHE_KEY);

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
    // notifications - 유저 알림 조회 (인증 필수)
    // ==========================================
    if (q.type === 'notifications') {
      if (m === 'GET') {
        const authResult = await verifyAuth(event);
        if (!authResult.success) return authErrorResponse(authResult, H);
        const userId = authResult.userId;
        if (!userId) return err(401, 'Authentication required');

        // X 로그인 사용자 ID 변환
        let resolvedUserId = userId;
        const xUserId = authResult.payload?.['custom:x_user_id'];
        if (xUserId) resolvedUserId = `x_${xUserId}`;
        else if (authResult.email?.includes('@x.supernoba.com')) {
          resolvedUserId = `x_${authResult.email.split('@')[0]}`;
        }
        // Google/Apple 사용자 ID 변환
        try {
          const identities = typeof authResult.payload?.identities === 'string'
            ? JSON.parse(authResult.payload.identities) : authResult.payload?.identities;
          if (Array.isArray(identities)) {
            const googleId = identities.find(id => id.providerName === 'Google');
            if (googleId) resolvedUserId = `google_${googleId.userId}`;
            const appleId = identities.find(id => id.providerName === 'SignInWithApple');
            if (appleId) resolvedUserId = `apple_${appleId.userId}`;
          }
        } catch { /* ignore */ }

        try {
          const result = await dynamodb.send(new QueryCommand({
            TableName: NOTIFICATIONS_TABLE,
            KeyConditionExpression: 'user_id = :uid',
            ExpressionAttributeValues: { ':uid': resolvedUserId },
            ScanIndexForward: false, // 최신순
            Limit: 50
          }));
          return ok({ notifications: result.Items || [] });
        } catch (e) {
          console.error('[notifications GET] Error:', e.message);
          return ok({ notifications: [] });
        }
      }
    }

    // ==========================================
    // claimReward - IPO 보상 수령 (인증 필수)
    // ==========================================
    if (q.type === 'claimReward') {
      if (m === 'POST') {
        const authResult = await verifyAuth(event);
        if (!authResult.success) return authErrorResponse(authResult, H);
        const userId = authResult.userId;
        if (!userId) return err(401, 'Authentication required');

        // 사용자 ID 변환 (verifySelf 패턴 재사용)
        let resolvedUserId = userId;
        const xUserId = authResult.payload?.['custom:x_user_id'];
        if (xUserId) resolvedUserId = `x_${xUserId}`;
        else if (authResult.email?.includes('@x.supernoba.com')) {
          resolvedUserId = `x_${authResult.email.split('@')[0]}`;
        }
        try {
          const identities = typeof authResult.payload?.identities === 'string'
            ? JSON.parse(authResult.payload.identities) : authResult.payload?.identities;
          if (Array.isArray(identities)) {
            const googleId = identities.find(id => id.providerName === 'Google');
            if (googleId) resolvedUserId = `google_${googleId.userId}`;
            const appleId = identities.find(id => id.providerName === 'SignInWithApple');
            if (appleId) resolvedUserId = `apple_${appleId.userId}`;
          }
        } catch { /* ignore */ }

        const body = JSON.parse(event.body || '{}');
        const { notificationId } = body;
        if (!notificationId) return err(400, 'notificationId is required');

        try {
          // 1. 알림 조회 + 수령 여부 확인 (원자적 업데이트)
          const updateResult = await dynamodb.send(new UpdateCommand({
            TableName: NOTIFICATIONS_TABLE,
            Key: { user_id: resolvedUserId, notification_id: notificationId },
            UpdateExpression: 'SET reward_claimed = :true, #read = :true, claimed_at = :now',
            ConditionExpression: 'attribute_exists(user_id) AND reward_claimed = :false',
            ExpressionAttributeNames: { '#read': 'read' },
            ExpressionAttributeValues: {
              ':true': true,
              ':false': false,
              ':now': new Date().toISOString()
            },
            ReturnValues: 'ALL_NEW'
          }));

          const notification = updateResult.Attributes;
          const rewardAmount = notification.reward_amount || 0;

          if (rewardAmount > 0) {
            // 2. 잔고에 포인트 추가 (ADD 연산 — 원자적)
            await dynamodb.send(new UpdateCommand({
              TableName: WALLETS_TABLE,
              Key: { user_id: resolvedUserId },
              UpdateExpression: 'ADD #avail :amount',
              ExpressionAttributeNames: { '#avail': 'available' },
              ExpressionAttributeValues: { ':amount': rewardAmount }
            }));
            console.log(`[claimReward] ${resolvedUserId} claimed ${rewardAmount} BOLT from ${notificationId}`);
          }

          return ok({ claimed: true, amount: rewardAmount, symbol: notification.symbol });
        } catch (e) {
          if (e.name === 'ConditionalCheckFailedException') {
            return err(400, 'Reward already claimed or notification not found');
          }
          console.error('[claimReward] Error:', e.message);
          return err(500, 'Failed to claim reward: ' + e.message);
        }
      }
    }

    // ==========================================
    // ipoSettings - IPO 보상 설정 (관리자 전용)
    // ==========================================
    if (q.type === 'ipoSettings') {
      if (m === 'GET') {
        try {
          const { Item } = await dynamodb.send(new GetCommand({
            TableName: SETTINGS_TABLE,
            Key: { setting_id: 'SYSTEM_SETTINGS' }
          }));
          return ok({
            ipo: Item?.settings?.ipo || {
              requester_reward_enabled: true,
              requester_reward_amount: 10000
            }
          });
        } catch (e) {
          console.error('[ipoSettings GET] Error:', e.message);
          return ok({ ipo: { requester_reward_enabled: true, requester_reward_amount: 10000 } });
        }
      }

      if (m === 'PUT') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        const body = JSON.parse(event.body || '{}');
        const { requester_reward_enabled, requester_reward_amount } = body;

        try {
          // 기존 SYSTEM_SETTINGS 가져와서 ipo 섹션만 병합
          const { Item: current } = await dynamodb.send(new GetCommand({
            TableName: SETTINGS_TABLE,
            Key: { setting_id: 'SYSTEM_SETTINGS' }
          }));
          const currentSettings = current?.settings || {};

          const newIpoSettings = {
            requester_reward_enabled: requester_reward_enabled !== undefined
              ? requester_reward_enabled
              : (currentSettings.ipo?.requester_reward_enabled ?? true),
            requester_reward_amount: requester_reward_amount !== undefined
              ? requester_reward_amount
              : (currentSettings.ipo?.requester_reward_amount ?? 10000),
          };

          await dynamodb.send(new PutCommand({
            TableName: SETTINGS_TABLE,
            Item: {
              setting_id: 'SYSTEM_SETTINGS',
              settings: { ...currentSettings, ipo: newIpoSettings },
              updated_at: new Date().toISOString()
            }
          }));

          console.log(`[ipoSettings] Updated by admin: ${JSON.stringify(newIpoSettings)}`);
          return ok({ success: true, ipo: newIpoSettings });
        } catch (e) {
          console.error('[ipoSettings PUT] Error:', e.message);
          return err(500, 'Failed to save IPO settings: ' + e.message);
        }
      }
    }

    // ==========================================
    // announcements - 공지사항 CRUD
    // ==========================================
    if (q.type === 'announcements') {
      // POST with action=upload-url → S3 presigned PUT URL (admin only)
      if (m === 'POST' && q.action === 'upload-url') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        const { filename, contentType, announcementId } = JSON.parse(event.body || '{}');
        if (!filename || !contentType) return err(400, 'filename and contentType required');

        const key = `announcements/${announcementId || 'temp'}/${Date.now()}_${filename}`;
        const command = new PutObjectCommand({
          Bucket: MEDIA_BUCKET,
          Key: key,
          ContentType: contentType,
        });
        const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
        const mediaUrl = `s3://${MEDIA_BUCKET}/${key}`;

        return ok({ uploadUrl, mediaUrl, key });
      }

      // GET → list announcements (admin sees all statuses)
      if (m === 'GET') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        let items;
        if (q.category) {
          // Use GSI to filter by category
          const result = await dynamodb.send(new QueryCommand({
            TableName: ANNOUNCEMENTS_TABLE,
            IndexName: 'category-status-index',
            KeyConditionExpression: 'category = :cat',
            ExpressionAttributeValues: { ':cat': q.category },
          }));
          items = result.Items || [];
        } else {
          const result = await dynamodb.send(new ScanCommand({ TableName: ANNOUNCEMENTS_TABLE }));
          items = result.Items || [];
        }

        // Sort by priority (ascending), then by created_at (descending)
        items.sort((a, b) => (a.priority || 999) - (b.priority || 999) || (b.created_at || '').localeCompare(a.created_at || ''));

        return ok({ announcements: items });
      }

      // POST → create announcement
      if (m === 'POST') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        const body = JSON.parse(event.body || '{}');
        const { category, title, content, display_mode, media_url, media_type, status, priority } = body;

        if (!category || !title) return err(400, 'category and title required');
        if (!['greeting', 'detail'].includes(category)) return err(400, 'category must be greeting or detail');
        if (category === 'detail' && display_mode === 'content') return err(400, 'detail category only supports board mode');

        const now = new Date().toISOString();
        const announcement_id = `ann_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

        const item = {
          announcement_id,
          category,
          title,
          content: content || '',
          display_mode: display_mode || 'board',
          media_url: media_url || '',
          media_type: media_type || '',
          status: status || 'DRAFT',
          priority: priority !== undefined ? priority : 100,
          created_by: adminCheck.userId || 'admin',
          created_at: now,
          updated_at: now,
        };

        await dynamodb.send(new PutCommand({ TableName: ANNOUNCEMENTS_TABLE, Item: item }));
        console.log(`[announcements] Created: ${announcement_id} (${category}/${title})`);

        return ok({ success: true, announcement: item });
      }

      // PUT → update announcement
      if (m === 'PUT') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        const id = q.id;
        if (!id) return err(400, 'id query parameter required');

        const { Item: existing } = await dynamodb.send(new GetCommand({
          TableName: ANNOUNCEMENTS_TABLE,
          Key: { announcement_id: id },
        }));
        if (!existing) return err(404, 'Announcement not found');

        const body = JSON.parse(event.body || '{}');
        const updatedItem = {
          ...existing,
          ...body,
          announcement_id: id, // prevent overwrite
          updated_at: new Date().toISOString(),
        };

        await dynamodb.send(new PutCommand({ TableName: ANNOUNCEMENTS_TABLE, Item: updatedItem }));
        console.log(`[announcements] Updated: ${id}`);

        return ok({ success: true, announcement: updatedItem });
      }

      // DELETE → delete announcement
      if (m === 'DELETE') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        const id = q.id;
        if (!id) return err(400, 'id query parameter required');

        await dynamodb.send(new DeleteCommand({
          TableName: ANNOUNCEMENTS_TABLE,
          Key: { announcement_id: id },
        }));
        console.log(`[announcements] Deleted: ${id}`);

        return ok({ success: true, deleted: id });
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

    return err(404, 'Not found. Available endpoints: ?type=auth, ?type=alerts, ?type=siteConfig, ?type=tickerTape, ?type=tickerTape_pc, ?type=tickerTape_mobile, ?type=gameSettings, ?type=notifications, ?type=claimReward, ?type=ipoSettings');
  } catch (e) {
    console.error('Error:', e);
    return err(500, e.message);
  }
};
