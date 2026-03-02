/**
 * Supernoba-auth Lambda
 * 통합 인증 Lambda (X OAuth + User Init)
 *
 * 엔드포인트:
 * - GET  /auth/x/init      - X OAuth 시작
 * - GET  /auth/x/callback  - X OAuth 콜백 + Cognito JWT 발급
 * - POST /auth/x/refresh   - 토큰 갱신
 * - GET  /auth/init            - 사용자 초기화 상태 확인
 * - POST /auth/init            - 신규 사용자 초기화
 * - POST /auth/profile-upload  - 프로필 이미지 presigned URL 발급
 * - POST /auth/sync-user       - 유저 정보 동기화
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
import { DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';

const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' }));
const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const MEDIA_BUCKET = process.env.MEDIA_BUCKET || 'supernoba-announcements-media';

// 환경변수
const X_CLIENT_ID = process.env.X_CLIENT_ID;
const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET;
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const CALLBACK_URL = process.env.CALLBACK_URL;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://supernoba.io';
const STATE_TABLE = process.env.STATE_TABLE || 'supernoba-oauth-state';
const SETTINGS_TABLE = process.env.SETTINGS_TABLE || 'supernoba-settings';
// 통합된 users 테이블 (user-cache + wallets 통합)
const USERS_TABLE = process.env.USERS_TABLE || 'supernoba-users';
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

    // POST /auth/profile-upload - 프로필 이미지 업로드용 presigned URL
    if (path.endsWith('/profile-upload') && method === 'POST') {
      return await handleProfileUpload(event);
    }

    // POST /auth/sync-user - 유저 정보 동기화 (멀티 소셜 로그인 지원)
    if (path.endsWith('/sync-user') && method === 'POST') {
      return await handleSyncUser(event);
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
    
    // 429 (Rate Limit) 에러 시 DynamoDB에서 최근 사용자 조회 시도
    if (response.status === 429) {
      console.log('[auth] Rate limited, trying to find cached user...');
      // 레이트 리밋 시 에러 메시지 개선
      throw new Error('X API 요청 한도 초과. 1-2분 후 다시 시도해주세요.');
    }
    
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
    verified: String(xUser.verified || false),
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

  // users 테이블에서 조회
  const userResult = await ddb.send(new GetCommand({
    TableName: USERS_TABLE,
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
  const { userId, email, displayName, avatarUrl, provider, verified } = body;

  if (!userId) {
    return err(400, 'userId is required');
  }

  const settings = await getSystemSettings();

  // 이미 초기화된 사용자인지 확인
  const existingUserResult = await ddb.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { user_id: userId }
  }));

  if (existingUserResult.Item) {
    // 이미 존재하는 사용자
    const user = existingUserResult.Item;
    const boltBalance = user.balances?.BOLT || { available: 0, locked: 0 };

    // X 인증 상태 업데이트 (변경 시에만)
    if (verified !== undefined && user.is_verified !== (verified === true)) {
      await ddb.send(new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { user_id: userId },
        UpdateExpression: 'SET is_verified = :v, updated_at = :now',
        ExpressionAttributeValues: {
          ':v': verified === true,
          ':now': new Date().toISOString(),
        },
      }));
    }

    // X/Google 사용자: 외부 프사 변경 감지 시 자동 갱신
    const isExternalProvider = (provider === 'x' || provider === 'google');
    if (isExternalProvider && avatarUrl && avatarUrl !== user.avatar_url) {
      // 단, S3에 직접 업로드한 프사가 있으면 보호 (덮어쓰기 방지)
      const existingIsS3 = user.avatar_url?.includes('supernoba');
      if (!existingIsS3) {
        await ddb.send(new UpdateCommand({
          TableName: USERS_TABLE,
          Key: { user_id: userId },
          UpdateExpression: 'SET avatar_url = :avatar, updated_at = :now',
          ExpressionAttributeValues: {
            ':avatar': avatarUrl,
            ':now': new Date().toISOString(),
          },
        }));
        // 갱신된 avatar_url을 응답에 반영
        user.avatar_url = avatarUrl;
      }
    }

    return ok({
      is_new_user: false,
      initialized: true,
      balance: boltBalance.available,
      is_admin: user.is_admin === true,
      is_tester: user.is_tester === true,
      is_verified: verified === true || user.is_verified === true,
      full_name: user.full_name || user.username || '',
      avatar_url: user.avatar_url || null,
      email: user.email || null,
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

  // 통합된 users 테이블에 생성
  const now = new Date().toISOString();
  const welcomeBonus = settings.user?.welcomeBonus || 0;
  
  try {
    await ddb.send(new PutCommand({
      TableName: USERS_TABLE,
      Item: {
        user_id: userId,
        email: email || null,
        username: displayName || '',
        full_name: displayName || '',
        avatar_url: avatarUrl || null,
        provider: provider || 'unknown',
        is_admin: false,
        is_tester: false,
        is_verified: verified === true,
        // Multi-currency balances
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

/**
 * POST /auth/profile-upload - 프로필 이미지 업로드용 presigned URL 발급
 *
 * 요청 바디:
 * - userId: 사용자 ID
 * - contentType: 이미지 MIME 타입 (image/jpeg, image/png, image/webp)
 *
 * 응답:
 * - uploadUrl: S3 presigned PUT URL (5분 유효)
 * - publicUrl: 업로드 후 공개 접근 가능한 URL
 */
async function handleProfileUpload(event) {
  const body = JSON.parse(event.body || '{}');
  const { userId, contentType = 'image/jpeg' } = body;

  if (!userId) return err(400, 'userId is required');

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(contentType)) {
    return err(400, 'INVALID_CONTENT_TYPE');
  }

  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  const key = `profiles/${userId}/avatar.${ext}`;

  const command = new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
  const publicUrl = `https://${MEDIA_BUCKET}.s3.ap-northeast-2.amazonaws.com/${key}`;

  return ok({ uploadUrl, publicUrl });
}

/**
 * POST /auth/sync-user - 유저 정보 동기화 (멀티 소셜 로그인 지원)
 * 
 * 요청 바디:
 * - userId: 프론트엔드에서 생성한 유저 ID (x_xxx 또는 google_xxx)
 * - email: 이메일
 * - displayName: 표시 이름 (소셜 플랫폼의 닉네임)
 * - avatarUrl: 프로필 이미지
 * - provider: 'x' | 'google'
 * - cognitoSub: Cognito sub (UUID)
 * - providerUserId: 소셜 플랫폼 고유 ID
 */
async function handleSyncUser(event) {
  const body = JSON.parse(event.body || '{}');
  const { userId, email, displayName, avatarUrl, provider, cognitoSub, providerUserId } = body;

  if (!userId || !provider) {
    return err(400, 'userId and provider are required');
  }

  const now = new Date().toISOString();
  const settings = await getSystemSettings();

  // 기존 유저 조회
  const existingUserResult = await ddb.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { user_id: userId }
  }));

  if (existingUserResult.Item) {
    // 기존 유저 - linked_accounts 업데이트
    const user = existingUserResult.Item;
    const linkedAccounts = user.linked_accounts || {};
    const cognitoSubs = user.cognito_subs || [];

    // provider별 계정 정보 업데이트
    linkedAccounts[provider] = {
      id: providerUserId || userId.replace(`${provider}_`, ''),
      email: email || null,
      username: provider === 'x' ? (body.username || '') : null,
      linked_at: linkedAccounts[provider]?.linked_at || now,
      updated_at: now,
    };

    // Cognito sub 추가 (중복 제거)
    if (cognitoSub && !cognitoSubs.includes(cognitoSub)) {
      cognitoSubs.push(cognitoSub);
    }

    // 이메일 결정: 가상 이메일이면 '-', 실제 이메일이면 사용
    let finalEmail = user.email;
    if (email && !email.endsWith('@x.supernoba.com')) {
      finalEmail = email;
    } else if (!finalEmail || finalEmail === '-') {
      finalEmail = email?.endsWith('@x.supernoba.com') ? '-' : (email || '-');
    }

    // displayName이 유효하면 항상 업데이트 (모지바케 자동 복구), 없으면 기존값 보존
    const hasValidName = displayName && displayName.trim();
    const nameExprs = hasValidName
      ? 'username = :username, full_name = :fullName'
      : 'username = if_not_exists(username, :username), full_name = if_not_exists(full_name, :fullName)';

    // S3 프사 보호 — 외부 OAuth URL로 덮어쓰지 않음
    const existingIsS3 = user.avatar_url?.includes('supernoba');
    const incomingIsExternal = avatarUrl && !avatarUrl.includes('supernoba') && !avatarUrl.startsWith('data:');
    const resolvedAvatar = (existingIsS3 && incomingIsExternal)
      ? user.avatar_url
      : (avatarUrl || user.avatar_url || null);

    await ddb.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { user_id: userId },
      UpdateExpression: `SET
        linked_accounts = :linkedAccounts,
        cognito_subs = :cognitoSubs,
        email = :email,
        ${nameExprs},
        avatar_url = :avatarUrl,
        primary_provider = if_not_exists(primary_provider, :provider),
        updated_at = :now`,
      ExpressionAttributeValues: {
        ':linkedAccounts': linkedAccounts,
        ':cognitoSubs': cognitoSubs,
        ':email': finalEmail,
        ':username': hasValidName ? displayName : '',
        ':fullName': hasValidName ? displayName : '',
        ':avatarUrl': resolvedAvatar,
        ':provider': provider,
        ':now': now,
      },
    }));

    console.log(`[auth] User synced: ${userId}, provider: ${provider}`);

    // 기존 DB에 저장된 이름 반환 (프론트엔드가 Redux에 반영)
    const storedName = hasValidName ? displayName : (user.full_name || user.username || '');

    return ok({
      synced: true,
      is_new_user: false,
      user_id: userId,
      full_name: storedName,
      avatar_url: resolvedAvatar,
    });
  }

  // 신규 유저 생성
  if (!settings.system?.newRegistrationEnabled) {
    return err(403, 'NEW_REGISTRATION_DISABLED');
  }

  const welcomeBonus = settings.user?.welcomeBonus || 0;
  
  // 이메일 결정
  const finalEmail = email?.endsWith('@x.supernoba.com') ? '-' : (email || '-');

  // linked_accounts 초기화
  const linkedAccounts = {
    [provider]: {
      id: providerUserId || userId.replace(`${provider}_`, ''),
      email: email || null,
      username: provider === 'x' ? (body.username || '') : null,
      linked_at: now,
    }
  };

  await ddb.send(new PutCommand({
    TableName: USERS_TABLE,
    Item: {
      user_id: userId,
      email: finalEmail,
      username: displayName || '',
      full_name: displayName || '',
      avatar_url: avatarUrl || null,
      provider: provider,
      primary_provider: provider,
      linked_accounts: linkedAccounts,
      cognito_subs: cognitoSub ? [cognitoSub] : [],
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

  console.log(`[auth] New user synced: ${userId}, provider: ${provider}, bonus: ${welcomeBonus}`);

  return ok({
    synced: true,
    is_new_user: true,
    user_id: userId,
    welcome_bonus: welcomeBonus,
  });
}
