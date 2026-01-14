// Supernoba-admin-stats: 거래 통계 대시보드 Lambda
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ScanCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import pg from 'pg';

// Common Layer - Valkey, CORS
import { getValkeyClient, CORS, response } from '/opt/nodejs/index.mjs';

const { Client: PgClient } = pg;
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';
const USER_CACHE_TABLE = process.env.USER_CACHE_TABLE || 'supernoba-user-cache';
const RDS_HOST = process.env.RDS_ENDPOINT || 'supernoba-rdb1.cluster-cyxfcbnpfoci.ap-northeast-2.rds.amazonaws.com';
const DB_SECRET_ARN = process.env.DB_SECRET_ARN || '';

// Layer를 통한 클라이언트 초기화
const valkey = getValkeyClient({ preset: 'admin' });
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));
const secrets = new SecretsManagerClient({ region: 'ap-northeast-2' });

let dbCreds = null, pgClient = null;

// Layer의 CORS.READONLY 사용 (GET, OPTIONS)
const H = CORS.READONLY;
const isAdmin = (e) => !ADMIN_KEY || (e.headers?.Authorization || e.headers?.authorization) === ADMIN_KEY;
const ok = (d) => response.ok(d, H);
const err = (c, m) => response.error(c, m, H);

async function getPg() {
  if (pgClient) return pgClient;
  if (!dbCreds) {
    if (process.env.DB_USERNAME && process.env.DB_PASSWORD) {
      dbCreds = { username: process.env.DB_USERNAME, password: process.env.DB_PASSWORD };
    } else if (DB_SECRET_ARN) {
      const r = await secrets.send(new GetSecretValueCommand({ SecretId: DB_SECRET_ARN }));
      const s = JSON.parse(r.SecretString);
      dbCreds = { username: s.username, password: s.password };
    } else {
      dbCreds = { username: 'postgres', password: 'postgres' };
    }
  }
  pgClient = new PgClient({
    host: RDS_HOST,
    port: 5432,
    database: 'postgres',
    user: dbCreds.username,
    password: dbCreds.password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000
  });
  await pgClient.connect();
  return pgClient;
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  if (!isAdmin(event)) return err(403, 'Unauthorized');
  if (event.httpMethod !== 'GET') return err(405, 'Method not allowed');

  try {
    const q = event.queryStringParameters || {};
    const { period = 'all' } = q; // today, week, month, all

    const db = await getPg();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

    // 거래 통계 쿼리
    const tradeStatsQuery = `
      SELECT
        COUNT(*) as total_trades,
        COALESCE(SUM(quantity * price), 0) as total_volume,
        COALESCE(SUM(quantity), 0) as total_quantity,
        COALESCE(AVG(price), 0) as avg_price,
        COALESCE(MAX(price), 0) as max_price,
        COALESCE(MIN(NULLIF(price, 0)), 0) as min_price
      FROM trade_history
      WHERE created_at >= $1
    `;

    // 기간별 통계 병렬 조회
    const [todayStats, weekStats, monthStats, allTimeStats] = await Promise.all([
      db.query(tradeStatsQuery, [today.toISOString()]),
      db.query(tradeStatsQuery, [sevenDaysAgo.toISOString()]),
      db.query(tradeStatsQuery, [thirtyDaysAgo.toISOString()]),
      db.query('SELECT COUNT(*) as total_trades, COALESCE(SUM(quantity * price), 0) as total_volume, COALESCE(SUM(quantity), 0) as total_quantity FROM trade_history')
    ]);

    // 심볼별 거래량 (상위 10개)
    const topSymbolsResult = await db.query(`
      SELECT
        symbol,
        COUNT(*) as trade_count,
        SUM(quantity * price) as volume,
        SUM(quantity) as quantity,
        AVG(price) as avg_price,
        MAX(price) as high,
        MIN(NULLIF(price, 0)) as low
      FROM trade_history
      WHERE created_at >= $1
      GROUP BY symbol
      ORDER BY volume DESC
      LIMIT 10
    `, [sevenDaysAgo.toISOString()]);

    // 시간대별 거래량 (최근 24시간)
    const hourlyVolumeResult = await db.query(`
      SELECT
        DATE_TRUNC('hour', created_at) as hour,
        COUNT(*) as trades,
        SUM(quantity * price) as volume
      FROM trade_history
      WHERE created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY DATE_TRUNC('hour', created_at)
      ORDER BY hour DESC
    `);

    // 일별 거래량 (최근 30일)
    const dailyVolumeResult = await db.query(`
      SELECT
        DATE_TRUNC('day', created_at) as day,
        COUNT(*) as trades,
        SUM(quantity * price) as volume
      FROM trade_history
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE_TRUNC('day', created_at)
      ORDER BY day DESC
    `);

    // 주문 상태별 통계 (DynamoDB)
    const ordersResult = await dynamodb.send(new ScanCommand({
      TableName: 'supernoba-orders',
      ProjectionExpression: '#s, symbol, created_at',
      ExpressionAttributeNames: { '#s': 'status' }
    }));

    const orderStats = { PENDING: 0, ACCEPTED: 0, PARTIALLY_FILLED: 0, FILLED: 0, CANCELLED: 0, REJECTED: 0 };
    const ordersBySymbol = {};
    (ordersResult.Items || []).forEach(item => {
      const status = item.status || 'PENDING';
      orderStats[status] = (orderStats[status] || 0) + 1;

      const symbol = item.symbol || 'UNKNOWN';
      if (!ordersBySymbol[symbol]) ordersBySymbol[symbol] = { total: 0, filled: 0 };
      ordersBySymbol[symbol].total++;
      if (status === 'FILLED') ordersBySymbol[symbol].filled++;
    });

    // 사용자 통계 (DynamoDB user-cache에서)
    let totalUsers = 0;
    let suspendedUsers = 0;
    let newUsersWeek = 0;
    try {
      const { Items: allUsers } = await dynamodb.send(new ScanCommand({
        TableName: USER_CACHE_TABLE,
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
    const connections = await valkey.keys('ws:*');

    // 종목 수
    const { Items: symbols } = await dynamodb.send(new ScanCommand({ TableName: SYMBOLS_TABLE }));
    const activeSymbols = (symbols || []).filter(s => s.status === 'ACTIVE').length;
    const pendingSymbols = (symbols || []).filter(s => s.status === 'PENDING').length;

    // 마켓메이커 현황
    const runningMMs = await valkey.smembers('mm:running:symbols');

    return ok({
      timestamp: new Date().toISOString(),
      trading: {
        today: {
          trades: parseInt(todayStats.rows[0]?.total_trades || 0),
          volume: parseFloat(todayStats.rows[0]?.total_volume || 0),
          quantity: parseFloat(todayStats.rows[0]?.total_quantity || 0),
          avgPrice: parseFloat(todayStats.rows[0]?.avg_price || 0)
        },
        week: {
          trades: parseInt(weekStats.rows[0]?.total_trades || 0),
          volume: parseFloat(weekStats.rows[0]?.total_volume || 0),
          quantity: parseFloat(weekStats.rows[0]?.total_quantity || 0)
        },
        month: {
          trades: parseInt(monthStats.rows[0]?.total_trades || 0),
          volume: parseFloat(monthStats.rows[0]?.total_volume || 0),
          quantity: parseFloat(monthStats.rows[0]?.total_quantity || 0)
        },
        allTime: {
          trades: parseInt(allTimeStats.rows[0]?.total_trades || 0),
          volume: parseFloat(allTimeStats.rows[0]?.total_volume || 0),
          quantity: parseFloat(allTimeStats.rows[0]?.total_quantity || 0)
        }
      },
      topSymbols: topSymbolsResult.rows.map(r => ({
        symbol: r.symbol,
        trades: parseInt(r.trade_count),
        volume: parseFloat(r.volume),
        quantity: parseFloat(r.quantity),
        avgPrice: parseFloat(r.avg_price),
        high: parseFloat(r.high || 0),
        low: parseFloat(r.low || 0)
      })),
      hourlyVolume: hourlyVolumeResult.rows.map(r => ({
        hour: r.hour,
        trades: parseInt(r.trades),
        volume: parseFloat(r.volume)
      })),
      dailyVolume: dailyVolumeResult.rows.map(r => ({
        day: r.day,
        trades: parseInt(r.trades),
        volume: parseFloat(r.volume)
      })),
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
      symbols: {
        total: symbols?.length || 0,
        active: activeSymbols,
        pending: pendingSymbols
      },
      marketMakers: {
        running: runningMMs.length,
        symbols: runningMMs
      },
      connections: {
        current: connections.length
      }
    });
  } catch (e) {
    console.error('Stats error:', e);
    return err(500, 'Failed to fetch stats: ' + e.message);
  }
};
