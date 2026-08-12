/**
 * Supernoba Asset Handler Lambda
 * 사용자 자산 조회 (잔고 + 보유종목)
 *
 * 잔고: supernoba-users 테이블의 balances.BOLT (통합)
 * 보유종목: supernoba-holdings 테이블 (stock-processor가 업데이트)
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { verifySelf, authErrorResponse } from '/opt/nodejs/verifyAuth.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));

const HOLDINGS_TABLE = process.env.HOLDINGS_TABLE || 'supernoba-holdings';
const USERS_TABLE = process.env.USERS_TABLE || 'supernoba-users';

// CORS Headers
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

const ok = (data) => ({ statusCode: 200, headers: CORS, body: JSON.stringify(data) });
const err = (code, msg) => ({ statusCode: code, headers: CORS, body: JSON.stringify({ error: msg }) });

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const { userId } = event.queryStringParameters || {};

  if (!userId) {
    return err(400, 'Missing userId parameter');
  }

  // 인증: 요청 userId가 토큰 소유자와 일치해야 함 (임의 userId 자산 조회 차단)
  const auth = await verifySelf(event, userId);
  if (!auth.success) {
    return authErrorResponse(auth, CORS);
  }

  try {
    // 1. users 테이블에서 balances.BOLT 조회
    const { Item: userItem } = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { user_id: userId },
      ProjectionExpression: 'balances'
    }));

    let balance;
    const bolt = userItem?.balances?.BOLT;
    if (bolt) {
      balance = {
        available: Number(bolt.available || 0),
        locked: Number(bolt.locked || 0),
        total: Number(bolt.available || 0) + Number(bolt.locked || 0),
        currency: 'BOLT'
      };
    } else {
      balance = { available: 0, locked: 0, total: 0, currency: 'BOLT' };
    }

    // 2. 보유종목 조회
    const holdingsResult = await ddb.send(new QueryCommand({
      TableName: HOLDINGS_TABLE,
      KeyConditionExpression: 'user_id = :uid',
      ExpressionAttributeValues: { ':uid': userId }
    }));

    const holdings = (holdingsResult.Items || []).map(h => ({
      symbol: h.symbol,
      quantity: Number(h.quantity || 0),
      avgPrice: Number(h.avg_price || 0),
      locked_quantity: Number(h.locked_quantity || h.locked || 0),
      updated_at: h.updated_at
    }));

    return ok({ balance, holdings });

  } catch (e) {
    console.error('[asset-handler] Error:', e);
    return err(500, 'Failed to fetch assets: ' + e.message);
  }
};
