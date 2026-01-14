// Supernoba-admin-monitoring: 실시간 모니터링 Lambda
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ScanCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Common Layer - Valkey, CORS
import { getValkeyClient, CORS, response } from '/opt/nodejs/index.mjs';

const ADMIN_KEY = process.env.ADMIN_API_KEY;
const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';

// Layer를 통한 클라이언트 초기화
const valkey = getValkeyClient({ preset: 'admin' });
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));

// Layer의 CORS.READONLY 사용 (GET, OPTIONS)
const H = CORS.READONLY;
const isAdmin = (e) => !ADMIN_KEY || (e.headers?.Authorization || e.headers?.authorization) === ADMIN_KEY;
const ok = (d) => response.ok(d, H);
const err = (c, m) => response.error(c, m, H);

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  if (!isAdmin(event)) return err(403, 'Unauthorized');
  if (event.httpMethod !== 'GET') return err(405, 'Method not allowed');

  try {
    const q = event.queryStringParameters || {};
    const { section } = q; // connections, orderbooks, marketmakers, errors, all

    const result = {};

    // WebSocket 연결 목록
    if (!section || section === 'connections' || section === 'all') {
      const connectionKeys = await valkey.keys('ws:*');
      const connections = await Promise.all(connectionKeys.slice(0, 100).map(async (key) => {
        const data = await valkey.get(key);
        try {
          const parsed = JSON.parse(data);
          return {
            connectionId: key.replace('ws:', ''),
            userId: parsed.userId || 'anonymous',
            isLoggedIn: parsed.isLoggedIn || false,
            connectedAt: parsed.connectedAt,
            userEmail: parsed.userEmail
          };
        } catch {
          return { connectionId: key.replace('ws:', ''), raw: data };
        }
      }));

      // 사용자별 연결 수 집계
      const userConnections = {};
      connections.forEach(c => {
        if (c.userId && c.userId !== 'anonymous') {
          userConnections[c.userId] = (userConnections[c.userId] || 0) + 1;
        }
      });

      result.connections = {
        total: connectionKeys.length,
        loggedIn: connections.filter(c => c.isLoggedIn).length,
        anonymous: connections.filter(c => !c.isLoggedIn).length,
        details: connections,
        byUser: Object.entries(userConnections).map(([userId, count]) => ({ userId, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 20)
      };
    }

    // 심볼 구독 현황
    if (!section || section === 'subscriptions' || section === 'all') {
      const subscribedSymbols = await valkey.smembers('subscribed:symbols');
      const symbolSubscribers = await Promise.all(subscribedSymbols.map(async (symbol) => {
        const mainCount = await valkey.scard(`symbol:${symbol}:main`);
        const subCount = await valkey.scard(`symbol:${symbol}:sub`);
        return { symbol, main: mainCount, sub: subCount, total: mainCount + subCount };
      }));

      result.subscriptions = {
        totalSymbols: subscribedSymbols.length,
        bySymbol: symbolSubscribers.sort((a, b) => b.total - a.total)
      };
    }

    // 오더북 상태
    if (!section || section === 'orderbooks' || section === 'all') {
      const { Items: symbols } = await dynamodb.send(new ScanCommand({
        TableName: SYMBOLS_TABLE,
        FilterExpression: '#s = :active',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':active': 'ACTIVE' }
      }));

      const orderbookStatus = await Promise.all((symbols || []).slice(0, 20).map(async (sym) => {
        const [depth, ticker, ohlc] = await Promise.all([
          valkey.get(`depth:${sym.symbol}`),
          valkey.get(`ticker:${sym.symbol}`),
          valkey.get(`ohlc:${sym.symbol}`)
        ]);

        let status = 'no_data';
        let parsed = {};

        if (depth) {
          try {
            parsed = JSON.parse(depth);
            status = 'active';
          } catch {
            status = 'parse_error';
          }
        }

        let tickerParsed = {};
        if (ticker) {
          try { tickerParsed = JSON.parse(ticker); } catch {}
        }

        let ohlcParsed = {};
        if (ohlc) {
          try { ohlcParsed = JSON.parse(ohlc); } catch {}
        }

        return {
          symbol: sym.symbol,
          name: sym.name,
          status,
          bidLevels: parsed.b?.length || 0,
          askLevels: parsed.a?.length || 0,
          lastPrice: parsed.p || tickerParsed.p || 0,
          change: parsed.c || tickerParsed.c || 0,
          volume: ohlcParsed.v || 0,
          updatedAt: parsed.t ? new Date(parsed.t).toISOString() : null,
          listingPrice: sym.listingPrice
        };
      }));

      result.orderbooks = {
        total: symbols?.length || 0,
        active: orderbookStatus.filter(o => o.status === 'active').length,
        noData: orderbookStatus.filter(o => o.status === 'no_data').length,
        details: orderbookStatus
      };
    }

    // 마켓메이커 상태
    if (!section || section === 'marketmakers' || section === 'all') {
      const runningMMs = await valkey.smembers('mm:running:symbols');
      const mmStatus = await Promise.all(runningMMs.map(async (symbol) => {
        const [price, orderCount, config] = await Promise.all([
          valkey.get(`mm:price:${symbol}`),
          valkey.get(`mm:orderCount:${symbol}`),
          valkey.get(`mm:config:${symbol}`)
        ]);

        let configParsed = {};
        if (config) {
          try { configParsed = JSON.parse(config); } catch {}
        }

        return {
          symbol,
          currentPrice: price ? parseFloat(price) : null,
          orderCount: orderCount ? parseInt(orderCount) : 0,
          basePrice: configParsed.basePrice,
          tickInterval: configParsed.tickInterval
        };
      }));

      result.marketMakers = {
        running: runningMMs.length,
        totalOrders: mmStatus.reduce((sum, m) => sum + m.orderCount, 0),
        details: mmStatus
      };
    }

    // 최근 에러 로그
    if (!section || section === 'errors' || section === 'all') {
      const recentErrors = await valkey.lrange('engine:errors', 0, 49);
      result.errors = {
        count: recentErrors.length,
        recent: recentErrors.map(e => {
          try { return JSON.parse(e); } catch { return { message: e, raw: true }; }
        })
      };
    }

    // 시스템 상태 요약
    if (!section || section === 'all') {
      // Redis 연결 상태
      let redisStatus = 'connected';
      try {
        await valkey.ping();
      } catch {
        redisStatus = 'disconnected';
      }

      // 최근 활동 (1분 내 ticker 업데이트)
      const oneMinuteAgo = Date.now() - 60000;
      let recentActivity = 0;

      if (result.orderbooks?.details) {
        recentActivity = result.orderbooks.details.filter(o => {
          if (!o.updatedAt) return false;
          return new Date(o.updatedAt).getTime() > oneMinuteAgo;
        }).length;
      }

      result.system = {
        status: redisStatus === 'connected' ? 'healthy' : 'degraded',
        redis: redisStatus,
        timestamp: new Date().toISOString(),
        recentActivitySymbols: recentActivity,
        uptime: process.uptime ? process.uptime() : null
      };
    }

    return ok({
      timestamp: new Date().toISOString(),
      ...result
    });
  } catch (e) {
    console.error('Monitoring error:', e);
    return err(500, 'Failed to fetch monitoring data: ' + e.message);
  }
};
