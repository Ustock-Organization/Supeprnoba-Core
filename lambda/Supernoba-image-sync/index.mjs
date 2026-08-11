/**
 * Supernoba-image-sync: 종목 이미지 S3 미러링 Lambda
 *
 * 클라이언트가 깨진 이미지를 감지 → 보고 → 백엔드가 해당 종목만 갱신
 * 3중 보호: 프론트엔드 쿨다운 + 백엔드 쿨다운 + DynamoDB 동시성 락
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getTwitterBearerToken, getYouTubeApiKey } from '/opt/nodejs/secretsManager.mjs';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';
const S3_BUCKET = process.env.S3_BUCKET || 'supernoba-announcements-media';
const COOLDOWN_MS = 60 * 60 * 1000; // 1시간
const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5분

const ddbClient = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(ddbClient);
const s3 = new S3Client({ region: REGION });

// CORS 헤더
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

function ok(body) {
  return { statusCode: 200, headers: CORS, body: JSON.stringify(body) };
}
function err(code, message) {
  return { statusCode: code, headers: CORS, body: JSON.stringify({ error: message }) };
}

export async function handler(event) {
  // OPTIONS (CORS preflight)
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  // Migrate mode (manual invoke)
  if (event.migrate) {
    return handleMigrate();
  }

  // API mode
  const body = JSON.parse(event.body || '{}');
  const { symbol } = body;
  if (!symbol) return err(400, 'symbol is required');

  return handleImageSync(symbol);
}

async function handleImageSync(symbol) {
  // 1. 종목 조회
  const result = await ddb.send(new GetCommand({
    TableName: SYMBOLS_TABLE,
    Key: { symbol },
  }));
  const item = result.Item;
  if (!item) return err(404, 'Symbol not found');

  // 2. 쿨다운 체크 — 1시간 이내 동기화 되었으면 SKIP
  if (item.logoSyncedAt) {
    const lastSync = new Date(item.logoSyncedAt).getTime();
    if (Date.now() - lastSync < COOLDOWN_MS) {
      return ok({ status: 'COOLDOWN', logoUrl: item.logoUrl || null });
    }
  }

  // 3. 동시성 락 획득 (DynamoDB 조건부 쓰기)
  try {
    const threshold = new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString();
    await ddb.send(new UpdateCommand({
      TableName: SYMBOLS_TABLE,
      Key: { symbol },
      UpdateExpression: 'SET logoSyncLock = :now',
      ConditionExpression: 'attribute_not_exists(logoSyncLock) OR logoSyncLock < :threshold',
      ExpressionAttributeValues: {
        ':now': new Date().toISOString(),
        ':threshold': threshold,
      },
    }));
  } catch (lockErr) {
    if (lockErr.name === 'ConditionalCheckFailedException') {
      return ok({ status: 'LOCKED', logoUrl: item.logoUrl || null });
    }
    throw lockErr;
  }

  try {
    // 4. 플랫폼별 현재 프사 URL 가져오기
    const platform = (item.platform || 'x').toLowerCase();
    const newImageUrl = await fetchCurrentProfileImage(platform, item);

    if (!newImageUrl) {
      await releaseLock(symbol);
      return ok({ status: 'NO_IMAGE', logoUrl: item.logoUrl || null });
    }

    // 5. 이미지 변경 여부 확인
    if (newImageUrl === item.logoSourceUrl) {
      // 소스 URL이 같으면 — 이미지 자체는 안 바뀜, 타임스탬프만 갱신
      await ddb.send(new UpdateCommand({
        TableName: SYMBOLS_TABLE,
        Key: { symbol },
        UpdateExpression: 'SET logoSyncedAt = :now REMOVE logoSyncLock',
        ExpressionAttributeValues: { ':now': new Date().toISOString() },
      }));
      return ok({ status: 'UNCHANGED', logoUrl: item.logoUrl || null });
    }

    // 6. 이미지 다운로드 → S3 업로드
    const s3Key = `symbols/${symbol}/logo.jpg`;
    const imageBuffer = await downloadImage(newImageUrl);

    if (!imageBuffer) {
      await releaseLock(symbol);
      return ok({ status: 'DOWNLOAD_FAILED', logoUrl: item.logoUrl || null });
    }

    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: imageBuffer,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=86400',
    }));

    const s3Url = `https://${S3_BUCKET}.s3.${REGION}.amazonaws.com/${s3Key}`;

    // 7. DynamoDB 업데이트 + 락 해제
    await ddb.send(new UpdateCommand({
      TableName: SYMBOLS_TABLE,
      Key: { symbol },
      UpdateExpression: 'SET logoUrl = :logoUrl, logoSourceUrl = :sourceUrl, logoSyncedAt = :now REMOVE logoSyncLock',
      ExpressionAttributeValues: {
        ':logoUrl': s3Url,
        ':sourceUrl': newImageUrl,
        ':now': new Date().toISOString(),
      },
    }));

    console.log(`[image-sync] Updated ${symbol}: ${newImageUrl} → ${s3Url}`);
    return ok({ status: 'UPDATED', logoUrl: s3Url });
  } catch (syncErr) {
    console.error(`[image-sync] Error syncing ${symbol}:`, syncErr);
    await releaseLock(symbol).catch(() => {});
    return err(500, 'Image sync failed');
  }
}

async function releaseLock(symbol) {
  await ddb.send(new UpdateCommand({
    TableName: SYMBOLS_TABLE,
    Key: { symbol },
    UpdateExpression: 'REMOVE logoSyncLock',
  }));
}

/**
 * 플랫폼별 현재 프로필 이미지 URL 가져오기
 */
async function fetchCurrentProfileImage(platform, symbolItem) {
  try {
    if (platform === 'x') {
      return await fetchTwitterProfileImage(symbolItem);
    } else if (platform === 'youtube') {
      return await fetchYouTubeProfileImage(symbolItem);
    }
    return null;
  } catch (e) {
    console.error(`[image-sync] fetchCurrentProfileImage error (${platform}):`, e.message);
    return null;
  }
}

async function fetchTwitterProfileImage(item) {
  const token = await getTwitterBearerToken();
  if (!token) return null;

  // creatorUrl에서 username 추출 (camelCase/snake_case 호환)
  let username = null;
  const creatorUrl = item.creatorUrl || item.creator_url;
  if (creatorUrl) {
    const match = creatorUrl.match(/(?:twitter\.com|x\.com)\/([^/?]+)/);
    if (match) username = match[1];
  }
  if (!username && (item.creator_username || item.creatorUsername)) {
    username = item.creator_username || item.creatorUsername;
  }
  if (!username) return null;

  const res = await fetch(
    `https://api.twitter.com/2/users/by/username/${username}?user.fields=profile_image_url`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    console.warn(`[image-sync] Twitter API ${res.status} for @${username}`);
    return null;
  }
  const data = await res.json();
  // 400x400 해상도로 변환
  return data.data?.profile_image_url?.replace('_normal', '_400x400') || null;
}

async function fetchYouTubeProfileImage(item) {
  const apiKey = await getYouTubeApiKey();
  if (!apiKey) return null;

  const creatorUrl = item.creatorUrl || item.creator_url;

  // 1. /channel/{id} 형식
  let channelId = null;
  if (creatorUrl) {
    const chMatch = creatorUrl.match(/youtube\.com\/channel\/([^/?]+)/);
    if (chMatch) channelId = chMatch[1];
  }
  if (!channelId) channelId = item.youtube_channel_id || item.youtubeChannelId || null;

  if (channelId) {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?id=${channelId}&part=snippet&key=${apiKey}`
    );
    if (res.ok) {
      const data = await res.json();
      const thumb = data.items?.[0]?.snippet?.thumbnails;
      if (thumb) return thumb.high?.url || thumb.medium?.url || thumb.default?.url || null;
    }
  }

  // 2. /@handle 형식 → forHandle API
  if (creatorUrl) {
    const handleMatch = creatorUrl.match(/youtube\.com\/@([^/?]+)/);
    if (handleMatch) {
      const handle = handleMatch[1];
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?forHandle=${handle}&part=snippet&key=${apiKey}`
      );
      if (res.ok) {
        const data = await res.json();
        const thumb = data.items?.[0]?.snippet?.thumbnails;
        if (thumb) return thumb.high?.url || thumb.medium?.url || thumb.default?.url || null;
      }
    }
  }

  return null;
}

async function downloadImage(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * 마이그레이션 모드: 전체 ACTIVE 종목의 이미지를 S3로 미러링
 */
async function handleMigrate() {
  console.log('[image-sync] Starting migration...');
  const results = { updated: 0, skipped: 0, failed: 0, total: 0 };

  // 전체 ACTIVE 종목 스캔
  let lastKey = undefined;
  const allSymbols = [];
  do {
    const scan = await ddb.send(new ScanCommand({
      TableName: SYMBOLS_TABLE,
      FilterExpression: '#s = :active',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':active': 'ACTIVE' },
      ExclusiveStartKey: lastKey,
    }));
    allSymbols.push(...(scan.Items || []));
    lastKey = scan.LastEvaluatedKey;
  } while (lastKey);

  results.total = allSymbols.length;
  console.log(`[image-sync] Found ${results.total} active symbols`);

  // Twitter 배치 처리 (100명씩)
  const twitterSymbols = allSymbols.filter(s => (s.platform || 'x').toLowerCase() === 'x');
  const youtubeSymbols = allSymbols.filter(s => (s.platform || '').toLowerCase() === 'youtube');

  // Twitter 배치
  if (twitterSymbols.length > 0) {
    const token = await getTwitterBearerToken();
    if (token) {
      for (let i = 0; i < twitterSymbols.length; i += 100) {
        const batch = twitterSymbols.slice(i, i + 100);
        const usernames = batch.map(s => {
          const url = s.creatorUrl || s.creator_url;
          if (url) {
            const match = url.match(/(?:twitter\.com|x\.com)\/([^/?]+)/);
            if (match) return match[1];
          }
          return s.creator_username || s.creatorUsername || null;
        }).filter(Boolean);

        if (usernames.length === 0) continue;

        try {
          const res = await fetch(
            `https://api.twitter.com/2/users/by?usernames=${usernames.join(',')}&user.fields=profile_image_url`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!res.ok) { console.warn(`[migrate] Twitter batch API ${res.status}`); continue; }
          const data = await res.json();
          const usernameToImage = {};
          (data.data || []).forEach(u => {
            usernameToImage[u.username.toLowerCase()] = u.profile_image_url?.replace('_normal', '_400x400');
          });

          for (const sym of batch) {
            let un = null;
            const symUrl = sym.creatorUrl || sym.creator_url;
            if (symUrl) {
              const match = symUrl.match(/(?:twitter\.com|x\.com)\/([^/?]+)/);
              if (match) un = match[1].toLowerCase();
            }
            if (!un) un = (sym.creator_username || sym.creatorUsername)?.toLowerCase();
            const imgUrl = un ? usernameToImage[un] : null;
            if (!imgUrl) { results.skipped++; continue; }

            try {
              const buf = await downloadImage(imgUrl);
              if (!buf) { results.skipped++; continue; }
              const s3Key = `symbols/${sym.symbol}/logo.jpg`;
              await s3.send(new PutObjectCommand({
                Bucket: S3_BUCKET, Key: s3Key, Body: buf,
                ContentType: 'image/jpeg', CacheControl: 'public, max-age=86400',
              }));
              const s3Url = `https://${S3_BUCKET}.s3.${REGION}.amazonaws.com/${s3Key}`;
              await ddb.send(new UpdateCommand({
                TableName: SYMBOLS_TABLE, Key: { symbol: sym.symbol },
                UpdateExpression: 'SET logoUrl = :url, logoSourceUrl = :src, logoSyncedAt = :now',
                ExpressionAttributeValues: { ':url': s3Url, ':src': imgUrl, ':now': new Date().toISOString() },
              }));
              results.updated++;
              console.log(`[migrate] Twitter ${sym.symbol}: → ${s3Url}`);
            } catch { results.failed++; }
          }
        } catch (batchErr) {
          console.error('[migrate] Twitter batch error:', batchErr.message);
        }
      }
    }
  }

  // YouTube — @handle 개별 조회 (배치 API가 handle을 지원하지 않으므로)
  if (youtubeSymbols.length > 0) {
    const apiKey = await getYouTubeApiKey();
    if (apiKey) {
      for (const sym of youtubeSymbols) {
        const url = sym.creatorUrl || sym.creator_url;
        try {
          let imgUrl = null;

          // 1. /channel/{id} 형식
          const chMatch = url?.match(/youtube\.com\/channel\/([^/?]+)/);
          const channelId = chMatch?.[1] || sym.youtube_channel_id || sym.youtubeChannelId;
          if (channelId) {
            const res = await fetch(
              `https://www.googleapis.com/youtube/v3/channels?id=${channelId}&part=snippet&key=${apiKey}`
            );
            if (res.ok) {
              const data = await res.json();
              const thumb = data.items?.[0]?.snippet?.thumbnails;
              imgUrl = thumb?.high?.url || thumb?.medium?.url || thumb?.default?.url || null;
            }
          }

          // 2. /@handle 형식
          if (!imgUrl && url) {
            const handleMatch = url.match(/youtube\.com\/@([^/?]+)/);
            if (handleMatch) {
              const res = await fetch(
                `https://www.googleapis.com/youtube/v3/channels?forHandle=${handleMatch[1]}&part=snippet&key=${apiKey}`
              );
              if (res.ok) {
                const data = await res.json();
                const thumb = data.items?.[0]?.snippet?.thumbnails;
                imgUrl = thumb?.high?.url || thumb?.medium?.url || thumb?.default?.url || null;
              }
            }
          }

          if (!imgUrl) { results.skipped++; continue; }

          const buf = await downloadImage(imgUrl);
          if (!buf) { results.skipped++; continue; }
          const s3Key = `symbols/${sym.symbol}/logo.jpg`;
          await s3.send(new PutObjectCommand({
            Bucket: S3_BUCKET, Key: s3Key, Body: buf,
            ContentType: 'image/jpeg', CacheControl: 'public, max-age=86400',
          }));
          const s3Url = `https://${S3_BUCKET}.s3.${REGION}.amazonaws.com/${s3Key}`;
          await ddb.send(new UpdateCommand({
            TableName: SYMBOLS_TABLE, Key: { symbol: sym.symbol },
            UpdateExpression: 'SET logoUrl = :url, logoSourceUrl = :src, logoSyncedAt = :now',
            ExpressionAttributeValues: { ':url': s3Url, ':src': imgUrl, ':now': new Date().toISOString() },
          }));
          results.updated++;
          console.log(`[migrate] YouTube ${sym.symbol}: → ${s3Url}`);
        } catch (e) {
          console.error(`[migrate] YouTube ${sym.symbol} error:`, e.message);
          results.failed++;
        }
      }
    }
  }

  console.log(`[image-sync] Migration complete:`, results);
  return ok({ status: 'MIGRATED', ...results });
}
