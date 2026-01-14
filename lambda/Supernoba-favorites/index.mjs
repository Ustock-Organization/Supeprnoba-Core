/**
 * Supernoba-favorites Lambda
 * DynamoDB 기반 즐겨찾기 CRUD API
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const ddb = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.TABLE_NAME || 'supernoba-favorites';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

export const handler = async (event) => {
  const method = event.httpMethod || event.requestContext?.http?.method;
  const path = event.path || event.rawPath || '';

  // CORS preflight
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    // Extract userId from path: /favorites/{userId} or /favorites/{userId}/add
    const pathParts = path.split('/').filter(Boolean);
    const favoritesIndex = pathParts.indexOf('favorites');
    const userId = pathParts[favoritesIndex + 1];
    const action = pathParts[favoritesIndex + 2]; // 'add' or 'remove'

    if (!userId) {
      return response(400, { error: 'userId is required' });
    }

    // GET /favorites/{userId}
    if (method === 'GET') {
      return await getFavorites(userId);
    }

    // PUT /favorites/{userId} - Save/Update favorites
    if (method === 'PUT') {
      const body = JSON.parse(event.body || '{}');
      return await saveFavorites(userId, body.symbols || []);
    }

    // POST /favorites/{userId}/add
    if (method === 'POST' && action === 'add') {
      const body = JSON.parse(event.body || '{}');
      return await addFavorite(userId, body.symbol);
    }

    // POST /favorites/{userId}/remove
    if (method === 'POST' && action === 'remove') {
      const body = JSON.parse(event.body || '{}');
      return await removeFavorite(userId, body.symbol);
    }

    return response(404, { error: 'Not Found' });

  } catch (error) {
    console.error('[favorites] Error:', error);
    return response(500, { error: error.message });
  }
};

async function getFavorites(userId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { user_id: userId },
  }));

  return response(200, {
    user_id: userId,
    symbols: result.Item?.symbols || [],
  });
}

async function saveFavorites(userId, symbols) {
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      user_id: userId,
      symbols: symbols,
      updated_at: new Date().toISOString(),
    },
  }));

  return response(200, {
    user_id: userId,
    symbols: symbols,
  });
}

async function addFavorite(userId, symbol) {
  if (!symbol) {
    return response(400, { error: 'symbol is required' });
  }

  // Get current favorites
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { user_id: userId },
  }));

  const current = result.Item?.symbols || [];

  if (!current.includes(symbol)) {
    const updated = [...current, symbol];
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        user_id: userId,
        symbols: updated,
        updated_at: new Date().toISOString(),
      },
    }));
    return response(200, { user_id: userId, symbols: updated });
  }

  return response(200, { user_id: userId, symbols: current });
}

async function removeFavorite(userId, symbol) {
  if (!symbol) {
    return response(400, { error: 'symbol is required' });
  }

  // Get current favorites
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { user_id: userId },
  }));

  const current = result.Item?.symbols || [];
  const updated = current.filter(s => s !== symbol);

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      user_id: userId,
      symbols: updated,
      updated_at: new Date().toISOString(),
    },
  }));

  return response(200, { user_id: userId, symbols: updated });
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}
