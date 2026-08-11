// Supernoba-history Lambda — Order & Trade History API
// GET /history/orders → DynamoDB supernoba-orders (user's order history)
// GET /history/trades → PostgreSQL trade_history (user's trade history)

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import pg from 'pg';

const { Client } = pg;

// === Auth Layer Import ===
let auth;
try {
  auth = await import('/opt/nodejs/verifyAuth.mjs');
} catch (e) {
  console.error('[history] CRITICAL: Auth layer failed to load:', e.message);
  auth = {
    verifySelf: async () => ({ success: false, error: 'AUTH_LAYER_UNAVAILABLE', message: 'Authentication service unavailable' }),
    authErrorResponse: (r, h) => ({
      statusCode: 503,
      headers: h || { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: r.error || 'AUTH_UNAVAILABLE', message: 'Service temporarily unavailable.' })
    })
  };
}
const { verifySelf, authErrorResponse } = auth;

// === Clients ===
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));
const secretsManager = new SecretsManagerClient({ region: 'ap-northeast-2' });

// === Config ===
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'supernoba-orders';
const RDS_HOST = process.env.RDS_ENDPOINT || 'supernoba-rdb1.cluster-cyxfcbnpfoci.ap-northeast-2.rds.amazonaws.com';
const RDS_PORT = parseInt(process.env.RDS_PORT || '5432');
const DB_NAME = process.env.DB_NAME || 'postgres';
const DB_SECRET_ARN = process.env.DB_SECRET_ARN || '';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

// === RDS Credentials (cached) ===
let cachedCredentials = null;

async function getDbCredentials() {
  const envUsername = process.env.DB_USERNAME;
  const envPassword = process.env.DB_PASSWORD;

  if (envUsername && envPassword) {
    return { username: envUsername, password: envPassword };
  }

  if (cachedCredentials) return cachedCredentials;

  if (!DB_SECRET_ARN) {
    return { username: 'postgres', password: '' };
  }

  try {
    const res = await secretsManager.send(new GetSecretValueCommand({ SecretId: DB_SECRET_ARN }));
    cachedCredentials = JSON.parse(res.SecretString);
    return cachedCredentials;
  } catch (err) {
    console.error('[history] Secrets Manager error:', err.message);
    return { username: 'postgres', password: '' };
  }
}

// === GET /history/orders — DynamoDB ===
async function getOrderHistory(userId, params) {
  const limit = Math.min(parseInt(params.limit || DEFAULT_LIMIT), MAX_LIMIT);
  const statusFilter = params.status; // optional: PENDING, PARTIAL_FILL, FILLED, CANCELLED
  const symbol = params.symbol;       // optional filter

  const queryParams = {
    TableName: ORDERS_TABLE,
    KeyConditionExpression: 'user_id = :uid',
    ExpressionAttributeValues: { ':uid': userId },
    ScanIndexForward: false, // newest first (order_id is UUID, but created_at sort will be applied client-side)
    Limit: limit,
  };

  // Optional filters
  const filters = [];
  if (statusFilter) {
    // Support comma-separated statuses like "ACCEPTED,PARTIAL_FILL"
    const statuses = statusFilter.split(',').map(s => s.trim());
    if (statuses.length === 1) {
      filters.push('#status = :status');
      queryParams.ExpressionAttributeValues[':status'] = statuses[0];
    } else {
      const statusPlaceholders = statuses.map((s, i) => `:status${i}`);
      filters.push(`#status IN (${statusPlaceholders.join(', ')})`);
      statuses.forEach((s, i) => {
        queryParams.ExpressionAttributeValues[`:status${i}`] = s;
      });
    }
    queryParams.ExpressionAttributeNames = { ...queryParams.ExpressionAttributeNames, '#status': 'status' };
  }
  if (symbol) {
    filters.push('symbol = :symbol');
    queryParams.ExpressionAttributeValues[':symbol'] = symbol.toUpperCase();
  }

  // Pagination loop: when filter is active, DynamoDB Limit applies before filter
  let allItems = [];
  let lastEvaluatedKey = undefined;
  const maxPages = 5; // Safety limit to prevent infinite loops

  if (filters.length > 0) {
    queryParams.FilterExpression = filters.join(' AND ');
  }

  for (let page = 0; page < maxPages; page++) {
    if (lastEvaluatedKey) {
      queryParams.ExclusiveStartKey = lastEvaluatedKey;
    }

    const result = await ddb.send(new QueryCommand(queryParams));
    allItems.push(...(result.Items || []));

    // Stop if we have enough results or no more pages
    if (allItems.length >= limit || !result.LastEvaluatedKey) {
      break;
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  }

  // Trim to requested limit
  allItems = allItems.slice(0, limit);

  // Filter out ghost items (incomplete DynamoDB records missing required fields)
  const validItems = allItems.filter(item =>
    item.symbol && item.side && item.price !== undefined && item.quantity !== undefined
  );

  const orders = validItems.map(item => ({
    order_id: item.order_id,
    symbol: item.symbol,
    side: item.side,
    type: item.type,
    price: item.price,
    quantity: item.quantity,
    filled_qty: item.filled_qty || 0,
    status: item.status,
    lock_amount: item.lock_amount || 0,
    created_at: item.created_at,
    updated_at: item.updated_at,
    cancel_processed: item.cancel_processed || false,
  }));

  // Sort by created_at descending (DynamoDB Query on SK=order_id doesn't guarantee time order)
  orders.sort((a, b) => {
    if (!a.created_at || !b.created_at) return 0;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  return { orders, count: orders.length };
}

// === GET /history/trades — PostgreSQL ===
async function getTradeHistory(userId, params) {
  const limit = Math.min(parseInt(params.limit || DEFAULT_LIMIT), MAX_LIMIT);
  const symbol = params.symbol;

  const creds = await getDbCredentials();
  const client = new Client({
    host: RDS_HOST,
    port: RDS_PORT,
    database: DB_NAME,
    user: creds.username,
    password: creds.password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });

  try {
    await client.connect();

    let query = `
      SELECT trade_id, symbol, price, quantity,
             buyer_order_id, seller_order_id,
             buyer_user_id, seller_user_id,
             buyer_is_maker, executed_at
      FROM trade_history
      WHERE (buyer_user_id = $1 OR seller_user_id = $1)
    `;
    const values = [userId];
    let paramIdx = 2;

    if (symbol) {
      query += ` AND symbol = $${paramIdx}`;
      values.push(symbol.toUpperCase());
      paramIdx++;
    }

    query += ` ORDER BY executed_at DESC LIMIT $${paramIdx}`;
    values.push(limit);

    const result = await client.query(query, values);

    const trades = result.rows.map(row => {
      const isBuyer = row.buyer_user_id === userId;
      return {
        trade_id: row.trade_id,
        symbol: row.symbol,
        side: isBuyer ? 'BUY' : 'SELL',
        price: parseFloat(row.price),
        quantity: parseFloat(row.quantity),
        order_id: isBuyer ? row.buyer_order_id : row.seller_order_id,
        is_maker: isBuyer ? row.buyer_is_maker : !row.buyer_is_maker,
        timestamp: row.executed_at,
        created_at: row.executed_at,
      };
    });

    return { trades, count: trades.length };
  } finally {
    await client.end().catch(() => {});
  }
}

// === Main Handler ===
export const handler = async (event) => {
  // CORS Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: HEADERS, body: '' };
  }

  // Only GET allowed
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: HEADERS,
      body: JSON.stringify({ error: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported' })
    };
  }

  try {
    const params = event.queryStringParameters || {};
    const userId = params.userId;

    if (!userId) {
      return {
        statusCode: 400,
        headers: HEADERS,
        body: JSON.stringify({ error: 'MISSING_USER_ID', message: 'userId parameter is required' })
      };
    }

    // Authenticate: user can only query their own history
    const authResult = await verifySelf(event, userId);
    if (!authResult.success) {
      console.warn('[history] Auth failed for user', userId, ':', authResult.error);
      return authErrorResponse(authResult, HEADERS);
    }

    // Route by path
    const path = event.path || event.resource || '';

    if (path.endsWith('/history/orders')) {
      const data = await getOrderHistory(userId, params);
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify(data)
      };
    }

    if (path.endsWith('/history/trades')) {
      const data = await getTradeHistory(userId, params);
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify(data)
      };
    }

    return {
      statusCode: 404,
      headers: HEADERS,
      body: JSON.stringify({ error: 'NOT_FOUND', message: 'Use /history/orders or /history/trades' })
    };
  } catch (e) {
    console.error('[history] Error:', e.message, e.stack);
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ error: 'INTERNAL_ERROR', message: 'Internal server error' })
    };
  }
};
