/**
 * Supernoba-creator-requests Lambda
 * DynamoDB 기반 크리에이터 추가 요청 CRUD API
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

// Auth Layer - Cognito JWT 검증
let auth;
try {
  auth = await import('/opt/nodejs/verifyAuth.mjs');
} catch (e) {
  console.warn('[creator-requests] Auth layer not available:', e.message);
  auth = null;
}

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const ddb = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.TABLE_NAME || 'supernoba-creator-requests';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

// HTML 태그 strip (XSS 방지)
function stripHtml(str) {
  if (!str) return '';
  return str.replace(/<[^>]*>/g, '').trim();
}

export const handler = async (event) => {
  const method = event.httpMethod || event.requestContext?.http?.method;
  const path = event.path || event.rawPath || '';

  // CORS preflight
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    // Parse path: /creator-requests, /creator-requests/{userId}, /creator-requests/pending, /creator-requests/{requestId}/approve, /creator-requests/{requestId}/reject
    const pathParts = path.split('/').filter(Boolean);
    const baseIndex = pathParts.indexOf('creator-requests');
    const param1 = pathParts[baseIndex + 1]; // userId, 'pending', or requestId
    const action = pathParts[baseIndex + 2]; // 'approve' or 'reject'

    // GET /creator-requests/pending - Admin: get all pending requests
    if (method === 'GET' && param1 === 'pending') {
      return await getPendingRequests();
    }

    // GET /creator-requests/{userId} - Get user's requests
    if (method === 'GET' && param1 && param1 !== 'pending') {
      return await getMyRequests(param1);
    }

    // POST /creator-requests - Create new request (인증 필수)
    if (method === 'POST' && !param1) {
      // 인증 검증
      if (auth?.verifySelf) {
        const body = JSON.parse(event.body || '{}');
        const authResult = await auth.verifySelf(event, body.userId);
        if (!authResult.success) {
          return response(401, { error: 'AUTH_REQUIRED', message: '로그인이 필요합니다' });
        }
        return await submitRequest(body);
      }
      // Auth layer 미사용 시 userId 필수 체크만
      const body = JSON.parse(event.body || '{}');
      if (!body.userId || body.userId === 'anonymous') {
        return response(400, { error: 'AUTH_REQUIRED', message: '로그인이 필요합니다' });
      }
      return await submitRequest(body);
    }

    // POST /creator-requests/{requestId}/approve - Moved to /approve endpoint
    // Use approval-handler Lambda which creates symbol, RDS partition, and IPO
    if (method === 'POST' && action === 'approve') {
      return response(410, {
        error: 'Use POST /approve endpoint instead',
        message: 'This endpoint only updated status without creating symbol. Use /approve for full approval workflow.'
      });
    }

    // POST /creator-requests/{requestId}/reject - Moved to /reject endpoint
    if (method === 'POST' && action === 'reject') {
      return response(410, {
        error: 'Use POST /reject endpoint instead',
        message: 'Use /reject for proper rejection workflow.'
      });
    }

    return response(404, { error: 'Not Found' });

  } catch (error) {
    console.error('[creator-requests] Error:', error);
    return response(500, { error: error.message });
  }
};

async function submitRequest(request) {
  if (!request.userId || !request.creatorUrl || !request.creatorName) {
    return response(400, { error: 'userId, creatorUrl, and creatorName are required' });
  }

  // 익명 요청 차단
  if (request.userId === 'anonymous') {
    return response(400, { error: 'AUTH_REQUIRED', message: '로그인이 필요합니다' });
  }

  const requestId = randomUUID();
  const now = new Date().toISOString();

  // requester_message: 500자 제한 + HTML strip
  let requesterMessage = null;
  if (request.requesterMessage) {
    requesterMessage = stripHtml(String(request.requesterMessage)).slice(0, 500) || null;
  }

  const item = {
    request_id: requestId,
    user_id: request.userId,
    creator_url: request.creatorUrl,
    creator_name: request.creatorName,
    platform: request.platform || 'youtube',
    logo_url: request.logoUrl || null,
    status: 'pending',
    created_at: now,
    ...(requesterMessage && { requester_message: requesterMessage }),
  };

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
  }));

  // Add 'id' alias for frontend compatibility
  return response(201, { success: true, data: { ...item, id: requestId } });
}

// Helper to add 'id' field for frontend compatibility
function addIdField(items) {
  if (!items) return items;
  if (Array.isArray(items)) {
    return items.map(item => ({ ...item, id: item.request_id }));
  }
  return { ...items, id: items.request_id };
}

async function getMyRequests(userId) {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'user_id-index',
    KeyConditionExpression: 'user_id = :uid',
    ExpressionAttributeValues: {
      ':uid': userId,
    },
    ScanIndexForward: false, // newest first
  }));

  return response(200, addIdField(result.Items || []));
}

async function getPendingRequests() {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'status-index',
    KeyConditionExpression: '#status = :status',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':status': 'pending',
    },
    ScanIndexForward: true, // oldest first (FIFO)
  }));

  return response(200, addIdField(result.Items || []));
}

// approveRequest and rejectRequest removed - use /approve and /reject endpoints
// These functions only updated status without creating symbols, causing incomplete approvals

function response(statusCode, body) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}
