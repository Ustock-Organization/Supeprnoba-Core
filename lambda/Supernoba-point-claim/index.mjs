/**
 * Supernoba-point-claim Lambda
 *
 * Endpoints:
 *   POST /rewards/claim        — Premium daily reward claim
 *   POST /rewards/ad-complete   — Ad watch completion reward
 *   GET  /rewards/status        — Claim status + settings
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CORS, response, handleOptions } from '/opt/nodejs/index.mjs';
import { verifyAuth, authErrorResponse, resolveUserId } from '/opt/nodejs/verifyAuth.mjs';


// ── DynamoDB ────────────────────────────────────────────
const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const USER_TABLE = process.env.USER_TABLE || 'supernoba-users';
const SETTINGS_TABLE = process.env.SETTINGS_TABLE || 'supernoba-settings';

// ── Test Mode ───────────────────────────────────────────
// VPC 밖 Lambda → Valkey 접근 불가 → DynamoDB settings에서 직접 읽기
async function isTestMode() {
  try {
    const { Item } = await dynamodb.send(new GetCommand({
      TableName: SETTINGS_TABLE,
      Key: { setting_id: 'SYSTEM_SETTINGS' },
      ProjectionExpression: 'settings.platform.beta_mode',
    }));
    return Item?.settings?.platform?.beta_mode === true;
  } catch (err) {
    console.error('[point-claim] isTestMode check failed:', err.message);
    return false;
  }
}

// ── Helpers ─────────────────────────────────────────────

/** KST 기준 오늘 날짜 (YYYY-MM-DD) */
function getTodayKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** supernoba-settings에서 rewards 설정 조회 */
async function getRewardSettings() {
  try {
    const { Item } = await dynamodb.send(new GetCommand({
      TableName: SETTINGS_TABLE,
      Key: { setting_id: 'SYSTEM_SETTINGS' },
      ProjectionExpression: 'settings.rewards',
    }));
    return Item?.settings?.rewards || {};
  } catch (err) {
    console.error('[point-claim] Failed to read settings:', err.message);
    return {};
  }
}

// ── POST /rewards/claim ─────────────────────────────────
async function claimPremiumReward(userId) {
  const rewards = await getRewardSettings();
  const points = rewards.premiumDailyPoints ?? 5000;
  const today = getTodayKST();

  // 1) 구독 상태 확인 (Test/Live suffix 적용)
  const testMode = await isTestMode();
  const suffix = testMode ? '_test' : '';

  const { Item: user } = await dynamodb.send(new GetCommand({
    TableName: USER_TABLE,
    Key: { user_id: userId },
    ProjectionExpression: `subscription_status${suffix}, last_premium_claim`,
  }));

  if (!user) {
    return response.error(404, 'User not found', CORS.STANDARD);
  }

  const status = user[`subscription_status${suffix}`];
  if (status !== 'active' && status !== 'trialing' && status !== 'test_active') {
    console.log(`[point-claim] Subscription check failed: user=${userId}, status=${status}`);
    return response.error(403, 'Premium subscription required', CORS.STANDARD);
  }

  // 2) 원자적 업데이트 — 이중 수령 방지
  try {
    const { Attributes } = await dynamodb.send(new UpdateCommand({
      TableName: USER_TABLE,
      Key: { user_id: userId },
      UpdateExpression: 'ADD balances.BOLT.available :pts SET last_premium_claim = :today, updated_at = :now',
      ConditionExpression: '(attribute_not_exists(last_premium_claim) OR last_premium_claim <> :today) AND attribute_exists(user_id)',
      ExpressionAttributeValues: {
        ':pts': points,
        ':today': today,
        ':now': new Date().toISOString(),
      },
      ReturnValues: 'ALL_NEW',
    }));

    const newBalance = Attributes?.balances?.BOLT || {};
    console.log(`[point-claim] Premium claim: user=${userId}, points=${points}, newAvailable=${newBalance.available}`);

    return response.ok({
      claimed: points,
      balance: {
        available: newBalance.available || 0,
        locked: newBalance.locked || 0,
        total: (newBalance.available || 0) + (newBalance.locked || 0),
      },
    }, CORS.STANDARD);
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return response.error(409, '오늘 이미 수령하셨습니다', CORS.STANDARD);
    }
    throw err;
  }
}

// ── POST /rewards/ad-complete ───────────────────────────
function adRewardOk(Attributes, points) {
  const newBalance = Attributes?.balances?.BOLT || {};
  return response.ok({
    claimed: points,
    remaining_today: Attributes?.ad_claims_today,
    balance: {
      available: newBalance.available || 0,
      locked: newBalance.locked || 0,
      total: (newBalance.available || 0) + (newBalance.locked || 0),
    },
  }, CORS.STANDARD);
}

async function claimAdReward(userId) {
  const rewards = await getRewardSettings();
  const points = rewards.adRewardPoints ?? 1000;
  const dailyLimit = rewards.adDailyLimit ?? 10;   // 일일 광고 보상 상한 (무한 발행 차단)
  const today = getTodayKST();
  const now = new Date().toISOString();

  // 경로 1: 오늘 첫 수령 — 카운터를 1로 리셋하며 지급
  try {
    const { Attributes } = await dynamodb.send(new UpdateCommand({
      TableName: USER_TABLE,
      Key: { user_id: userId },
      UpdateExpression: 'ADD balances.BOLT.available :pts SET ad_claims_today = :one, ad_claim_date = :today, updated_at = :now',
      ConditionExpression: 'attribute_exists(user_id) AND (attribute_not_exists(ad_claim_date) OR ad_claim_date <> :today)',
      ExpressionAttributeValues: { ':pts': points, ':one': 1, ':today': today, ':now': now },
      ReturnValues: 'ALL_NEW',
    }));
    console.log(`[point-claim] Ad reward (1st today): user=${userId}, points=${points}`);
    return adRewardOk(Attributes, points);
  } catch (err) {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
  }

  // 경로 2: 오늘 추가 수령 — 상한 미만일 때만 원자적으로 증가하며 지급
  try {
    const { Attributes } = await dynamodb.send(new UpdateCommand({
      TableName: USER_TABLE,
      Key: { user_id: userId },
      UpdateExpression: 'ADD balances.BOLT.available :pts, ad_claims_today :one SET updated_at = :now',
      ConditionExpression: 'attribute_exists(user_id) AND ad_claim_date = :today AND ad_claims_today < :limit',
      ExpressionAttributeValues: { ':pts': points, ':one': 1, ':today': today, ':limit': dailyLimit, ':now': now },
      ReturnValues: 'ALL_NEW',
    }));
    console.log(`[point-claim] Ad reward (count=${Attributes?.ad_claims_today}): user=${userId}, points=${points}`);
    return adRewardOk(Attributes, points);
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      // 상한 초과 (또는 유저 부재) — 무한 발행 차단
      return response.error(429, `일일 광고 보상 한도(${dailyLimit}회)를 초과했습니다`, CORS.STANDARD);
    }
    throw err;
  }
}

// ── GET /rewards/status ─────────────────────────────────
async function getRewardStatus(userId) {
  const testMode = await isTestMode();
  const suffix = testMode ? '_test' : '';

  const [rewards, userData] = await Promise.all([
    getRewardSettings(),
    dynamodb.send(new GetCommand({
      TableName: USER_TABLE,
      Key: { user_id: userId },
      ProjectionExpression: `subscription_status${suffix}, last_premium_claim, balances.BOLT.available`,
    })),
  ]);

  const user = userData.Item;
  if (!user) {
    return response.error(404, 'User not found', CORS.STANDARD);
  }

  const today = getTodayKST();
  const status = user[`subscription_status${suffix}`];
  const isSubscribed = status === 'active' || status === 'trialing' || status === 'test_active';

  return response.ok({
    is_subscribed: isSubscribed,
    premium_claimed_today: user.last_premium_claim === today,
    premium_reward: rewards.premiumDailyPoints ?? 5000,
    ad_reward: rewards.adRewardPoints ?? 1000,
    balance: user.balances?.BOLT?.available || 0,
  }, CORS.STANDARD);
}

// ── Handler ─────────────────────────────────────────────
export const handler = async (event) => {
  // CORS preflight
  const optionsResponse = handleOptions(event, CORS.STANDARD);
  if (optionsResponse) return optionsResponse;

  // Auth
  const auth = await verifyAuth(event);
  if (!auth.success) return authErrorResponse(auth, CORS.STANDARD);

  const userId = resolveUserId(auth);
  if (!userId) {
    return response.error(400, 'Unable to resolve user identity', CORS.STANDARD);
  }

  const method = event.httpMethod || event.requestContext?.http?.method;
  const path = event.path || event.rawPath || '';

  try {
    if (method === 'POST' && path.endsWith('/claim')) {
      return await claimPremiumReward(userId);
    }
    if (method === 'POST' && path.endsWith('/ad-complete')) {
      return await claimAdReward(userId);
    }
    if (method === 'GET' && path.endsWith('/status')) {
      return await getRewardStatus(userId);
    }
    return response.error(404, 'Not Found', CORS.STANDARD);
  } catch (error) {
    console.error('[point-claim] Error:', error);
    return response.error(500, error.message, CORS.STANDARD);
  }
};
