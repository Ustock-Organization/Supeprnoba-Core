/**
 * Supernoba-auth Lambda
 * 통합 인증 Lambda (X OAuth + User Init)
 *
 * 엔드포인트:
 * - GET  /auth/x/init      - X OAuth 시작
 * - GET  /auth/x/callback  - X OAuth 콜백 + Cognito JWT 발급
 * - POST /auth/x/refresh   - 토큰 갱신
 * - GET  /auth/init        - 사용자 초기화 상태 확인
 * - POST /auth/init        - 신규 사용자 초기화
 */

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminInitiateAuthCommand,
  AdminGetUserCommand,
  AdminUpdateUserAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import crypto from 'crypto';

const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' }));

// 환경변수
const X_CLIENT_ID = process.env.X_CLIENT_ID;
const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET;
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const CALLBACK_URL = process.env.CALLBACK_URL;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://supernoba.com';
const STATE_TABLE = process.env.STATE_TABLE || 'supernoba-oauth-state';
const SETTINGS_TABLE = process.env.SETTINGS_TABLE || 'supernoba-settings';
const USER_CACHE_TABLE = process.env.USER_CACHE_TABLE || 'supernoba-user-cache';
const WALLETS_TABLE = process.env.WALLETS_TABLE || 'supernoba-wallets';
const SETTINGS_KEY = 'SYSTEM_SETTINGS';

// 기본 설정값
const DEFAULT_SETTINGS = {
  user: { welcomeBonus: 0 },
  system: {
    maintenanceMode: false,
    tradingEnabled: true,
    newRegistrationEnabled: true,
  }
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

const ok = (data) => ({ statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(data) });
const err = (code, message) => ({ statusCode: code, headers: CORS_HEADERS, body: JSON.stringify({ error: message }) });

// 시스템 설정 조회
async function getSystemSettings() {
  try {
    const result = await ddb.send(new GetCommand({
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
  const path = event.path || event.rawPath || '';
  const method = event.httpMethod || event.requestContext?.http?.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    // ==========================================
    // X OAuth 엔드포인트
    // ==========================================

    // GET /auth/x/init - X OAuth 시작
    if (path.endsWith('/x/init') && method === 'GET') {
      return await handleXInit(event);
    }

    // GET /auth/x/callback - X OAuth 콜백
    if (path.endsWith('/x/callback') && method === 'GET') {
      return await handleXCallback(event);
    }

    // POST /auth/x/refresh - 토큰 갱신
    if (path.endsWith('/x/refresh') && method === 'POST') {
      return await handleXRefresh(event);
    }

    // ==========================================
    // User Init 엔드포인트
    // ==========================================

    // GET /auth/init - 사용자 초기화 상태 확인
    if (path.endsWith('/init') && method === 'GET') {
      return await handleInitCheck(event);
    }

    // POST /auth/init - 신규 사용자 초기화
    if (path.endsWith('/init') && method === 'POST') {
      return await handleUserInit(event);
    }

    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not Found' }) };
  } catch (error) {
    console.error('[auth] Error:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: error.message }) };
  }
};

// ==========================================
// X OAuth Handlers
// ==========================================

/**
 * GET /auth/x/init - X OAuth 시작
 */
async function handleXInit(event) {
  const { platform, redirectUri } = event.queryStringParameters || {};

  // PKCE 생성
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  // State 생성
  const state = crypto.randomBytes(16).toString('hex');
  const stateData = {
    state,
    codeVerifier,
    platform: platform || 'web',
    redirectUri: redirectUri || FRONTEND_URL,
    createdAt: Date.now(),
    ttl: Math.floor(Date.now() / 1000) + 300, // 5분 TTL
  };

  // DynamoDB에 state 저장
  await ddb.send(new PutCommand({
    TableName: STATE_TABLE,
    Item: stateData,
  }));

  // X OAuth 2.0 URL 생성
  const xAuthUrl = new URL('https://twitter.com/i/oauth2/authorize');
  xAuthUrl.searchParams.set('response_type', 'code');
  xAuthUrl.searchParams.set('client_id', X_CLIENT_ID);
  xAuthUrl.searchParams.set('redirect_uri', CALLBACK_URL);
  xAuthUrl.searchParams.set('scope', 'tweet.read users.read users.email offline.access');
  xAuthUrl.searchParams.set('state', state);
  xAuthUrl.searchParams.set('code_challenge', codeChallenge);
  xAuthUrl.searchParams.set('code_challenge_method', 'S256');

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ url: xAuthUrl.toString(), state }),
  };
}

/**
 * GET /auth/x/callback - X OAuth 콜백
 */
async function handleXCallback(event) {
  const { code, state, error, error_description } = event.queryStringParameters || {};

  if (error) {
    return redirectWithError(FRONTEND_URL, `X OAuth error: ${error_description || error}`);
  }

  // State 조회
  const stateResult = await ddb.send(new GetCommand({
    TableName: STATE_TABLE,
    Key: { state },
  }));

  const stateData = stateResult.Item;
  if (!stateData) {
    return redirectWithError(FRONTEND_URL, 'Invalid or expired state');
  }

  // State 삭제 (일회용)
  await ddb.send(new DeleteCommand({
    TableName: STATE_TABLE,
    Key: { state },
  }));

  const { codeVerifier, platform, redirectUri } = stateData;

  try {
    // 1. X에서 액세스 토큰 교환
    const xTokens = await exchangeXToken(code, codeVerifier);

    // 2. X 사용자 정보 조회
    const xUser = await getXUserInfo(xTokens.access_token);

    // 3. Cognito 사용자 생성/인증
    const cognitoTokens = await authenticateWithCognito(xUser);

    // 4. 프론트엔드로 리다이렉트
    return redirectWithTokens(redirectUri, platform, cognitoTokens, xUser);

  } catch (err) {
    console.error('[auth] Callback error:', err);
    return redirectWithError(redirectUri, err.message);
  }
}

/**
 * POST /auth/x/refresh - 토큰 갱신
 */
async function handleXRefresh(event) {
  const { refreshToken } = JSON.parse(event.body || '{}');

  if (!refreshToken) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'refreshToken required' }),
    };
  }

  try {
    const result = await cognito.send(new AdminInitiateAuthCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      ClientId: COGNITO_CLIENT_ID,
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: {
        REFRESH_TOKEN: refreshToken,
      },
    }));

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        accessToken: result.AuthenticationResult.AccessToken,
        idToken: result.AuthenticationResult.IdToken,
        expiresIn: result.AuthenticationResult.ExpiresIn,
      }),
    };
  } catch (err) {
    console.error('[auth] Refresh error:', err);
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Token refresh failed' }),
    };
  }
}

// X 토큰 교환
async function exchangeXToken(code, codeVerifier) {
  const basicAuth = Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString('base64');

  const response = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      redirect_uri: CALLBACK_URL,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('[auth] Token exchange failed:', error);
    throw new Error('X token exchange failed');
  }

  return response.json();
}

// X 사용자 정보 조회
async function getXUserInfo(accessToken) {
  const response = await fetch(
    'https://api.twitter.com/2/users/me?user.fields=profile_image_url,name,username,verified,created_at',
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[auth] User info fetch failed:', errorText);
    throw new Error('Failed to get X user info');
  }

  const result = await response.json();
  console.log('[auth] X user data:', JSON.stringify(result));

  return result.data;
}

// Cognito 사용자 생성/인증
async function authenticateWithCognito(xUser) {
  console.log('[auth] xUser received:', JSON.stringify(xUser));

  const email = xUser.email || `${xUser.id}@x.supernoba.com`;
  const tempPassword = crypto.randomBytes(16).toString('base64') + '!1aA';

  // 사용자 존재 여부 확인
  let userExists = false;
  try {
    await cognito.send(new AdminGetUserCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Username: email,
    }));
    userExists = true;
  } catch (e) {
    if (e.name !== 'UserNotFoundException') throw e;
  }

  if (!userExists) {
    // 신규 사용자 생성
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'custom:x_user_id', Value: xUser.id },
        { Name: 'custom:x_username', Value: xUser.username },
        { Name: 'custom:provider', Value: 'x' },
        { Name: 'name', Value: xUser.name || xUser.username },
        { Name: 'picture', Value: xUser.profile_image_url?.replace('_normal', '') || '' },
      ],
      MessageAction: 'SUPPRESS',
    }));
  } else {
    // 기존 사용자 - 프로필 업데이트
    await cognito.send(new AdminUpdateUserAttributesCommand({
      UserPoolId: COGNITO_USER_POOL_ID,
      Username: email,
      UserAttributes: [
        { Name: 'name', Value: xUser.name || xUser.username },
        { Name: 'picture', Value: xUser.profile_image_url?.replace('_normal', '') || '' },
      ],
    }));
  }

  // 비밀번호 재설정
  await cognito.send(new AdminSetUserPasswordCommand({
    UserPoolId: COGNITO_USER_POOL_ID,
    Username: email,
    Password: tempPassword,
    Permanent: true,
  }));

  // 인증하여 토큰 발급
  const authResult = await cognito.send(new AdminInitiateAuthCommand({
    UserPoolId: COGNITO_USER_POOL_ID,
    ClientId: COGNITO_CLIENT_ID,
    AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
    AuthParameters: {
      USERNAME: email,
      PASSWORD: tempPassword,
    },
  }));

  return {
    accessToken: authResult.AuthenticationResult.AccessToken,
    idToken: authResult.AuthenticationResult.IdToken,
    refreshToken: authResult.AuthenticationResult.RefreshToken,
    expiresIn: authResult.AuthenticationResult.ExpiresIn,
    email: email,
  };
}

// 토큰과 함께 리다이렉트
function redirectWithTokens(redirectUri, platform, tokens, xUser) {
  const params = new URLSearchParams({
    access_token: tokens.accessToken,
    id_token: tokens.idToken,
    refresh_token: tokens.refreshToken,
    expires_in: String(tokens.expiresIn),
    user_id: `x_${xUser.id}`,
    username: xUser.username,
    name: xUser.name || xUser.username,
    email: tokens.email || xUser.email || '',
    avatar_url: xUser.profile_image_url?.replace('_normal', '') || '',
  });

  let finalRedirect;
  if (platform === 'native') {
    finalRedirect = `com.supernoba.app://login-callback#${params.toString()}`;
  } else {
    finalRedirect = `${redirectUri}#${params.toString()}`;
  }

  return {
    statusCode: 302,
    headers: {
      'Location': finalRedirect,
      'Cache-Control': 'no-store',
    },
    body: '',
  };
}

// 에러와 함께 리다이렉트
function redirectWithError(redirectUri, errorMsg) {
  return {
    statusCode: 302,
    headers: {
      'Location': `${redirectUri}?error=${encodeURIComponent(errorMsg)}`,
      'Cache-Control': 'no-store',
    },
    body: '',
  };
}

// ==========================================
// User Init Handlers
// ==========================================

/**
 * GET /auth/init - 사용자 초기화 상태 확인
 */
async function handleInitCheck(event) {
  const { userId } = event.queryStringParameters || {};

  if (!userId) {
    return err(400, 'userId is required');
  }

  const settings = await getSystemSettings();

  // user_cache 존재 여부 확인
  const userResult = await ddb.send(new GetCommand({
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

/**
 * POST /auth/init - 신규 사용자 초기화
 */
async function handleUserInit(event) {
  const body = JSON.parse(event.body || '{}');
  const { userId, email, displayName, avatarUrl, provider } = body;

  if (!userId) {
    return err(400, 'userId is required');
  }

  const settings = await getSystemSettings();

  // 이미 초기화된 사용자인지 확인
  const existingUserResult = await ddb.send(new GetCommand({
    TableName: USER_CACHE_TABLE,
    Key: { user_id: userId }
  }));

  if (existingUserResult.Item) {
    // 이미 존재하는 사용자 - wallet 조회
    const walletResult = await ddb.send(new GetCommand({
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

  // 신규 가입 허용 여부 확인
  if (!settings.system?.newRegistrationEnabled) {
    return err(403, 'NEW_REGISTRATION_DISABLED');
  }

  // user_cache 생성
  const now = new Date().toISOString();
  try {
    await ddb.send(new PutCommand({
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

  // wallets 생성
  const welcomeBonus = settings.user?.welcomeBonus || 0;
  try {
    await ddb.send(new PutCommand({
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
  }

  console.log(`[auth] New user initialized: ${userId}, bonus: ${welcomeBonus}`);

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
}
