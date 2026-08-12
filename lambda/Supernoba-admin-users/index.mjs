// Supernoba-admin-users: 사용자 관리 Lambda
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ScanCommand, QueryCommand, PutCommand, DeleteCommand, GetCommand, UpdateCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Common Layer - Valkey, CORS
import { getValkeyClient, CORS, response } from '/opt/nodejs/index.mjs';

// Auth Layer - Cognito JWT 검증
import { verifyAdmin, authErrorResponse } from '/opt/nodejs/verifyAuth.mjs';

// Cognito 사용자 비활성화/활성화
import { CognitoIdentityProviderClient, AdminDisableUserCommand, AdminEnableUserCommand } from '@aws-sdk/client-cognito-identity-provider';
// 미체결 주문 취소 (Kinesis)
import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
// WebSocket 강제 종료
import { ApiGatewayManagementApiClient, DeleteConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
// Step Functions (사용자 삭제)
import { SFNClient, StartExecutionCommand, StopExecutionCommand, DescribeExecutionCommand } from '@aws-sdk/client-sfn';

// 설정 테이블 (DynamoDB)
const SETTINGS_TABLE = 'supernoba-settings';
const SETTINGS_KEY = 'SYSTEM_SETTINGS';

// 기본 설정값 (단순화됨)
const DEFAULT_SETTINGS = {
  user: {
    welcomeBonus: 0,
  },
  system: {
    maintenanceMode: false,
    tradingEnabled: true,
    newRegistrationEnabled: true,
  },
  rewards: { premiumDailyPoints: 5000, adRewardPoints: 1000 },
};

// 설정 캐시
let cachedSettings = null;

const USERS_TABLE = process.env.USERS_TABLE || 'supernoba-users';
const AUDIT_LOGS_TABLE = process.env.AUDIT_LOGS_TABLE || 'supernoba-audit-logs';
// 관리자 잔고 설정 상한. 없으면 단일 관리자가 임의 금액을 창출할 수 있다.
const MAX_ADMIN_BALANCE = Number(process.env.MAX_ADMIN_BALANCE || 100000000);

/**
 * 관리자 특권 행위 감사 기록.
 * 기존 코드는 전부 `catch { console.log('...(ignored)') }`로 실패를 삼켰다 —
 * 잔고 변경·권한 부여가 무기록으로 성공하면 내부자 위협에 사후 포렌식이 불가능하다.
 * 실패를 호출자에게 알려(auditLogged: false) 최소한 드러나게 한다.
 * @returns {Promise<boolean>} 기록 성공 여부
 */
async function writeAudit({ action, actor_user_id, target_user_id, details }) {
  try {
    await dynamodb.send(new PutCommand({
      TableName: AUDIT_LOGS_TABLE,
      Item: {
        log_id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
        action,
        actor_user_id,          // 누가 했는지 — 없으면 추적 자체가 불가능하다
        target_user_id,
        details,
        created_at: new Date().toISOString(),
      }
    }));
    return true;
  } catch (e) {
    // 테이블 미생성 등 설정 문제도 여기서 드러난다.
    console.error(`[AUDIT FAILED] action=${action} actor=${actor_user_id} ` +
                  `target=${target_user_id}: ${e.message}`);
    return false;
  }
}

// Layer를 통한 클라이언트 초기화
const valkey = getValkeyClient({ type: 'operating', preset: 'admin' });
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));
const cognito = new CognitoIdentityProviderClient({ region: 'ap-northeast-2' });
const kinesis = new KinesisClient({ region: 'ap-northeast-2' });
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || 'ap-northeast-2_dhsiCqgku';
const KINESIS_ORDERS_STREAM = process.env.KINESIS_ORDERS_STREAM || 'supernoba-orders';
const WS_ENDPOINT = process.env.WEBSOCKET_ENDPOINT || '';
const sfn = new SFNClient({ region: 'ap-northeast-2' });
const DELETE_USER_STATE_MACHINE_ARN = process.env.DELETE_USER_STATE_MACHINE_ARN || 'arn:aws:states:ap-northeast-2:264520158196:stateMachine:supernoba-user-deletion';
const DELETE_JOBS_TABLE = process.env.DELETE_JOBS_TABLE || 'supernoba-delete-user-jobs';

// Layer의 CORS.FULL 사용
const H = CORS.FULL;
const ok = (d) => response.ok(d, H);
const err = (c, m) => response.error(c, m, H);

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  
  // Cognito 인증 확인
  const authResult = await verifyAdmin(event);
  if (!authResult.success) return authErrorResponse(authResult, H);

  try {
    const m = event.httpMethod;
    const q = event.queryStringParameters || {};
    const path = event.path || '';

    // GET: 사용자 목록 또는 개별 사용자 조회
    if (m === 'GET') {
      const { userId, page = 1, limit = 50, search, status: userStatus } = q;

      // 개별 사용자 상세 조회
      if (userId) {
        // DynamoDB supernoba-users에서 사용자 프로필 조회
        let profile = null;
        try {
          const { Item } = await dynamodb.send(new GetCommand({
            TableName: USERS_TABLE,
            Key: { user_id: userId }
          }));
          profile = Item || null;
        } catch (profileErr) {
          console.error('[GET USER] Profile fetch error:', profileErr.message);
        }

        // balances.BOLT에서 직접 읽기 (통합)
        const boltBalance = profile?.balances?.BOLT || { available: 0, locked: 0 };
        const effectiveWallets = [{
          user_id: userId,
          currency: 'BOLT',
          available: boltBalance.available,
          locked: boltBalance.locked
        }];

        // DynamoDB에서 주문 이력
        const ordersResult = await dynamodb.send(new QueryCommand({
          TableName: 'supernoba-orders',
          KeyConditionExpression: 'user_id = :uid',
          ExpressionAttributeValues: { ':uid': userId },
          Limit: 100,
          ScanIndexForward: false
        }));

        // DynamoDB에서 보유 자산
        const holdingsResult = await dynamodb.send(new QueryCommand({
          TableName: 'supernoba-holdings',
          KeyConditionExpression: 'user_id = :uid',
          ExpressionAttributeValues: { ':uid': userId }
        }));

        // 주문 상태별 집계
        const orderStats = { PENDING: 0, ACCEPTED: 0, PARTIALLY_FILLED: 0, FILLED: 0, CANCELLED: 0, REJECTED: 0 };
        (ordersResult.Items || []).forEach(item => {
          const status = item.status || 'PENDING';
          orderStats[status] = (orderStats[status] || 0) + 1;
        });

        // 총 거래 금액 계산 (FILLED 주문)
        const totalTradeVolume = (ordersResult.Items || [])
          .filter(o => o.status === 'FILLED')
          .reduce((sum, o) => sum + ((o.filled_qty || o.quantity || 0) * (o.price || 0)), 0);

        // holdings 필드명 정규화 (avgPrice → avg_price)
        const normalizedHoldings = (holdingsResult.Items || []).map(h => ({
          ...h,
          avg_price: h.avg_price ?? h.avgPrice ?? 0
        }));

        return ok({
          user: {
            id: userId,
            ...profile,
            wallets: effectiveWallets,
            orders: ordersResult.Items || [],
            holdings: normalizedHoldings,
            stats: {
              orderCount: ordersResult.Items?.length || 0,
              holdingsCount: normalizedHoldings.length,
              ordersByStatus: orderStats,
              totalTradeVolume
            }
          }
        });
      }

      // 사용자 목록 조회 (DynamoDB supernoba-users에서)
      try {
        // DynamoDB Scan으로 전체 사용자 조회 (필터링은 메모리에서 수행)
        const { Items: allUsers } = await dynamodb.send(new ScanCommand({
          TableName: USERS_TABLE
        }));

        let users = allUsers || [];

        // 검색 필터 적용
        if (search) {
          const searchLower = search.toLowerCase();
          users = users.filter(u =>
            (u.email && u.email.toLowerCase().includes(searchLower)) ||
            (u.display_name && u.display_name.toLowerCase().includes(searchLower))
          );
        }

        // 상태 필터 적용
        if (userStatus === 'suspended') {
          users = users.filter(u => u.is_suspended === true);
        } else if (userStatus === 'active') {
          users = users.filter(u => !u.is_suspended);
        }

        // created_at 기준 내림차순 정렬
        users.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

        const total = users.length;

        // 페이지네이션 적용
        const offset = (parseInt(page) - 1) * parseInt(limit);
        const paginatedUsers = users.slice(offset, offset + parseInt(limit));

        // 각 사용자의 잔고 정보 추가 (balances.BOLT에서 직접 읽기)
        const enrichedUsers = paginatedUsers.map((user) => {
          const boltWallet = user.balances?.BOLT;
          return {
            ...user,
            id: user.user_id, // 호환성 유지
            bolt_balance: boltWallet?.available ?? 0,
            bolt_locked: boltWallet?.locked ?? 0,
            wallet_exists: !!boltWallet
          };
        });

        return ok({
          users: enrichedUsers,
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(total / parseInt(limit))
        });
      } catch (e) {
        console.error('[GET USERS] Error:', e.message);
        return err(500, 'Failed to fetch users: ' + e.message);
      }
    }

    // POST: 사용자 액션 (정지, 해제, 잔고 조정, 자산 관리)
    if (m === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const { action, userId, reason } = b;

      // 시스템 설정 조회
      if (action === 'getSettings') {
        try {
          const result = await dynamodb.send(new GetCommand({
            TableName: SETTINGS_TABLE,
            Key: { setting_id: SETTINGS_KEY }
          }));

          if (result.Item) {
            cachedSettings = result.Item.settings;
            return ok({ settings: result.Item.settings });
          } else {
            // 설정이 없으면 기본값 반환
            return ok({ settings: DEFAULT_SETTINGS });
          }
        } catch (e) {
          console.error('getSettings error:', e);
          // 테이블이 없거나 오류 시 기본값 반환
          return ok({ settings: DEFAULT_SETTINGS });
        }
      }

      // 시스템 설정 저장
      if (action === 'saveSettings') {
        const { settings } = b;
        if (!settings) return err(400, 'settings is required');

        try {
          // 설정 저장
          await dynamodb.send(new PutCommand({
            TableName: SETTINGS_TABLE,
            Item: {
              setting_id: SETTINGS_KEY,
              settings: settings,
              updated_at: new Date().toISOString()
            }
          }));

          // 캐시 업데이트
          cachedSettings = settings;

          // Valkey에도 저장 (다른 Lambda에서 사용)
          try {
            await valkey.set('system:settings', JSON.stringify(settings));
          } catch (e) {
            console.log('Valkey save error (ignored):', e.message);
          }

          // 감사 로그 (DynamoDB) - 오류 무시
          try {
            await dynamodb.send(new PutCommand({
              TableName: AUDIT_LOGS_TABLE,
              Item: {
                log_id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                action: 'update_settings',
                details: { settings },
                created_at: new Date().toISOString()
              }
            }));
          } catch (e) {
            console.log('Audit log error (ignored):', e.message);
          }

          return ok({ success: true, message: 'Settings saved' });
        } catch (e) {
          console.error('saveSettings error:', e);
          return err(500, 'Failed to save settings: ' + e.message);
        }
      }

      // getAllHoldings는 userId 불필요
      if (action === 'getAllHoldings') {
        const { symbol, page = 1, limit = 50 } = b;

        let scanParams = {
          TableName: 'supernoba-holdings',
          Limit: 1000
        };

        if (symbol) {
          scanParams.FilterExpression = 'symbol = :sym';
          scanParams.ExpressionAttributeValues = { ':sym': symbol };
        }

        const result = await dynamodb.send(new ScanCommand(scanParams));
        const holdings = result.Items || [];

        // 사용자 정보 추가 (DynamoDB supernoba-users에서)
        const userIds = [...new Set(holdings.map(h => h.user_id))];
        const userMap = {};

        // 사용자 정보를 병렬로 조회 (최대 100명)
        const userPromises = userIds.slice(0, 100).map(async (uid) => {
          try {
            const { Item } = await dynamodb.send(new GetCommand({
              TableName: USERS_TABLE,
              Key: { user_id: uid }
            }));
            if (Item) {
              userMap[uid] = { email: Item.email, display_name: Item.display_name };
            }
          } catch (e) {
            // 개별 조회 실패 무시
          }
        });
        await Promise.all(userPromises);

        const enrichedHoldings = holdings.map(h => ({
          ...h,
          user_email: userMap[h.user_id]?.email || 'Unknown',
          user_name: userMap[h.user_id]?.display_name || ''
        }));

        // 페이지네이션
        const startIdx = (parseInt(page) - 1) * parseInt(limit);
        const paginatedHoldings = enrichedHoldings.slice(startIdx, startIdx + parseInt(limit));

        return ok({
          holdings: paginatedHoldings,
          total: enrichedHoldings.length,
          page: parseInt(page),
          limit: parseInt(limit)
        });
      }

      // deleteUserStatus / abortDeleteUser는 userId 불필요 (jobId만 필요)
      if (action === 'deleteUserStatus') {
        const { jobId } = b;
        if (!jobId) return err(400, 'jobId is required');
        try {
          const { Item: job } = await dynamodb.send(new GetCommand({
            TableName: DELETE_JOBS_TABLE,
            Key: { job_id: jobId }
          }));
          if (!job) return err(404, 'Job not found');
          return ok(job);
        } catch (e) {
          return err(500, 'Failed to fetch job status: ' + e.message);
        }
      }

      if (action === 'abortDeleteUser') {
        const { jobId } = b;
        if (!jobId) return err(400, 'jobId is required');
        try {
          const { Item: job } = await dynamodb.send(new GetCommand({
            TableName: DELETE_JOBS_TABLE,
            Key: { job_id: jobId }
          }));
          if (!job) return err(404, 'Job not found');
          const completedPhases = job.phases_completed || [];
          if (completedPhases.includes('CANCEL_ORDERS')) {
            return err(400, 'Cannot abort: deletion has passed Phase 2 (irreversible)');
          }
          if (job.execution_arn) {
            await sfn.send(new StopExecutionCommand({
              executionArn: job.execution_arn,
              cause: 'Admin abort'
            }));
          }
          await dynamodb.send(new UpdateCommand({
            TableName: DELETE_JOBS_TABLE,
            Key: { job_id: jobId },
            UpdateExpression: 'SET #status = :status, aborted_at = :now, aborted_by = :by, updated_at = :now',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':status': 'ABORTED',
              ':now': new Date().toISOString(),
              ':by': authResult.userId
            }
          }));
          // is_deleting 해제 (사용자 복구)
          const targetUserId = job.user_id;
          if (targetUserId) {
            await dynamodb.send(new UpdateCommand({
              TableName: USERS_TABLE,
              Key: { user_id: targetUserId },
              UpdateExpression: 'REMOVE is_deleting SET updated_at = :now',
              ExpressionAttributeValues: { ':now': new Date().toISOString() }
            }));
            try {
              await valkey.del(`user:${targetUserId}:deleting`);
            } catch (e) {
              console.log('Valkey cleanup (ignored):', e.message);
            }
          }
          return ok({ success: true, message: 'Deletion aborted' });
        } catch (e) {
          return err(500, 'Abort failed: ' + e.message);
        }
      }

      // 나머지 액션은 userId 필요
      if (!userId) return err(400, 'userId is required');

      // 사용자 정지
      if (action === 'suspend') {
        try {
          await dynamodb.send(new UpdateCommand({
            TableName: USERS_TABLE,
            Key: { user_id: userId },
            UpdateExpression: 'SET is_suspended = :suspended, suspended_at = :suspended_at, suspended_reason = :reason',
            ExpressionAttributeValues: {
              ':suspended': true,
              ':suspended_at': new Date().toISOString(),
              ':reason': reason || 'Suspended by admin'
            }
          }));
        } catch (e) {
          return err(500, 'Failed to suspend user: ' + e.message);
        }

        // Redis에 정지 상태 저장
        try {
          await valkey.set(`user:${userId}:suspended`, 'true');
        } catch (e) {
          console.log('Valkey error (ignored):', e.message);
        }

        // 감사 로그 (DynamoDB) - 오류 무시
        try {
          await dynamodb.send(new PutCommand({
            TableName: AUDIT_LOGS_TABLE,
            Item: {
              log_id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              action: 'suspend_user',
              target_user_id: userId,
              details: { reason },
              created_at: new Date().toISOString()
            }
          }));
        } catch (e) {
          console.log('Audit log error (ignored):', e.message);
        }

        // Cognito 사용자 비활성화 (모든 cognito_subs에 대해)
        try {
          const { Item: userInfo } = await dynamodb.send(new GetCommand({
            TableName: USERS_TABLE,
            Key: { user_id: userId }
          }));
          const cognitoSubs = userInfo?.cognito_subs || [];
          for (const sub of cognitoSubs) {
            try {
              await cognito.send(new AdminDisableUserCommand({
                UserPoolId: COGNITO_USER_POOL_ID,
                Username: sub
              }));
              console.log(`[suspend] Cognito disabled: ${sub}`);
            } catch (cognitoErr) {
              console.warn(`[suspend] Cognito disable failed for ${sub}: ${cognitoErr.message}`);
            }
          }
        } catch (e) {
          console.warn('[suspend] Cognito disable lookup failed:', e.message);
        }

        // 미체결 주문 일괄 취소 (Kinesis CANCEL 발행)
        try {
          const ordersResult = await dynamodb.send(new QueryCommand({
            TableName: 'supernoba-orders',
            KeyConditionExpression: 'user_id = :uid',
            ExpressionAttributeValues: { ':uid': userId }
          }));
          const openOrders = (ordersResult.Items || []).filter(
            o => ['ACCEPTED', 'PARTIALLY_FILLED', 'PARTIAL_FILL', 'PENDING'].includes(o.status)
          );
          for (const order of openOrders) {
            try {
              await kinesis.send(new PutRecordCommand({
                StreamName: KINESIS_ORDERS_STREAM,
                Data: Buffer.from(JSON.stringify({
                  action: 'CANCEL',
                  order_id: order.order_id,
                  user_id: userId,
                  symbol: order.symbol,
                  timestamp: Date.now()
                })),
                PartitionKey: order.symbol
              }));
              console.log(`[suspend] Cancelled order: ${order.order_id}`);
            } catch (cancelErr) {
              console.warn(`[suspend] Cancel failed for ${order.order_id}: ${cancelErr.message}`);
            }
          }
          if (openOrders.length > 0) {
            console.log(`[suspend] Cancelled ${openOrders.length} open orders for ${userId}`);
          }
        } catch (e) {
          console.warn('[suspend] Order cancellation failed:', e.message);
        }

        // WebSocket 연결 강제 종료
        if (WS_ENDPOINT) {
          try {
            const connections = await valkey.smembers(`user:${userId}:connections`);
            if (connections && connections.length > 0) {
              const wsClient = new ApiGatewayManagementApiClient({
                region: 'ap-northeast-2',
                endpoint: WS_ENDPOINT
              });
              for (const connId of connections) {
                try {
                  await wsClient.send(new DeleteConnectionCommand({ ConnectionId: connId }));
                  console.log(`[suspend] Disconnected WS: ${connId}`);
                } catch (wsErr) {
                  if (wsErr.statusCode === 410) {
                    // Already disconnected, clean up
                    await valkey.srem(`user:${userId}:connections`, connId).catch(() => {});
                  } else {
                    console.warn(`[suspend] WS disconnect failed for ${connId}: ${wsErr.message}`);
                  }
                }
              }
            }
          } catch (e) {
            console.warn('[suspend] WS disconnect failed:', e.message);
          }
        }

        return ok({ success: true, message: `User ${userId} suspended` });
      }

      // 사용자 정지 해제
      if (action === 'unsuspend') {
        try {
          await dynamodb.send(new UpdateCommand({
            TableName: USERS_TABLE,
            Key: { user_id: userId },
            UpdateExpression: 'SET is_suspended = :suspended REMOVE suspended_at, suspended_reason',
            ExpressionAttributeValues: {
              ':suspended': false
            }
          }));
        } catch (e) {
          return err(500, 'Failed to unsuspend user: ' + e.message);
        }

        // Cognito 사용자 재활성화
        try {
          const { Item: userInfo } = await dynamodb.send(new GetCommand({
            TableName: USERS_TABLE,
            Key: { user_id: userId }
          }));
          const cognitoSubs = userInfo?.cognito_subs || [];
          for (const sub of cognitoSubs) {
            try {
              await cognito.send(new AdminEnableUserCommand({
                UserPoolId: COGNITO_USER_POOL_ID,
                Username: sub
              }));
              console.log(`[unsuspend] Cognito enabled: ${sub}`);
            } catch (cognitoErr) {
              console.warn(`[unsuspend] Cognito enable failed for ${sub}: ${cognitoErr.message}`);
            }
          }
        } catch (e) {
          console.warn('[unsuspend] Cognito enable lookup failed:', e.message);
        }

        try {
          await valkey.del(`user:${userId}:suspended`);
        } catch (e) {
          console.log('Valkey error (ignored):', e.message);
        }

        return ok({ success: true, message: `User ${userId} unsuspended` });
      }

      // 관리자 권한 설정
      if (action === 'setAdmin') {
        const { isAdmin } = b;
        if (typeof isAdmin !== 'boolean') return err(400, 'isAdmin must be a boolean');
        // 자기 자신의 권한은 이 경로로 바꿀 수 없다(실수로 마지막 관리자가
        // 스스로를 강등해 잠기는 것과, 권한 세탁을 함께 막는다).
        if (userId === authResult?.userId) {
          return err(400, '자신의 관리자 권한은 변경할 수 없습니다');
        }

        try {
          await dynamodb.send(new UpdateCommand({
            TableName: USERS_TABLE,
            Key: { user_id: userId },
            UpdateExpression: 'SET is_admin = :isAdmin, updated_at = :updatedAt',
            ConditionExpression: 'attribute_exists(user_id)',
            ExpressionAttributeValues: {
              ':isAdmin': isAdmin,
              ':updatedAt': new Date().toISOString()
            }
          }));
        } catch (e) {
          if (e.name === 'ConditionalCheckFailedException') return err(404, 'User not found');
          return err(500, 'Failed to update admin status: ' + e.message);
        }

        // 권한 부여는 가장 위험한 특권 행위다 — 무기록으로 통과시키지 않는다.
        const auditOk = await writeAudit({
          action: 'set_admin',
          actor_user_id: authResult?.userId || null,
          target_user_id: userId,
          details: { isAdmin },
        });

        return ok({ success: true, auditLogged: auditOk,
                    message: `User ${userId} admin status set to ${isAdmin}` });
      }

      // 테스터 권한 설정
      if (action === 'setTester') {
        const { isTester } = b;
        if (typeof isTester !== 'boolean') return err(400, 'isTester must be a boolean');

        try {
          await dynamodb.send(new UpdateCommand({
            TableName: USERS_TABLE,
            Key: { user_id: userId },
            UpdateExpression: 'SET is_tester = :isTester, updated_at = :updatedAt',
            ExpressionAttributeValues: {
              ':isTester': isTester,
              ':updatedAt': new Date().toISOString()
            }
          }));
        } catch (e) {
          return err(500, 'Failed to update tester status: ' + e.message);
        }

        try {
          await dynamodb.send(new PutCommand({
            TableName: AUDIT_LOGS_TABLE,
            Item: {
              log_id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              action: 'set_tester',
              target_user_id: userId,
              details: { isTester },
              created_at: new Date().toISOString()
            }
          }));
        } catch (e) {
          console.log('Audit log error (ignored):', e.message);
        }

        return ok({ success: true, message: `User ${userId} tester status set to ${isTester}` });
      }

      // 구독 상태 설정
      if (action === 'setSubscription') {
        const { isSubscribed } = b;
        if (typeof isSubscribed !== 'boolean') return err(400, 'isSubscribed must be a boolean');

        const updateExpr = isSubscribed
          ? 'SET subscription_status = :status, subscription_source = :source, updated_at = :updatedAt'
          : 'SET subscription_status = :status, updated_at = :updatedAt REMOVE subscription_source, subscription_plan, subscription_expires_at, subscription_id';

        const exprValues = {
          ':status': isSubscribed ? 'active' : 'none',
          ':updatedAt': new Date().toISOString(),
          ...(isSubscribed ? { ':source': 'admin' } : {}),
        };

        try {
          await dynamodb.send(new UpdateCommand({
            TableName: USERS_TABLE,
            Key: { user_id: userId },
            UpdateExpression: updateExpr,
            ExpressionAttributeValues: exprValues,
          }));
        } catch (e) {
          return err(500, 'Failed to update subscription: ' + e.message);
        }

        try {
          await dynamodb.send(new PutCommand({
            TableName: AUDIT_LOGS_TABLE,
            Item: {
              log_id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              action: 'set_subscription',
              target_user_id: userId,
              details: { isSubscribed },
              created_at: new Date().toISOString()
            }
          }));
        } catch (e) {
          console.log('Audit log error (ignored):', e.message);
        }

        return ok({ success: true, message: `User ${userId} subscription set to ${isSubscribed ? 'active' : 'none'}` });
      }

      // 잔고 설정 (값 직접 변경)
      if (action === 'setBalance') {
        const { currency = 'BOLT', newBalance, adjustReason } = b;
        if (typeof newBalance !== 'number' || !Number.isFinite(newBalance) || newBalance < 0) {
          return err(400, 'newBalance must be a non-negative number');
        }
        // 상한 — 단일 관리자가 무제한으로 자금을 만들 수 없게 한다.
        if (newBalance > MAX_ADMIN_BALANCE) {
          return err(400, `newBalance exceeds limit (${MAX_ADMIN_BALANCE})`);
        }
        // 사유 필수 — 감사 추적의 최소 조건
        if (!adjustReason || String(adjustReason).trim().length < 3) {
          return err(400, 'adjustReason is required (min 3 chars)');
        }

        // 현재 잔고·버전 조회. 실패를 무시하면 잘못된 previousBalance가 감사에 남는다.
        let currentBalance = 0;
        let currentVersion;
        try {
          const { Item: user } = await dynamodb.send(new GetCommand({
            TableName: USERS_TABLE,
            Key: { user_id: userId },
            ProjectionExpression: 'balances, version'
          }));
          if (!user) return err(404, 'User not found');
          currentBalance = user?.balances?.BOLT?.available || 0;
          currentVersion = user.version;
        } catch (e) {
          return err(500, 'Balance fetch failed: ' + e.message);
        }

        // 낙관적 잠금 — 동시 거래 중 실행되면 체결 결과를 소실시키고 locked와
        // 불일치한 회계 상태를 만든다. version이 바뀌었으면 거부하고 재시도하게 한다.
        try {
          await dynamodb.send(new UpdateCommand({
            TableName: USERS_TABLE,
            Key: { user_id: userId },
            UpdateExpression: 'SET balances.BOLT.available = :bal, updated_at = :now, version = if_not_exists(version, :zero) + :one',
            ConditionExpression: currentVersion === undefined
              ? 'attribute_exists(user_id)'
              : 'version = :ver',
            ExpressionAttributeValues: {
              ':bal': newBalance,
              ':now': new Date().toISOString(),
              ':one': 1,
              ':zero': 0,
              ...(currentVersion === undefined ? {} : { ':ver': currentVersion }),
            }
          }));
        } catch (updateErr) {
          if (updateErr.name === 'ConditionalCheckFailedException') {
            return err(409, '잔고가 동시에 변경되었습니다. 다시 시도하세요.');
          }
          return err(500, 'Failed to update balance: ' + updateErr.message);
        }

        // 감사 로그 — 실패해도 무시하지 않는다. 특권 행위는 기록 없이 성공으로
        // 보고되면 안 되며(내부자 위협 무방비), 최소한 호출자가 알아야 한다.
        const auditOk = await writeAudit({
          action: 'set_balance',
          actor_user_id: authResult?.userId || null,
          target_user_id: userId,
          details: { currency, previousBalance: currentBalance, newBalance, reason: adjustReason },
        });

        return ok({ success: true, previousBalance: currentBalance, newBalance, currency,
                    auditLogged: auditOk });
      }

      // 보유자산 수정/추가
      if (action === 'setHolding') {
        const { symbol, quantity, avg_price, adjustReason } = b;
        if (!symbol) return err(400, 'symbol is required');
        if (typeof quantity !== 'number' || quantity < 0) return err(400, 'quantity must be a non-negative number');

        // 기존 보유량 조회
        const existingResult = await dynamodb.send(new QueryCommand({
          TableName: 'supernoba-holdings',
          KeyConditionExpression: 'user_id = :uid AND symbol = :sym',
          ExpressionAttributeValues: { ':uid': userId, ':sym': symbol }
        }));
        const existingHolding = existingResult.Items?.[0];

        if (quantity === 0) {
          // 수량이 0이면 삭제
          await dynamodb.send(new DeleteCommand({
            TableName: 'supernoba-holdings',
            Key: { user_id: userId, symbol }
          }));

          // 감사 로그 (DynamoDB) - 오류 무시
          try {
            await dynamodb.send(new PutCommand({
              TableName: AUDIT_LOGS_TABLE,
              Item: {
                log_id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                action: 'delete_holding',
                target_user_id: userId,
                details: { symbol, previousQuantity: existingHolding?.quantity || 0, reason: adjustReason },
                created_at: new Date().toISOString()
              }
            }));
          } catch (e) {
            console.log('Audit log error (ignored):', e.message);
          }

          return ok({ success: true, message: `Holding ${symbol} deleted`, previousQuantity: existingHolding?.quantity || 0 });
        }

        // 보유량 설정/업데이트 (avg_price 소수점 첫째 자리까지)
        const roundedAvgPrice = Math.round((avg_price || existingHolding?.avg_price || 0) * 10) / 10;
        const holdingData = {
          user_id: userId,
          symbol,
          quantity,
          avg_price: roundedAvgPrice,
          total_cost: Math.round(quantity * roundedAvgPrice * 10) / 10,
          updated_at: new Date().toISOString()
        };

        await dynamodb.send(new PutCommand({
          TableName: 'supernoba-holdings',
          Item: holdingData
        }));

        // 감사 로그 (DynamoDB) - 오류 무시
        try {
          await dynamodb.send(new PutCommand({
            TableName: AUDIT_LOGS_TABLE,
            Item: {
              log_id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              action: 'set_holding',
              target_user_id: userId,
              details: {
                symbol,
                previousQuantity: existingHolding?.quantity || 0,
                newQuantity: quantity,
                avg_price: holdingData.avg_price,
                reason: adjustReason
              },
              created_at: new Date().toISOString()
            }
          }));
        } catch (e) {
          console.log('Audit log error (ignored):', e.message);
        }

        return ok({
          success: true,
          holding: holdingData,
          previousQuantity: existingHolding?.quantity || 0
        });
      }

      // 사용자 삭제 (Step Functions 비동기 실행)
      if (action === 'deleteUser') {
        // Pre-check: 사용자 존재 확인
        try {
          const { Item: targetUser } = await dynamodb.send(new GetCommand({
            TableName: USERS_TABLE,
            Key: { user_id: userId }
          }));
          if (!targetUser) return err(404, 'User not found');
        } catch (e) {
          return err(500, 'User lookup failed: ' + e.message);
        }

        const jobId = `delete-${userId}-${Date.now()}`;
        const now = new Date().toISOString();

        // Job 레코드 생성
        try {
          await dynamodb.send(new PutCommand({
            TableName: DELETE_JOBS_TABLE,
            Item: {
              job_id: jobId,
              user_id: userId,
              status: 'IN_PROGRESS',
              phase: 'STARTING',
              phases_completed: [],
              started_at: now,
              started_by: authResult.userId,
              updated_at: now
            }
          }));
        } catch (e) {
          return err(500, 'Failed to create job: ' + e.message);
        }

        // Step Functions 실행
        try {
          const execution = await sfn.send(new StartExecutionCommand({
            stateMachineArn: DELETE_USER_STATE_MACHINE_ARN,
            name: jobId,
            input: JSON.stringify({ job_id: jobId, user_id: userId })
          }));

          // Job에 execution ARN 저장
          await dynamodb.send(new UpdateCommand({
            TableName: DELETE_JOBS_TABLE,
            Key: { job_id: jobId },
            UpdateExpression: 'SET execution_arn = :arn, updated_at = :now',
            ExpressionAttributeValues: {
              ':arn': execution.executionArn,
              ':now': now
            }
          }));

          // 감사 로그
          try {
            await dynamodb.send(new PutCommand({
              TableName: AUDIT_LOGS_TABLE,
              Item: {
                log_id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                action: 'delete_user_initiated',
                target_user_id: userId,
                details: { job_id: jobId, started_by: authResult.userId },
                created_at: now
              }
            }));
          } catch (e) {
            console.log('Audit log error (ignored):', e.message);
          }

          return ok({ success: true, job_id: jobId, message: 'User deletion started' });
        } catch (e) {
          // SFN 실행 실패 시 job 상태 업데이트
          await dynamodb.send(new UpdateCommand({
            TableName: DELETE_JOBS_TABLE,
            Key: { job_id: jobId },
            UpdateExpression: 'SET #status = :status, error = :error, updated_at = :now',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':status': 'FAILED',
              ':error': e.message,
              ':now': now
            }
          })).catch(() => {});
          return err(500, 'Failed to start deletion: ' + e.message);
        }
      }

      return err(400, 'Invalid action. Supported: getSettings, saveSettings, suspend, unsuspend, setAdmin, setTester, setBalance, setHolding, getAllHoldings, deleteUser, deleteUserStatus, abortDeleteUser');
    }

    return err(404, 'Not found');
  } catch (e) {
    console.error('Error:', e);
    return err(500, e.message);
  }
};
