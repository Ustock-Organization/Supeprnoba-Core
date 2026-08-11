/**
 * Supernoba-announcements Lambda
 * 사용자 공지 조회 전용 (인증 불요)
 *
 * 엔드포인트:
 * - GET /announcements                    → 활성 공지 전체
 * - GET /announcements?category=greeting  → Greeting만
 * - GET /announcements?category=detail    → Detail만
 * - GET /announcements?id={id}            → 단건 조회
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCommand, QueryCommand, ScanCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const ANNOUNCEMENTS_TABLE = process.env.ANNOUNCEMENTS_TABLE || 'supernoba-announcements';
const MEDIA_BUCKET = process.env.MEDIA_BUCKET || 'supernoba-announcements-media';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));
const s3 = new S3Client({ region: 'ap-northeast-2' });

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Content-Type': 'application/json',
};

const ok = (data) => ({
  statusCode: 200,
  headers: CORS_HEADERS,
  body: JSON.stringify(data),
});

const err = (code, message) => ({
  statusCode: code,
  headers: CORS_HEADERS,
  body: JSON.stringify({ error: message }),
});

/**
 * S3 URL이면 presigned GET URL로 변환
 */
const resolveMediaUrl = async (mediaUrl) => {
  if (!mediaUrl || !mediaUrl.startsWith('s3://')) return mediaUrl;

  // s3://bucket/key 형식 파싱
  const withoutProtocol = mediaUrl.slice(5);
  const slashIndex = withoutProtocol.indexOf('/');
  if (slashIndex === -1) return mediaUrl;

  const bucket = withoutProtocol.slice(0, slashIndex);
  const key = withoutProtocol.slice(slashIndex + 1);

  try {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return await getSignedUrl(s3, command, { expiresIn: 3600 });
  } catch (e) {
    console.error('[announcements] Failed to generate presigned URL:', e.message);
    return mediaUrl;
  }
};

/**
 * 공지 목록의 media_url을 presigned URL로 변환
 */
const resolveMediaUrls = async (items) => {
  return Promise.all(items.map(async (item) => ({
    ...item,
    media_url: await resolveMediaUrl(item.media_url),
  })));
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    const q = event.queryStringParameters || {};

    // 단건 조회
    if (q.id) {
      const { Item } = await dynamodb.send(new GetCommand({
        TableName: ANNOUNCEMENTS_TABLE,
        Key: { announcement_id: q.id },
      }));

      if (!Item || Item.status !== 'ACTIVE') {
        return err(404, 'Announcement not found');
      }

      const resolved = await resolveMediaUrl(Item.media_url);
      return ok({ announcement: { ...Item, media_url: resolved } });
    }

    // 카테고리별 조회 (GSI 사용) — ACTIVE만
    let items;
    if (q.category) {
      if (!['greeting', 'detail'].includes(q.category)) {
        return err(400, 'category must be greeting or detail');
      }

      const result = await dynamodb.send(new QueryCommand({
        TableName: ANNOUNCEMENTS_TABLE,
        IndexName: 'category-status-index',
        KeyConditionExpression: 'category = :cat AND #st = :status',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':cat': q.category,
          ':status': 'ACTIVE',
        },
      }));
      items = result.Items || [];
    } else {
      // 전체 ACTIVE 조회
      const result = await dynamodb.send(new ScanCommand({
        TableName: ANNOUNCEMENTS_TABLE,
        FilterExpression: '#st = :status',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: { ':status': 'ACTIVE' },
      }));
      items = result.Items || [];
    }

    // 정렬: priority ASC, created_at DESC
    items.sort((a, b) => (a.priority || 999) - (b.priority || 999) || (b.created_at || '').localeCompare(a.created_at || ''));

    // media_url presigned 변환
    const resolved = await resolveMediaUrls(items);

    return ok({ announcements: resolved });
  } catch (e) {
    console.error('[announcements] Error:', e);
    return err(500, e.message);
  }
};
