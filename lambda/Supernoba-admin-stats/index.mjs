// Supernoba-admin-stats: 거래 통계 대시보드 Lambda (Redis/DynamoDB only - no RDS)
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ScanCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Common Layer - Valkey, CORS
import { getValkeyClient, CORS, response } from '/opt/nodejs/index.mjs';

// Auth Layer - Cognito 인증
const loadAuth = async () => {
  try {
    return await import('/opt/nodejs/verifyAuth.mjs');
  } catch (err) {
    console.error('[admin-stats] Failed to load auth layer:', err.message);
    return {
      verifyAdmin: async () => ({ success: false, error: 'AUTH_LAYER_UNAVAILABLE' }),
      authErrorResponse: (r) => ({
        statusCode: 503,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: r.error || 'Service temporarily unavailable' })
      })
    };
  }
};
const { verifyAdmin, authErrorResponse } = await loadAuth();

const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';
const USERS_TABLE = process.env.USERS_TABLE || 'supernoba-users';
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'supernoba-orders';

// Layer를 통한 클라이언트 초기화
const valkey = getValkeyClient({ type: 'operating' });
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));

// Layer의 CORS.READONLY 사용 (GET, OPTIONS)
const H = CORS.READONLY;
const ok = (d) => response.ok(d, H);
const err = (c, m) => response.error(c, m, H);

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  
  // Cognito 관리자 인증
  const authResult = await verifyAdmin(event);
  if (!authResult.success) {
    return authErrorResponse(authResult, H);
  }
  
  if (event.httpMethod !== 'GET') return err(405, 'Method not allowed');

  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    // 주문 통계 (DynamoDB)
    const ordersResult = await dynamodb.send(new ScanCommand({
      TableName: ORDERS_TABLE,
      ProjectionExpression: '#s, symbol, created_at, quantity, price, side',
      ExpressionAttributeNames: { '#s': 'status' }
    }));

    const orderStats = { PENDING: 0, ACCEPTED: 0, PARTIALLY_FILLED: 0, FILLED: 0, CANCELLED: 0, REJECTED: 0 };
    const ordersBySymbol = {};
    let todayOrders = 0, weekOrders = 0;
    let totalVolume = 0, todayVolume = 0;

    (ordersResult.Items || []).forEach(item => {
      const status = item.status || 'PENDING';
      orderStats[status] = (orderStats[status] || 0) + 1;

      const symbol = item.symbol || 'UNKNOWN';
      if (!ordersBySymbol[symbol]) ordersBySymbol[symbol] = { total: 0, filled: 0, volume: 0 };
      ordersBySymbol[symbol].total++;
      
      const volume = (item.quantity || 0) * (item.price || 0);
      ordersBySymbol[symbol].volume += volume;
      totalVolume += volume;

      if (status === 'FILLED') ordersBySymbol[symbol].filled++;

      const createdAt = item.created_at ? new Date(item.created_at) : null;
      if (createdAt) {
        if (createdAt >= today) {
          todayOrders++;
          todayVolume += volume;
        }
        if (createdAt >= sevenDaysAgo) weekOrders++;
      }
    });

    // 상위 종목 (거래량 기준)
    const topSymbols = Object.entries(ordersBySymbol)
      .map(([symbol, data]) => ({ symbol, ...data }))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 10);

    // 사용자 통계 (DynamoDB user-cache에서)
    let totalUsers = 0, suspendedUsers = 0, newUsersWeek = 0;
    try {
      const { Items: allUsers } = await dynamodb.send(new ScanCommand({
        TableName: USERS_TABLE,
        ProjectionExpression: 'user_id, is_suspended, created_at'
      }));
      const users = allUsers || [];
      totalUsers = users.length;
      suspendedUsers = users.filter(u => u.is_suspended === true).length;
      newUsersWeek = users.filter(u => u.created_at && new Date(u.created_at) >= sevenDaysAgo).length;
    } catch (e) {
      console.error('[STATS] User stats error:', e.message);
    }

    // 실시간 접속자 수
    let connectionCount = 0;
    try {
      const connections = await valkey.keys('ws:*');
      connectionCount = connections.length;
    } catch (e) {
      console.error('[STATS] Redis connection error:', e.message);
    }

    // 종목 수
    let symbolStats = { total: 0, active: 0, pending: 0 };
    try {
      const { Items: symbols } = await dynamodb.send(new ScanCommand({ TableName: SYMBOLS_TABLE }));
      symbolStats.total = symbols?.length || 0;
      symbolStats.active = (symbols || []).filter(s => s.status === 'ACTIVE').length;
      symbolStats.pending = (symbols || []).filter(s => s.status === 'PENDING').length;
    } catch (e) {
      console.error('[STATS] Symbol stats error:', e.message);
    }

    // 마켓메이커 현황
    let runningMMs = [];
    try {
      runningMMs = await valkey.smembers('mm:running:symbols') || [];
    } catch (e) {
      console.error('[STATS] MM stats error:', e.message);
    }

    return ok({
      timestamp: new Date().toISOString(),
      trading: {
        today: {
          orders: todayOrders,
          trades: todayOrders,  // 프론트엔드 호환
          volume: todayVolume
        },
        week: {
          orders: weekOrders,
          trades: weekOrders    // 프론트엔드 호환
        },
        allTime: {
          orders: ordersResult.Items?.length || 0,
          trades: ordersResult.Items?.length || 0,  // 프론트엔드 호환
          volume: totalVolume
        }
      },
      topSymbols,
      orders: {
        byStatus: orderStats,
        total: Object.values(orderStats).reduce((a, b) => a + b, 0),
        fillRate: orderStats.FILLED / (orderStats.FILLED + orderStats.CANCELLED + orderStats.REJECTED || 1) * 100
      },
      users: {
        total: totalUsers,
        suspended: suspendedUsers,
        active: totalUsers - suspendedUsers,
        newThisWeek: newUsersWeek
      },
      symbols: symbolStats,
      marketMakers: {
        running: runningMMs.length,
        symbols: runningMMs
      },
      connections: {
        current: connectionCount
      },
      note: 'RDS not available - showing DynamoDB/Redis data only'
    });
  } catch (e) {
    console.error('Stats error:', e);
    return err(500, 'Failed to fetch stats: ' + e.message);
  }
};
