/**
 * Supernoba-x-auth Lambda
 * X(Twitter) OAuth 2.0 + AWS Cognito 연동
 *
 * 엔드포인트:
 * - GET  /auth/x/init      - OAuth 시작 (X 로그인 URL 반환)
 * - GET  /auth/x/callback  - OAuth 콜백 처리 + Cognito JWT 발급
 * - POST /auth/x/refresh   - 토큰 갱신
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

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

export const handler = async (event) => {
  const path = event.path || event.rawPath || '';
  const method = event.httpMethod || event.requestContext?.http?.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    if (path.endsWith('/init') && method === 'GET') {
      return await handleInit(event);
    }
    if (path.endsWith('/callback') && method === 'GET') {
      return await handleCallback(event);
    }
    if (path.endsWith('/refresh') && method === 'POST') {
      return await handleRefresh(event);
    }

    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not Found' }) };
  } catch (error) {
    console.error('[x-auth] Error:', error);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: error.message }) };
  }
};

/**
 * GET /auth/x/init
 * X OAuth 시작 - 로그인 URL 반환
 */
async function handleInit(event) {
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
 * GET /auth/x/callback
 * X OAuth 콜백 처리 + Cognito JWT 발급
 */
async function handleCallback(event) {
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
    console.error('[x-auth] Callback error:', err);
    return redirectWithError(redirectUri, err.message);
  }
}

/**
 * X 토큰 교환
 */
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
    console.error('[x-auth] Token exchange failed:', error);
    throw new Error('X token exchange failed');
  }

  return response.json();
}

/**
 * X 사용자 정보 조회
 */
async function getXUserInfo(accessToken) {
  // 프로필 + 이메일 정보를 한 번에 조회
  const response = await fetch(
    'https://api.twitter.com/2/users/me?user.fields=profile_image_url,name,username,verified,created_at',
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[x-auth] User info fetch failed:', errorText);
    throw new Error('Failed to get X user info');
  }

  const result = await response.json();
  console.log('[x-auth] X user data:', JSON.stringify(result));

  return result.data;
}

/**
 * Cognito 사용자 생성/인증
 */
async function authenticateWithCognito(xUser) {
  console.log('[x-auth] xUser received:', JSON.stringify(xUser));

  // X API v2는 email 필드를 제공하지 않음 - X ID 기반으로 이메일 생성
  // X OAuth 2.0 PKCE는 email scope를 지원하지 않음
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
    // 신규 사용자 생성 (이메일을 username으로 사용)
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

  // 매번 비밀번호 재설정 (X 로그인 시마다 새 비밀번호 생성)
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

/**
 * 토큰과 함께 리다이렉트
 */
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

  // 모바일 네이티브 앱
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

/**
 * 에러와 함께 리다이렉트
 */
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

/**
 * POST /auth/x/refresh
 * 토큰 갱신
 */
async function handleRefresh(event) {
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
    console.error('[x-auth] Refresh error:', err);
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Token refresh failed' }),
    };
  }
}
