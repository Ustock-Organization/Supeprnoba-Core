/**
 * Supernoba-user-init: 신규 사용자 초기화 Lambda - DynamoDB Version (Supabase Removed)
 *
 * OAuth 로그인 성공 후 프론트엔드에서 호출
 * - user_cache 생성 (DynamoDB)
 * - wallets 생성 (DynamoDB, welcomeBonus 적용)
 * - 시스템 설정 반환 (maintenanceMode, tradingEnabled 등)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const SETTINGS_TABLE = process.env.SETTINGS_TABLE || 'supernoba-settings';
const USER_CACHE_TABLE = process.env.USER_CACHE_TABLE || 'supernoba-user-cache';
const WALLETS_TABLE = process.env.WALLETS_TABLE || 'supernoba-wallets';
const SETTINGS_KEY = 'SYSTEM_SETTINGS';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

const ok = (data) => ({ statusCode: 200, headers, body: JSON.stringify(data) });
const err = (code, message) => ({ statusCode: code, headers, body: JSON.stringify({ error: message }) });

// 기본 설정값
const DEFAULT_SETTINGS = {
  user: { welcomeBonus: 0 },
  system: {
    maintenanceMode: false,
    tradingEnabled: true,
    newRegistrationEnabled: true,
  }
};

// 시스템 설정 조회
async function getSystemSettings() {
  try {
    const result = await dynamodb.send(new GetCommand({
      TableName: SETTINGS_TABLE,
      Key: { setting_id: SETTINGS_KEY }
    }));
    return result.Item?.settings || DEFAULT_SETTINGS;
  } catch (e) {
    console.error('Failed to get settings:', e);
    return DEFAULT_SETTINGS;
  }
}

export const handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { userId, email, displayName, avatarUrl, provider } = body;

    if (!userId) {
      return err(400, 'userId is required');
    }

    // 시스템 설정 조회
    const settings = await getSystemSettings();

    // GET 요청: 설정만 반환 (초기화 없이)
    if (event.httpMethod === 'GET') {
      // user_cache 존재 여부 확인
      const userResult = await dynamodb.send(new GetCommand({
        TableName: USER_CACHE_TABLE,
        Key: { user_id: userId }
      }));

      return ok({
        initialized: !!userResult.Item,
        settings: {
          maintenanceMode: settings.system?.maintenanceMode || false,
          tradingEnabled: settings.system?.tradingEnabled !== false,
          newRegistrationEnabled: settings.system?.newRegistrationEnabled !== false,
        }
      });
    }

    // POST 요청: 초기화 수행
    // 1. 이미 초기화된 사용자인지 확인
    const existingUserResult = await dynamodb.send(new GetCommand({
      TableName: USER_CACHE_TABLE,
      Key: { user_id: userId }
    }));

    if (existingUserResult.Item) {
      // 이미 존재하는 사용자 - wallet 조회
      const walletResult = await dynamodb.send(new GetCommand({
        TableName: WALLETS_TABLE,
        Key: { user_id: userId, currency: 'BOLT' }
      }));

      const userCache = existingUserResult.Item;

      return ok({
        is_new_user: false,
        initialized: true,
        balance: walletResult.Item?.available || 0,
        is_admin: userCache.is_admin === true,
        is_tester: userCache.is_tester === true,
        settings: {
          maintenanceMode: settings.system?.maintenanceMode || false,
          tradingEnabled: settings.system?.tradingEnabled !== false,
          newRegistrationEnabled: settings.system?.newRegistrationEnabled !== false,
        }
      });
    }

    // 2. 신규 가입 허용 여부 확인
    if (!settings.system?.newRegistrationEnabled) {
      return err(403, 'NEW_REGISTRATION_DISABLED');
    }

    // 3. user_cache 생성 (DynamoDB)
    const now = new Date().toISOString();
    try {
      await dynamodb.send(new PutCommand({
        TableName: USER_CACHE_TABLE,
        Item: {
          user_id: userId,
          email: email || null,
          username: displayName || email?.split('@')[0] || 'User',
          full_name: displayName || '',
          avatar_url: avatarUrl || null,
          provider: provider || 'unknown',
          is_admin: false,
          is_tester: false,
          created_at: now,
          updated_at: now
        },
        ConditionExpression: 'attribute_not_exists(user_id)'
      }));
    } catch (insertError) {
      // 이미 존재하는 경우 (race condition)
      if (insertError.name === 'ConditionalCheckFailedException') {
        return ok({
          is_new_user: false,
          initialized: true,
          message: 'User already exists'
        });
      }
      console.error('Failed to create user_cache:', insertError);
      return err(500, 'Failed to create user profile');
    }

    // 4. wallets 생성 (welcomeBonus 적용)
    const welcomeBonus = settings.user?.welcomeBonus || 0;
    try {
      await dynamodb.send(new PutCommand({
        TableName: WALLETS_TABLE,
        Item: {
          user_id: userId,
          currency: 'BOLT',
          available: welcomeBonus,
          locked: 0,
          version: 1,
          created_at: now,
          updated_at: now
        },
        ConditionExpression: 'attribute_not_exists(user_id)'
      }));
    } catch (walletError) {
      if (walletError.name !== 'ConditionalCheckFailedException') {
        console.error('Failed to create wallet:', walletError);
      }
      // 프로필은 생성됐으니 계속 진행
    }

    console.log(`[user-init] New user initialized: ${userId}, bonus: ${welcomeBonus}`);

    return ok({
      is_new_user: true,
      initialized: true,
      welcome_bonus: welcomeBonus,
      balance: welcomeBonus,
      settings: {
        maintenanceMode: settings.system?.maintenanceMode || false,
        tradingEnabled: settings.system?.tradingEnabled !== false,
        newRegistrationEnabled: settings.system?.newRegistrationEnabled !== false,
      }
    });

  } catch (e) {
    console.error('Error:', e);
    return err(500, e.message);
  }
};
