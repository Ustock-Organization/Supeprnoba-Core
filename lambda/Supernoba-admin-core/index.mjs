/**
 * Supernoba-admin-core Lambda
 * 사용자 관리 + 시스템 설정 통합 Lambda
 *
 * 엔드포인트:
 * - GET /users - 사용자 목록
 * - GET /users/{userId} - 사용자 상세
 * - POST /users (action=suspend/unsuspend/setBalance/setHolding/getAllHoldings) - 사용자 액션
 * - GET /settings/site - 사이트 설정
 * - PUT /settings/site - 사이트 설정 변경
 * - GET /settings/tickerTape - 티커테이프 설정
 * - PUT /settings/tickerTape - 티커테이프 설정 변경
 * - GET /settings - 전체 시스템 설정
 * - PUT /settings - 전체 시스템 설정 변경
 * - GET /alerts - 관리자 알림
 * - GET /auth - 관리자 권한 확인 (공개)
 */

import { getValkeyClient } from '/opt/nodejs/index.mjs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ScanCommand, QueryCommand, PutCommand, DeleteCommand, GetCommand, UpdateCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Auth Layer
const loadAuth = async () => {
  try {
    return await import('/opt/nodejs/verifyAuth.mjs');
  } catch (err) {
    console.error('[admin-core] Failed to load auth layer:', err.message);
    // 프로덕션에서는 auth layer 로드 실패 시 요청 거부
    return {
      verifyAdmin: async () => {
        console.error('[admin-core] Auth layer not available - rejecting request');
        return { success: false, error: 'AUTH_LAYER_UNAVAILABLE' };
      },
      authErrorResponse: (r) => ({
        statusCode: 503,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: r.error || 'Service temporarily unavailable' })
      })
    };
  }
};
const { verifyAdmin, authErrorResponse } = await loadAuth();

// 환경변수
const USER_CACHE_TABLE = process.env.USER_CACHE_TABLE || 'supernoba-users';
// WALLETS_TABLE 제거됨 — supernoba-users.balances.BOLT로 통합
const AUDIT_LOGS_TABLE = process.env.AUDIT_LOGS_TABLE || 'supernoba-audit-logs';
const SETTINGS_TABLE = process.env.SETTINGS_TABLE || 'supernoba-settings';
const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';
const SETTINGS_KEY = 'SYSTEM_SETTINGS';

// 기본 설정값
const DEFAULT_SETTINGS = {
  user: { welcomeBonus: 0 },
  system: {
    maintenanceMode: false,
    tradingEnabled: true,
    newRegistrationEnabled: true,
  }
};

// 기본 티커테이프 설정
const DEFAULT_TICKER_TAPE = {
  mode: 'auto',
  manualSymbols: [],
  autoCount: 10,
  scrollSpeed: 40
};

// 클라이언트 (Common Layer 4-Cache)
const operatingCache = getValkeyClient({ type: 'operating', preset: 'admin' });
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));

// 공통 헤더
const H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Content-Type': 'application/json'
};

// 관리자 인증 체크
const checkAdmin = async (event) => {
  const result = await verifyAdmin(event);
  if (!result.success) {
    return { authorized: false, response: authErrorResponse(result, H) };
  }
  return { authorized: true, userId: result.userId, method: result.method };
};

const ok = (d) => ({ statusCode: 200, headers: H, body: JSON.stringify(d) });
const err = (c, m) => ({ statusCode: c, headers: H, body: JSON.stringify({ error: m }) });

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  try {
    const m = event.httpMethod;
    const q = event.queryStringParameters || {};
    const path = event.path || '';

    // ==========================================
    // GET /auth - 관리자 권한 확인 (공개)
    // 경로: /auth?userId=xxx 또는 쿼리: ?type=auth&userId=xxx
    // ==========================================
    if ((path.includes('/auth') || q.type === 'auth') && m === 'GET') {
      const { userId, twitterUsername, googleEmail } = q;
      let admin = false;

      if (twitterUsername) {
        admin = twitterUsername.replace('@', '').toLowerCase() === 'tchinnom';
      }
      if (googleEmail && !admin) {
        admin = ['tchinnom@gmail.com', 'admin@supernoba.com'].includes(googleEmail.toLowerCase());
      }
      if (userId && !admin) {
        try {
          const { Item } = await dynamodb.send(new GetCommand({ TableName: USER_CACHE_TABLE, Key: { user_id: userId } }));
          if (Item) admin = Item.is_admin === true;
        } catch (e) {
          console.error('[auth] User cache lookup error:', e.message);
        }
      }
      return ok({ isAdmin: admin });
    }

    // ==========================================
    // GET /alerts - 관리자 알림 (관리자 전용)
    // ==========================================
    if (path.includes('/alerts') && m === 'GET') {
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
    // Settings 엔드포인트
    // ==========================================

    // GET /settings/site - 사이트 설정 (공개)
    if ((path.includes('/settings/site') || q.type === 'siteConfig') && m === 'GET') {
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

    // PUT /settings/site - 사이트 설정 변경 (관리자)
    if ((path.includes('/settings/site') || q.type === 'siteConfig') && m === 'PUT') {
      const adminCheck = await checkAdmin(event);
      if (!adminCheck.authorized) return adminCheck.response;

      const { defaultSymbol } = JSON.parse(event.body || '{}');
      if (!defaultSymbol) return err(400, 'defaultSymbol required');

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

    // GET /settings/tickerTape - 티커테이프 설정 (공개)
    if ((path.includes('/settings/tickerTape') || q.type === 'tickerTape') && m === 'GET') {
      const TICKER_CACHE_KEY = 'tickerTape:activeSymbols';
      const TICKER_CACHE_TTL = 300;

      let tickerTapeSettings = DEFAULT_TICKER_TAPE;
      try {
        const { Item: settingsItem } = await dynamodb.send(new GetCommand({
          TableName: SETTINGS_TABLE,
          Key: { setting_id: SETTINGS_KEY }
        }));
        tickerTapeSettings = settingsItem?.settings?.tickerTape || DEFAULT_TICKER_TAPE;
      } catch (dbErr) {
        console.error('[tickerTape GET] Settings fetch error:', dbErr.message);
      }

      let activeSymbols = [];
      try {
        const cached = await operatingCache.get(TICKER_CACHE_KEY);
        if (cached) {
          activeSymbols = JSON.parse(cached);
        } else {
          const { Items: allSymbols } = await dynamodb.send(new ScanCommand({ TableName: SYMBOLS_TABLE }));
          activeSymbols = (allSymbols || [])
            .filter(s => s.status === 'ACTIVE')
            .sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0))
            .map(s => ({ symbol: s.symbol, name: s.name, volume24h: s.volume24h || 0, logoUrl: s.logoUrl }));
          await operatingCache.setex(TICKER_CACHE_KEY, TICKER_CACHE_TTL, JSON.stringify(activeSymbols));
        }
      } catch (cacheErr) {
        console.error('[tickerTape GET] Cache/DB error:', cacheErr.message);
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

    // PUT /settings/tickerTape - 티커테이프 설정 변경 (관리자)
    if ((path.includes('/settings/tickerTape') || q.type === 'tickerTape') && m === 'PUT') {
      const adminCheck = await checkAdmin(event);
      if (!adminCheck.authorized) return adminCheck.response;

      const b = JSON.parse(event.body || '{}');
      const { mode, manualSymbols, autoCount, scrollSpeed } = b;
      const TICKER_CACHE_KEY = 'tickerTape:activeSymbols';

      // 유효성 검사
      if (mode !== undefined && !['auto', 'manual'].includes(mode)) {
        return err(400, 'mode must be "auto" or "manual"');
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
            const symbolSet = new Set((existingSymbols || []).map(s => s.symbol.toUpperCase()));
            const invalidSymbols = manualSymbols.filter(s => !symbolSet.has(s.toUpperCase()));
            if (invalidSymbols.length > 0) {
              return err(400, `Invalid symbols: ${invalidSymbols.join(', ')}`);
            }
          } catch (dbErr) {
            console.error('[tickerTape PUT] Symbol validation error:', dbErr.message);
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
          Key: { setting_id: SETTINGS_KEY }
        }));

        const currentTickerTape = currentSettings?.settings?.tickerTape || DEFAULT_TICKER_TAPE;

        const newTickerTape = {
          mode: mode !== undefined ? mode : currentTickerTape.mode,
          manualSymbols: manualSymbols !== undefined ? manualSymbols : currentTickerTape.manualSymbols,
          autoCount: autoCount !== undefined ? autoCount : currentTickerTape.autoCount,
          scrollSpeed: scrollSpeed !== undefined ? scrollSpeed : currentTickerTape.scrollSpeed,
          updatedAt: Date.now()
        };

        const newSettings = {
          ...currentSettings?.settings,
          tickerTape: newTickerTape
        };

        await dynamodb.send(new UpdateCommand({
          TableName: SETTINGS_TABLE,
          Key: { setting_id: SETTINGS_KEY },
          UpdateExpression: 'SET settings = :settings, updated_at = :updatedAt',
          ExpressionAttributeValues: {
            ':settings': newSettings,
            ':updatedAt': new Date().toISOString()
          }
        }));

        await operatingCache.del(TICKER_CACHE_KEY);

        return ok({ success: true, tickerTape: newTickerTape });
      } catch (dbErr) {
        console.error('[tickerTape PUT] Update error:', dbErr.message);
        return err(500, 'Failed to save settings: ' + dbErr.message);
      }
    }

    // GET /settings - 전체 시스템 설정 (관리자)
    if (path.includes('/settings') && m === 'GET' && !path.includes('/site') && !path.includes('/tickerTape')) {
      const adminCheck = await checkAdmin(event);
      if (!adminCheck.authorized) return adminCheck.response;

      try {
        const result = await dynamodb.send(new GetCommand({
          TableName: SETTINGS_TABLE,
          Key: { setting_id: SETTINGS_KEY }
        }));
        return ok({ settings: result.Item?.settings || DEFAULT_SETTINGS });
      } catch (e) {
        console.error('getSettings error:', e);
        return ok({ settings: DEFAULT_SETTINGS });
      }
    }

    // PUT /settings - 전체 시스템 설정 변경 (관리자)
    if (path.includes('/settings') && m === 'PUT' && !path.includes('/site') && !path.includes('/tickerTape')) {
      const adminCheck = await checkAdmin(event);
      if (!adminCheck.authorized) return adminCheck.response;

      const { settings } = JSON.parse(event.body || '{}');
      if (!settings) return err(400, 'settings is required');

      try {
        await dynamodb.send(new PutCommand({
          TableName: SETTINGS_TABLE,
          Item: {
            setting_id: SETTINGS_KEY,
            settings: settings,
            updated_at: new Date().toISOString()
          }
        }));

        try {
          await operatingCache.set('system:settings', JSON.stringify(settings));
        } catch (e) {
          console.log('Valkey save error (ignored):', e.message);
        }

        // 감사 로그
        try {
          await dynamodb.send(new PutCommand({
            TableName: AUDIT_LOGS_TABLE,
            Item: {
              log_id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              action: 'update_settings',
              details: { settings },
              created_at: new Date().toISOString()
            }
          }));
        } catch (e) {
          console.log('Audit log error (ignored):', e.message);
        }

        return ok({ success: true, message: 'Settings saved' });
      } catch (e) {
        console.error('saveSettings error:', e);
        return err(500, 'Failed to save settings: ' + e.message);
      }
    }

    // ==========================================
    // Users 엔드포인트 (관리자 전용)
    // ==========================================
    const usersAdminCheck = await checkAdmin(event);
    if (!usersAdminCheck.authorized) return usersAdminCheck.response;

    // GET /users/{userId} - 개별 사용자 상세
    if (m === 'GET') {
      const { userId, page = 1, limit = 50, search, status: userStatus } = q;

      if (userId) {
        // 사용자 프로필
        let profile = null;
        try {
          const { Item } = await dynamodb.send(new GetCommand({
            TableName: USER_CACHE_TABLE,
            Key: { user_id: userId }
          }));
          profile = Item || null;
        } catch (profileErr) {
          console.error('[GET USER] Profile fetch error:', profileErr.message);
        }

        // balances.BOLT에서 직접 읽기 (통합)
        const boltBalance = profile?.balances?.BOLT || { available: 0, locked: 0 };
        const effectiveWallets = [{
          user_id: userId,
          currency: 'BOLT',
          available: boltBalance.available,
          locked: boltBalance.locked
        }];

        // 주문 이력
        const ordersResult = await dynamodb.send(new QueryCommand({
          TableName: 'supernoba-orders',
          KeyConditionExpression: 'user_id = :uid',
          ExpressionAttributeValues: { ':uid': userId },
          Limit: 100,
          ScanIndexForward: false
        }));

        // 보유 자산
        const holdingsResult = await dynamodb.send(new QueryCommand({
          TableName: 'supernoba-holdings',
          KeyConditionExpression: 'user_id = :uid',
          ExpressionAttributeValues: { ':uid': userId }
        }));

        // 주문 상태별 집계
        const orderStats = { PENDING: 0, ACCEPTED: 0, PARTIALLY_FILLED: 0, FILLED: 0, CANCELLED: 0, REJECTED: 0 };
        (ordersResult.Items || []).forEach(item => {
          const status = item.status || 'PENDING';
          orderStats[status] = (orderStats[status] || 0) + 1;
        });

        const totalTradeVolume = (ordersResult.Items || [])
          .filter(o => o.status === 'FILLED')
          .reduce((sum, o) => sum + ((o.filled_qty || o.quantity || 0) * (o.price || 0)), 0);

        const normalizedHoldings = (holdingsResult.Items || []).map(h => ({
          ...h,
          avg_price: h.avg_price ?? h.avgPrice ?? 0
        }));

        return ok({
          user: {
            id: userId,
            ...profile,
            wallets: effectiveWallets,
            orders: ordersResult.Items || [],
            holdings: normalizedHoldings,
            stats: {
              orderCount: ordersResult.Items?.length || 0,
              holdingsCount: normalizedHoldings.length,
              ordersByStatus: orderStats,
              totalTradeVolume
            }
          }
        });
      }

      // 사용자 목록
      try {
        const { Items: allUsers } = await dynamodb.send(new ScanCommand({
          TableName: USER_CACHE_TABLE
        }));

        let users = allUsers || [];

        if (search) {
          const searchLower = search.toLowerCase();
          users = users.filter(u =>
            (u.email && u.email.toLowerCase().includes(searchLower)) ||
            (u.display_name && u.display_name.toLowerCase().includes(searchLower))
          );
        }

        if (userStatus === 'suspended') {
          users = users.filter(u => u.is_suspended === true);
        } else if (userStatus === 'active') {
          users = users.filter(u => !u.is_suspended);
        }

        users.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

        const total = users.length;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        const paginatedUsers = users.slice(offset, offset + parseInt(limit));

        const enrichedUsers = paginatedUsers.map((user) => {
          const boltWallet = user.balances?.BOLT;
          return {
            ...user,
            id: user.user_id,
            bolt_balance: boltWallet?.available ?? 0,
            bolt_locked: boltWallet?.locked ?? 0,
            wallet_exists: !!boltWallet
          };
        });

        return ok({
          users: enrichedUsers,
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(total / parseInt(limit))
        });
      } catch (e) {
        console.error('[GET USERS] Error:', e.message);
        return err(500, 'Failed to fetch users: ' + e.message);
      }
    }

    // POST /users - 사용자 액션
    if (m === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const { action, userId, reason } = b;

      // getSettings
      if (action === 'getSettings') {
        try {
          const result = await dynamodb.send(new GetCommand({
            TableName: SETTINGS_TABLE,
            Key: { setting_id: SETTINGS_KEY }
          }));
          return ok({ settings: result.Item?.settings || DEFAULT_SETTINGS });
        } catch (e) {
          console.error('getSettings error:', e);
          return ok({ settings: DEFAULT_SETTINGS });
        }
      }

      // saveSettings
      if (action === 'saveSettings') {
        const { settings } = b;
        if (!settings) return err(400, 'settings is required');

        try {
          await dynamodb.send(new PutCommand({
            TableName: SETTINGS_TABLE,
            Item: {
              setting_id: SETTINGS_KEY,
              settings: settings,
              updated_at: new Date().toISOString()
            }
          }));

          try {
            await operatingCache.set('system:settings', JSON.stringify(settings));
          } catch (e) {
            console.log('Valkey save error (ignored):', e.message);
          }

          return ok({ success: true, message: 'Settings saved' });
        } catch (e) {
          console.error('saveSettings error:', e);
          return err(500, 'Failed to save settings: ' + e.message);
        }
      }

      // getAllHoldings
      if (action === 'getAllHoldings') {
        const { symbol, page = 1, limit = 50 } = b;

        let scanParams = {
          TableName: 'supernoba-holdings',
          Limit: 1000
        };

        if (symbol) {
          scanParams.FilterExpression = 'symbol = :sym';
          scanParams.ExpressionAttributeValues = { ':sym': symbol };
        }

        const result = await dynamodb.send(new ScanCommand(scanParams));
        const holdings = result.Items || [];

        const userIds = [...new Set(holdings.map(h => h.user_id))];
        const userMap = {};

        const userPromises = userIds.slice(0, 100).map(async (uid) => {
          try {
            const { Item } = await dynamodb.send(new GetCommand({
              TableName: USER_CACHE_TABLE,
              Key: { user_id: uid }
            }));
            if (Item) {
              userMap[uid] = { email: Item.email, display_name: Item.display_name };
            }
          } catch (e) { }
        });
        await Promise.all(userPromises);

        const enrichedHoldings = holdings.map(h => ({
          ...h,
          user_email: userMap[h.user_id]?.email || 'Unknown',
          user_name: userMap[h.user_id]?.display_name || ''
        }));

        const startIdx = (parseInt(page) - 1) * parseInt(limit);
        const paginatedHoldings = enrichedHoldings.slice(startIdx, startIdx + parseInt(limit));

        return ok({
          holdings: paginatedHoldings,
          total: enrichedHoldings.length,
          page: parseInt(page),
          limit: parseInt(limit)
        });
      }

      // userId가 필요한 액션들
      if (!userId) return err(400, 'userId is required');

      // suspend
      if (action === 'suspend') {
        try {
          await dynamodb.send(new UpdateCommand({
            TableName: USER_CACHE_TABLE,
            Key: { user_id: userId },
            UpdateExpression: 'SET is_suspended = :suspended, suspended_at = :suspended_at, suspended_reason = :reason',
            ExpressionAttributeValues: {
              ':suspended': true,
              ':suspended_at': new Date().toISOString(),
              ':reason': reason || 'Suspended by admin'
            }
          }));
        } catch (e) {
          return err(500, 'Failed to suspend user: ' + e.message);
        }

        try {
          await operatingCache.set(`user:${userId}:suspended`, 'true');
        } catch (e) {
          console.log('Valkey error (ignored):', e.message);
        }

        try {
          await dynamodb.send(new PutCommand({
            TableName: AUDIT_LOGS_TABLE,
            Item: {
              log_id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              action: 'suspend_user',
              target_user_id: userId,
              details: { reason },
              created_at: new Date().toISOString()
            }
          }));
        } catch (e) {
          console.log('Audit log error (ignored):', e.message);
        }

        return ok({ success: true, message: `User ${userId} suspended` });
      }

      // unsuspend
      if (action === 'unsuspend') {
        try {
          await dynamodb.send(new UpdateCommand({
            TableName: USER_CACHE_TABLE,
            Key: { user_id: userId },
            UpdateExpression: 'SET is_suspended = :suspended REMOVE suspended_at, suspended_reason',
            ExpressionAttributeValues: {
              ':suspended': false
            }
          }));
        } catch (e) {
          return err(500, 'Failed to unsuspend user: ' + e.message);
        }

        try {
          await operatingCache.del(`user:${userId}:suspended`);
        } catch (e) {
          console.log('Valkey error (ignored):', e.message);
        }

        return ok({ success: true, message: `User ${userId} unsuspended` });
      }

      // setBalance
      if (action === 'setBalance') {
        const { currency = 'BOLT', newBalance, adjustReason } = b;
        if (typeof newBalance !== 'number' || newBalance < 0) return err(400, 'newBalance must be a non-negative number');

        let currentBalance = 0;
        try {
          const { Item: user } = await dynamodb.send(new GetCommand({
            TableName: USER_CACHE_TABLE,
            Key: { user_id: userId },
            ProjectionExpression: 'balances'
          }));
          currentBalance = user?.balances?.BOLT?.available || 0;
        } catch (e) {
          console.log('Balance fetch error (ignored):', e.message);
        }

        try {
          await dynamodb.send(new UpdateCommand({
            TableName: USER_CACHE_TABLE,
            Key: { user_id: userId },
            UpdateExpression: 'SET balances.BOLT.available = :bal, updated_at = :now',
            ExpressionAttributeValues: {
              ':bal': newBalance,
              ':now': new Date().toISOString()
            }
          }));
        } catch (updateErr) {
          return err(500, 'Failed to update balance: ' + updateErr.message);
        }

        try {
          await dynamodb.send(new PutCommand({
            TableName: AUDIT_LOGS_TABLE,
            Item: {
              log_id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              action: 'set_balance',
              target_user_id: userId,
              details: { currency, previousBalance: currentBalance, newBalance, reason: adjustReason },
              created_at: new Date().toISOString()
            }
          }));
        } catch (e) {
          console.log('Audit log error (ignored):', e.message);
        }

        return ok({ success: true, previousBalance: currentBalance, newBalance, currency });
      }

      // setHolding
      if (action === 'setHolding') {
        const { symbol, quantity, avg_price, adjustReason } = b;
        if (!symbol) return err(400, 'symbol is required');
        if (typeof quantity !== 'number' || quantity < 0) return err(400, 'quantity must be a non-negative number');

        const existingResult = await dynamodb.send(new QueryCommand({
          TableName: 'supernoba-holdings',
          KeyConditionExpression: 'user_id = :uid AND symbol = :sym',
          ExpressionAttributeValues: { ':uid': userId, ':sym': symbol }
        }));
        const existingHolding = existingResult.Items?.[0];

        if (quantity === 0) {
          await dynamodb.send(new DeleteCommand({
            TableName: 'supernoba-holdings',
            Key: { user_id: userId, symbol }
          }));

          try {
            await dynamodb.send(new PutCommand({
              TableName: AUDIT_LOGS_TABLE,
              Item: {
                log_id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                action: 'delete_holding',
                target_user_id: userId,
                details: { symbol, previousQuantity: existingHolding?.quantity || 0, reason: adjustReason },
                created_at: new Date().toISOString()
              }
            }));
          } catch (e) {
            console.log('Audit log error (ignored):', e.message);
          }

          return ok({ success: true, message: `Holding ${symbol} deleted`, previousQuantity: existingHolding?.quantity || 0 });
        }

        const roundedAvgPrice = Math.round((avg_price || existingHolding?.avg_price || 0) * 10) / 10;
        const holdingData = {
          user_id: userId,
          symbol,
          quantity,
          avg_price: roundedAvgPrice,
          total_cost: Math.round(quantity * roundedAvgPrice * 10) / 10,
          updated_at: new Date().toISOString()
        };

        await dynamodb.send(new PutCommand({
          TableName: 'supernoba-holdings',
          Item: holdingData
        }));

        try {
          await dynamodb.send(new PutCommand({
            TableName: AUDIT_LOGS_TABLE,
            Item: {
              log_id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              action: 'set_holding',
              target_user_id: userId,
              details: {
                symbol,
                previousQuantity: existingHolding?.quantity || 0,
                newQuantity: quantity,
                avg_price: holdingData.avg_price,
                reason: adjustReason
              },
              created_at: new Date().toISOString()
            }
          }));
        } catch (e) {
          console.log('Audit log error (ignored):', e.message);
        }

        return ok({
          success: true,
          holding: holdingData,
          previousQuantity: existingHolding?.quantity || 0
        });
      }

      return err(400, 'Invalid action. Supported: getSettings, saveSettings, suspend, unsuspend, setBalance, setHolding, getAllHoldings');
    }

    return err(404, 'Not found');
  } catch (e) {
    console.error('Error:', e);
    return err(500, e.message);
  }
};
