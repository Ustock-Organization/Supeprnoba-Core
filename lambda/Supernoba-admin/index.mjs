// Supernoba-admin: 통합 관리자 Lambda with Authentication
import Redis from 'ioredis';
import { createClient } from '@supabase/supabase-js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import pg from 'pg';

// === Auth Layer Import (Simplified) ===
let auth;
try {
  auth = await import('/opt/nodejs/verifyAuth.mjs');
} catch {
  const { createFallbackAuth } = await import('/opt/nodejs/verifyAuth.mjs').catch(() => ({}));
  auth = createFallbackAuth?.('admin') || {
    verifyAdmin: async (e) => {
      const key = process.env.ADMIN_API_KEY, h = e.headers?.Authorization || e.headers?.authorization;
      return key && h === key ? { success: true, userId: 'admin', method: 'api_key' } : { success: false, error: 'UNAUTHORIZED' };
    },
    authErrorResponse: (r) => ({ statusCode: 401, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(r) })
  };
}
const { verifyAdmin, authErrorResponse } = auth;

const { Client: PgClient } = pg;
const VALKEY_HOST = process.env.VALKEY_HOST;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';
const RDS_HOST = process.env.RDS_ENDPOINT || 'supernoba-rdb1.cluster-cyxfcbnpfoci.ap-northeast-2.rds.amazonaws.com';
const DB_SECRET_ARN = process.env.DB_SECRET_ARN || '';

const valkey = new Redis({ host: VALKEY_HOST, port: 6379, tls: {}, connectTimeout: 5000, maxRetriesPerRequest: 3 });
valkey.on('error', (e) => console.error('Redis:', e.message));
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));
const secrets = new SecretsManagerClient({ region: 'ap-northeast-2' });
let dbCreds = null, pgClient = null;

const H = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Content-Type': 'application/json' };

// 관리자 인증 체크 (JWT + API Key 병행)
const checkAdmin = async (event) => {
  const result = await verifyAdmin(event);
  if (!result.success) {
    return { authorized: false, response: authErrorResponse(result, H) };
  }
  return { authorized: true, userId: result.userId, method: result.method };
};

// 플랫폼 패턴 테이블 (확장 용이)
const PLATFORM_PATTERNS = {
  YOUTUBE: ['youtube.com', 'youtu.be'],
  X: ['twitter.com', 'x.com'],
  INSTAGRAM: ['instagram.com'],
  TIKTOK: ['tiktok.com'],
  CHZZK: ['chzzk'],
  AFREECATV: ['afreecatv']
};

const detectPlatform = (url) => {
  if (!url) return 'ETC';
  const lower = url.toLowerCase();
  return Object.entries(PLATFORM_PATTERNS).find(([, p]) => p.some(s => lower.includes(s)))?.[0] || 'ETC';
};
const ok = (d) => ({ statusCode: 200, headers: H, body: JSON.stringify(d) });
const err = (c, m) => ({ statusCode: c, headers: H, body: JSON.stringify({ error: m }) });

async function getPg() {
  if (pgClient) return pgClient;
  if (!dbCreds) {
    if (process.env.DB_USERNAME && process.env.DB_PASSWORD) dbCreds = { username: process.env.DB_USERNAME, password: process.env.DB_PASSWORD };
    else if (DB_SECRET_ARN) { const r = await secrets.send(new GetSecretValueCommand({ SecretId: DB_SECRET_ARN })); const s = JSON.parse(r.SecretString); dbCreds = { username: s.username, password: s.password }; }
    else dbCreds = { username: 'postgres', password: 'postgres' };
  }
  pgClient = new PgClient({ host: RDS_HOST, port: 5432, database: 'postgres', user: dbCreds.username, password: dbCreds.password, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 5000 });
  await pgClient.connect();
  return pgClient;
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  try {
    const m = event.httpMethod, q = event.queryStringParameters || {}, path = event.path || '';

    // auth - Supabase 기반 인증 (공개 엔드포인트)
    if (q.type === 'auth') {
      if (m === 'GET') {
        const { userId, twitterUsername, googleEmail } = q;
        let admin = false;
        if (twitterUsername) admin = twitterUsername.replace('@', '').toLowerCase() === 'tchinnom';
        if (googleEmail && !admin) admin = ['tchinnom@gmail.com', 'admin@supernoba.com'].includes(googleEmail.toLowerCase());
        if (userId && !admin) {
          const { data } = await supabase.from('user_profiles').select('is_admin').eq('id', userId).single();
          if (data) admin = data.is_admin === true;
        }
        return ok({ isAdmin: admin });
      }
      if (m === 'POST') {
        const b = JSON.parse(event.body || '{}');
        if (!b.email || !b.password) return err(400, 'Email and password required');

        const { data, error } = await supabase.auth.signInWithPassword({
          email: b.email,
          password: b.password
        });
        if (error) return err(401, error.message);

        let isAdminUser = ['admin@supernoba.com', 'tchinnom@gmail.com'].includes(b.email.toLowerCase());
        if (!isAdminUser && data.user) {
          const { data: profile } = await supabase.from('user_profiles').select('is_admin').eq('id', data.user.id).single();
          isAdminUser = profile?.is_admin === true;
        }

        if (!isAdminUser) return err(403, 'Not an admin user');
        return ok({ success: true, session: data.session, user: data.user });
      }
    }

    // requests - 관리자 전용
    if (q.type === 'requests') {
      const adminCheck = await checkAdmin(event);
      if (!adminCheck.authorized) return adminCheck.response;

      const { data, error } = await supabase.from('creator_requests').select('*').eq('status', q.status || 'pending').order('created_at', { ascending: true });
      if (error) return err(500, error.message);
      return ok(data || []);
    }

    // symbols - 개별 종목 또는 전체 목록 (공개 엔드포인트)
    if (q.type === 'symbols' || (m === 'GET' && !q.type && !path.includes('sync'))) {
      const symbolMatch = path.match(/\/symbols\/([^\/]+)/);
      if (symbolMatch && symbolMatch[1]) {
        const sym = symbolMatch[1].toUpperCase();
        const { Item } = await dynamodb.send(new GetCommand({ TableName: SYMBOLS_TABLE, Key: { symbol: sym } }));
        if (!Item) return err(404, 'Symbol not found');
        return ok({ symbol: Item.symbol, name: Item.name || Item.symbol, logo_url: Item.logoUrl || null, logoUrl: Item.logoUrl || null, status: Item.status || 'ACTIVE', platform: Item.platform || 'ETC', creatorUrl: Item.creatorUrl || null, profileUrl: Item.profileUrl || null, description: Item.description || null, verified: Item.verified || false, trustScore: Item.trustScore, dividendStatus: Item.dividendStatus || 'pending', dividendPerShare: Item.dividendPerShare || 0, platformStats: Item.platformStats || {}, socialLinks: Item.socialLinks || {}, tags: Item.tags || [], categories: Item.categories || [] });
      }
      const search = q.q ? q.q.toUpperCase() : null;
      const { Items } = await dynamodb.send(new ScanCommand({ TableName: SYMBOLS_TABLE }));
      let r = Items || [];
      if (search) r = r.filter(s => s.symbol.includes(search) || (s.name && s.name.toUpperCase().includes(search)));
      return ok(r);
    }

    // sync - 관리자 전용
    if (m === 'POST' && path.includes('sync')) {
      const adminCheck = await checkAdmin(event);
      if (!adminCheck.authorized) return adminCheck.response;

      const { Items } = await dynamodb.send(new ScanCommand({ TableName: SYMBOLS_TABLE }));
      const deletedSymbols = await valkey.smembers('deleted:symbols');
      const deletedSet = new Set(deletedSymbols);
      if (Items?.length > 0) {
        const p = valkey.pipeline();
        p.del('active:symbols');
        let syncedCount = 0;
        for (const i of Items) {
          if (deletedSet.has(i.symbol)) continue;
          if (i.status === 'ACTIVE') {
            p.sadd('active:symbols', i.symbol);
            p.set(`ticker:${i.symbol}`, JSON.stringify({ symbol: i.symbol, price: i.listingPrice || 0, changePercent: 0, volume: 0 }));
            syncedCount++;
          }
        }
        await p.exec();
        return ok({ synced: syncedCount, skippedDeleted: deletedSymbols.length });
      }
      return ok({ synced: 0 });
    }

    // 종목 상장 API (POST, action=listing) - 관리자 전용
    if (m === 'POST' && q.action === 'listing') {
      const adminCheck = await checkAdmin(event);
      if (!adminCheck.authorized) return adminCheck.response;

      const b = JSON.parse(event.body || '{}');
      const { symbol, name, listingPrice, totalShares, platform, creatorId, ownerId, description, logoUrl, creatorUrl, profileUrl, tags, categories } = b;

      if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') return err(400, 'symbol is required');
      if (!name || typeof name !== 'string' || name.trim() === '') return err(400, 'name is required');
      if (typeof listingPrice !== 'number' || listingPrice <= 0) return err(400, 'listingPrice must be a positive number');
      if (typeof totalShares !== 'number' || totalShares <= 0) return err(400, 'totalShares must be a positive number');
      if (!platform || typeof platform !== 'string' || platform.trim() === '') return err(400, 'platform is required');

      const sym = symbol.toUpperCase().trim();
      const now = new Date().toISOString();

      const isDeleted = await valkey.sismember('deleted:symbols', sym);
      if (isDeleted) return err(400, `Symbol ${sym} was previously deleted. Use action=restore to restore it.`);

      const { Item: existing } = await dynamodb.send(new GetCommand({ TableName: SYMBOLS_TABLE, Key: { symbol: sym } }));
      if (existing) return err(409, `Symbol ${sym} already exists`);

      const item = {
        symbol: sym,
        name: name.trim(),
        listingPrice,
        totalShares,
        platform: platform.trim(),
        status: 'PENDING',
        creatorId: creatorId || null,
        ownerId: ownerId || null,
        description: description || null,
        logoUrl: logoUrl || null,
        creatorUrl: creatorUrl || null,
        profileUrl: profileUrl || null,
        tags: tags || [],
        categories: categories || [],
        verified: false,
        trustScore: 5,
        platformStats: {},
        socialLinks: {},
        prevClose: null,
        lastClose: null,
        createdAt: now,
        updatedAt: now
      };

      await dynamodb.send(new PutCommand({ TableName: SYMBOLS_TABLE, Item: item }));
      await valkey.set(`symbol:${sym}:listingPrice`, listingPrice.toString());

      const tickerData = {
        symbol: sym,
        price: listingPrice,
        open: listingPrice,
        high: listingPrice,
        low: listingPrice,
        close: listingPrice,
        prevClose: listingPrice,
        changePercent: 0,
        change: 0,
        volume: 0,
        value: 0,
        trades: 0,
        updatedAt: now
      };
      await valkey.set(`ticker:${sym}`, JSON.stringify(tickerData));

      return ok({ success: true, symbol: sym, status: 'PENDING', message: `Symbol ${sym} listed successfully. Use activate action to make it active.` });
    }

    // 종목 활성화 API (POST, action=activate) - 관리자 전용
    if (m === 'POST' && q.action === 'activate') {
      const adminCheck = await checkAdmin(event);
      if (!adminCheck.authorized) return adminCheck.response;

      const b = JSON.parse(event.body || '{}');
      const { symbol } = b;

      if (!symbol || typeof symbol !== 'string') return err(400, 'symbol is required');
      const sym = symbol.toUpperCase().trim();

      const isDeleted = await valkey.sismember('deleted:symbols', sym);
      if (isDeleted) return err(400, `Symbol ${sym} was deleted and cannot be activated`);

      const { Item } = await dynamodb.send(new GetCommand({ TableName: SYMBOLS_TABLE, Key: { symbol: sym } }));
      if (!Item) return err(404, `Symbol ${sym} not found`);
      if (Item.status === 'ACTIVE') return err(400, `Symbol ${sym} is already active`);

      const now = new Date().toISOString();

      await dynamodb.send(new UpdateCommand({
        TableName: SYMBOLS_TABLE,
        Key: { symbol: sym },
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': 'ACTIVE', ':updatedAt': now }
      }));

      await valkey.sadd('subscribed:symbols', sym);
      await valkey.sadd('active:symbols', sym);

      return ok({ success: true, symbol: sym, status: 'ACTIVE', message: `Symbol ${sym} activated successfully` });
    }

    // 종목 수정 API (PUT) - 관리자 전용
    if (m === 'PUT' && (q.type === 'symbols' || path.includes('/symbols/'))) {
      const adminCheck = await checkAdmin(event);
      if (!adminCheck.authorized) return adminCheck.response;

      const b = JSON.parse(event.body || '{}');
      const symbolMatch = path.match(/\/symbols\/([^\/]+)/);
      const sym = (symbolMatch?.[1] || b.symbol || '').toUpperCase().trim();
      if (!sym) return err(400, 'symbol is required');

      const { Item } = await dynamodb.send(new GetCommand({ TableName: SYMBOLS_TABLE, Key: { symbol: sym } }));
      if (!Item) return err(404, `Symbol ${sym} not found`);

      const now = new Date().toISOString();
      const updateExprParts = ['updatedAt = :updatedAt'];
      const exprAttrNames = {};
      const exprAttrValues = { ':updatedAt': now };

      const updateableFields = ['name', 'listingPrice', 'totalShares', 'creatorId', 'ownerId', 'description', 'logoUrl', 'creatorUrl', 'profileUrl', 'platform', 'verified', 'trustScore', 'dividendStatus', 'dividendPerShare', 'tags', 'categories', 'platformStats', 'socialLinks', 'prevClose', 'lastClose'];

      for (const field of updateableFields) {
        if (b[field] !== undefined) {
          if (field === 'listingPrice' && (typeof b[field] !== 'number' || b[field] <= 0)) {
            return err(400, 'listingPrice must be a positive number');
          }
          if (field === 'totalShares' && (typeof b[field] !== 'number' || b[field] <= 0)) {
            return err(400, 'totalShares must be a positive number');
          }

          updateExprParts.push(`#${field} = :${field}`);
          exprAttrNames[`#${field}`] = field;
          exprAttrValues[`:${field}`] = b[field];
        }
      }

      if (b.status !== undefined) {
        const validStatuses = ['PENDING', 'ACTIVE', 'SUSPENDED', 'DELISTED'];
        if (!validStatuses.includes(b.status)) return err(400, `Invalid status. Must be one of: ${validStatuses.join(', ')}`);
        updateExprParts.push('#status = :status');
        exprAttrNames['#status'] = 'status';
        exprAttrValues[':status'] = b.status;

        if (b.status === 'ACTIVE') {
          await valkey.sadd('subscribed:symbols', sym);
          await valkey.sadd('active:symbols', sym);
        } else if (b.status !== 'ACTIVE' && Item.status === 'ACTIVE') {
          await valkey.srem('subscribed:symbols', sym);
          await valkey.srem('active:symbols', sym);
        }
      }

      await dynamodb.send(new UpdateCommand({
        TableName: SYMBOLS_TABLE,
        Key: { symbol: sym },
        UpdateExpression: 'SET ' + updateExprParts.join(', '),
        ExpressionAttributeNames: Object.keys(exprAttrNames).length > 0 ? exprAttrNames : undefined,
        ExpressionAttributeValues: exprAttrValues
      }));

      if (b.listingPrice !== undefined) {
        await valkey.set(`symbol:${sym}:listingPrice`, b.listingPrice.toString());
      }

      return ok({ success: true, symbol: sym, message: `Symbol ${sym} updated successfully` });
    }

    // 관리자 알림 API (GET, type=alerts) - 관리자 전용
    if (m === 'GET' && q.type === 'alerts') {
      const adminCheck = await checkAdmin(event);
      if (!adminCheck.authorized) return adminCheck.response;

      const alerts = [];

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

    // 크리에이터 등록 신청/승인/거절 API (POST)
    if (m === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const action = q.action || b.action;

      // action=request: 크리에이터 등록 신청 (공개 엔드포인트)
      if (action === 'request') {
        const { creator_name, creator_url, platform, logo_url } = b;
        if (!creator_name || !creator_url) return err(400, 'creator_name and creator_url are required');

        const { data, error: insertErr } = await supabase
          .from('creator_requests')
          .insert({
            creator_name,
            creator_url,
            platform: platform || 'ETC',
            logo_url: logo_url || null,
            status: 'pending',
            created_at: new Date().toISOString()
          })
          .select()
          .single();

        if (insertErr) {
          console.error('[REQUEST] Supabase Insert Error:', insertErr);
          return err(500, 'Failed to submit request: ' + insertErr.message);
        }

        console.log('[REQUEST] Created:', data);
        return ok({ message: 'Request submitted successfully', request: data });
      }

      // action=approve: 크리에이터 승인 - 관리자 전용
      if (action === 'approve') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        const { requestId, symbol, name, logo_url } = b;
        if (!symbol || !name) return err(400, 'symbol and name are required');

        const sym = symbol.toUpperCase().trim();
        const isDeleted = await valkey.sismember('deleted:symbols', sym);
        if (isDeleted) return err(400, `Symbol ${sym} was previously deleted and cannot be approved`);

        console.log(`[APPROVE] Processing: ${symbol}, ReqID: ${requestId}`);

        let detectedPlatform = 'ETC';
        let creatorUrl = '';
        if (requestId) {
          const { data: reqData } = await supabase.from('creator_requests').select('creator_url, platform').eq('id', requestId).single();
          if (reqData) {
            creatorUrl = reqData.creator_url || '';
            detectedPlatform = reqData.platform || detectPlatform(creatorUrl);
          }
          await supabase.from('creator_requests').update({ status: 'approved', platform: detectedPlatform }).eq('id', requestId);
        }

        const now = new Date().toISOString();
        const newSymbol = {
          symbol: symbol.toUpperCase(),
          name: name || symbol.toUpperCase(),
          base_asset: symbol.toUpperCase(),
          quote_asset: 'BOLT',
          status: 'ACTIVE',
          listingDate: now,
          listingPrice: 0,
          platform: detectedPlatform,
          creatorUrl,
          profileUrl: `/creator/${symbol.toUpperCase()}`,
          logoUrl: logo_url || '',
          marketCap: 0, totalSupply: 0, circulatingSupply: 0, volume24h: 0, priceChange24h: 0,
          allTimeHigh: 0, allTimeLow: 0,
          platformStats: { subscribers: 0, followers: 0, views: 0, videos: 0, lastUpdated: null },
          tags: [], categories: [], verified: false, trustScore: null, dividendStatus: 'pending', dividendPerShare: 0, userRating: 0, ratingCount: 0,
          description: `Official symbol for Creator ${name}`
        };

        await dynamodb.send(new PutCommand({ TableName: SYMBOLS_TABLE, Item: newSymbol }));
        await valkey.sadd('active:symbols', symbol.toUpperCase());

        return ok({ message: `Symbol ${symbol} approved and created`, symbol: newSymbol });
      }

      // action=reject: 크리에이터 거절 - 관리자 전용
      if (action === 'reject') {
        const adminCheck = await checkAdmin(event);
        if (!adminCheck.authorized) return adminCheck.response;

        const { requestId, reason } = b;
        if (!requestId) return err(400, 'requestId is required');

        console.log(`[REJECT] Processing: RequestId: ${requestId}`);

        const { data, error: rejectErr } = await supabase
          .from('creator_requests')
          .update({ status: 'rejected', processed_at: new Date().toISOString(), admin_note: reason || 'Rejected by admin' })
          .eq('id', requestId)
          .select();

        if (rejectErr) {
          console.error('[REJECT] Update Error:', rejectErr);
          return err(500, 'Failed to reject request: ' + rejectErr.message);
        }

        return ok({ message: 'Request rejected', data });
      }
    }

    // 종목 삭제 API (DELETE) - 관리자 전용
    if (m === 'DELETE') {
      const adminCheck = await checkAdmin(event);
      if (!adminCheck.authorized) return adminCheck.response;

      const b = JSON.parse(event.body || '{}');
      const sym = (b.symbol || '').toUpperCase().trim();
      if (!sym) return err(400, 'symbol is required');

      console.log(`[DELETE] Processing symbol: ${sym}`);

      const { Item } = await dynamodb.send(new GetCommand({ TableName: SYMBOLS_TABLE, Key: { symbol: sym } }));
      if (!Item) return err(404, `Symbol ${sym} not found`);

      await valkey.sadd('deleted:symbols', sym);

      const pipe = valkey.pipeline();
      pipe.del(`ticker:${sym}`);
      pipe.del(`depth:${sym}`);
      pipe.del(`symbol:${sym}:listingPrice`);
      pipe.srem('active:symbols', sym);
      pipe.srem('subscribed:symbols', sym);
      pipe.del(`candle:1m:${sym}`);
      pipe.del(`candle:5m:${sym}`);
      pipe.del(`candle:15m:${sym}`);
      pipe.del(`candle:30m:${sym}`);
      pipe.del(`candle:1h:${sym}`);
      pipe.del(`candle:4h:${sym}`);
      pipe.del(`candle:1d:${sym}`);
      pipe.del(`ohlc:${sym}`);
      pipe.del(`mm:config:${sym}`);
      pipe.del(`mm:price:${sym}`);
      pipe.del(`mm:orderCount:${sym}`);
      pipe.srem('mm:running:symbols', sym);
      pipe.del(`symbol:${sym}:main`);
      pipe.del(`symbol:${sym}:subscribers`);
      await pipe.exec();

      try {
        const db = await getPg();
        await db.query('DELETE FROM market_maker_configs WHERE symbol = $1', [sym]);
        console.log(`[DELETE] MarketMaker config deleted for ${sym}`);
      } catch (pgErr) {
        console.warn(`[DELETE] PostgreSQL cleanup warning: ${pgErr.message}`);
      }

      await dynamodb.send(new DeleteCommand({ TableName: SYMBOLS_TABLE, Key: { symbol: sym } }));

      console.log(`[DELETE] Symbol ${sym} deleted successfully`);
      return ok({ success: true, symbol: sym, message: `Symbol ${sym} and all related data deleted successfully` });
    }

    return err(404, 'Not found');
  } catch (e) { console.error('Error:', e); return err(500, e.message); }
};
