/**
 * Supernoba-user-init: 신규 사용자 초기화 Lambda - DynamoDB Version
 *
 * OAuth 로그인 성공 후 프론트엔드에서 호출
 * - supernoba-users 테이블에 프로필 + balances.BOLT 통합 생성
 * - 시스템 설정 반환 (maintenanceMode, tradingEnabled 등)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const SETTINGS_TABLE = process.env.SETTINGS_TABLE || 'supernoba-settings';
const USER_TABLE = process.env.USER_TABLE || process.env.USER_CACHE_TABLE || 'supernoba-users';
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
      const userResult = await dynamodb.send(new GetCommand({
        TableName: USER_TABLE,
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
      TableName: USER_TABLE,
      Key: { user_id: userId }
    }));

    if (existingUserResult.Item) {
      // 이미 존재하는 사용자 — balances.BOLT에서 직접 읽기
      const existingUser = existingUserResult.Item;
      const boltBalance = existingUser.balances?.BOLT || { available: 0, locked: 0 };

      return ok({
        is_new_user: false,
        initialized: true,
        balance: boltBalance.available,
        is_admin: existingUser.is_admin === true,
        is_tester: existingUser.is_tester === true,
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

    // 3. 프로필 + 잔고를 하나의 레코드로 생성 (통합)
    const now = new Date().toISOString();
    const welcomeBonus = settings.user?.welcomeBonus || 0;

    try {
      await dynamodb.send(new PutCommand({
        TableName: USER_TABLE,
        Item: {
          user_id: userId,
          email: email || null,
          username: displayName || email?.split('@')[0] || 'User',
          full_name: displayName || '',
          avatar_url: avatarUrl || null,
          provider: provider || 'unknown',
          is_admin: false,
          is_tester: false,
          balances: {
            BOLT: {
              available: welcomeBonus,
              locked: 0
            }
          },
          version: 1,
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
      console.error('Failed to create user:', insertError);
      return err(500, 'Failed to create user profile');
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
