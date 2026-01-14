// Supernoba-admin-users: 사용자 관리 Lambda
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ScanCommand, QueryCommand, PutCommand, DeleteCommand, GetCommand, UpdateCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Common Layer - Valkey, CORS
import { getValkeyClient, CORS, response } from '/opt/nodejs/index.mjs';

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
  }
};

// 설정 캐시
let cachedSettings = null;

const ADMIN_KEY = process.env.ADMIN_API_KEY;
const USER_CACHE_TABLE = process.env.USER_CACHE_TABLE || 'supernoba-user-cache';
const WALLETS_TABLE = process.env.WALLETS_TABLE || 'supernoba-wallets';
const AUDIT_LOGS_TABLE = process.env.AUDIT_LOGS_TABLE || 'supernoba-audit-logs';

// Layer를 통한 클라이언트 초기화
const valkey = getValkeyClient({ preset: 'admin' });
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-northeast-2' }));

// Layer의 CORS.FULL 사용
const H = CORS.FULL;
const isAdmin = (e) => !ADMIN_KEY || (e.headers?.Authorization || e.headers?.authorization) === ADMIN_KEY;
const ok = (d) => response.ok(d, H);
const err = (c, m) => response.error(c, m, H);

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  if (!isAdmin(event)) return err(403, 'Unauthorized');

  try {
    const m = event.httpMethod;
    const q = event.queryStringParameters || {};
    const path = event.path || '';

    // GET: 사용자 목록 또는 개별 사용자 조회
    if (m === 'GET') {
      const { userId, page = 1, limit = 50, search, status: userStatus } = q;

      // 개별 사용자 상세 조회
      if (userId) {
        // DynamoDB user-cache에서 사용자 프로필 조회
        let profile = null;
        try {
          const { Item } = await dynamodb.send(new GetCommand({
            TableName: USER_CACHE_TABLE,
            Key: { user_id: userId }
          }));
          profile = Item || null;
        } catch (profileErr) {
          console.error('[GET USER] Profile fetch error:', profileErr.message);
        }

        // DynamoDB에서 지갑 정보 조회
        let wallets = [];
        try {
          const { Items } = await dynamodb.send(new QueryCommand({
            TableName: WALLETS_TABLE,
            KeyConditionExpression: 'user_id = :uid',
            ExpressionAttributeValues: { ':uid': userId }
          }));
          wallets = Items || [];
        } catch (walletErr) {
          console.error('[GET USER] Wallet fetch error:', walletErr.message);
        }

        // 지갑이 없는 경우 기본 BOLT 지갑 정보 추가 (신규 가입자는 0원)
        const boltWallet = wallets.find(w => w.currency === 'BOLT');
        const effectiveWallets = wallets.length > 0 ? wallets : [{
          user_id: userId,
          currency: 'BOLT',
          available: 0,
          locked: 0,
          is_virtual: true // 실제 DB에 존재하지 않음을 표시
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

      // 사용자 목록 조회 (DynamoDB user-cache에서)
      try {
        // DynamoDB Scan으로 전체 사용자 조회 (필터링은 메모리에서 수행)
        const { Items: allUsers } = await dynamodb.send(new ScanCommand({
          TableName: USER_CACHE_TABLE
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

        // 각 사용자의 잔고 정보 추가
        const enrichedUsers = await Promise.all(paginatedUsers.map(async (user) => {
          let wallets = [];
          try {
            const { Items } = await dynamodb.send(new QueryCommand({
              TableName: WALLETS_TABLE,
              KeyConditionExpression: 'user_id = :uid',
              ExpressionAttributeValues: { ':uid': user.user_id }
            }));
            wallets = Items || [];
          } catch (e) {
            // 지갑 조회 실패 시 무시
          }

          const boltWallet = wallets.find(w => w.currency === 'BOLT');
          const hasWallet = boltWallet !== undefined;
          return {
            ...user,
            id: user.user_id, // 호환성 유지
            bolt_balance: hasWallet ? (boltWallet.available ?? 0) : 0,
            bolt_locked: boltWallet?.locked || 0,
            wallet_exists: hasWallet
          };
        }));

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

        // 사용자 정보 추가 (DynamoDB user-cache에서)
        const userIds = [...new Set(holdings.map(h => h.user_id))];
        const userMap = {};

        // 사용자 정보를 병렬로 조회 (최대 100명)
        const userPromises = userIds.slice(0, 100).map(async (uid) => {
          try {
            const { Item } = await dynamodb.send(new GetCommand({
              TableName: USER_CACHE_TABLE,
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

      // 나머지 액션은 userId 필요
      if (!userId) return err(400, 'userId is required');

      // 사용자 정지
      if (action === 'suspend') {
        try {
          await dynamodb.send(new UpdateCommand({
            TableName: USER_CACHE_TABLE,
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

        return ok({ success: true, message: `User ${userId} suspended` });
      }

      // 사용자 정지 해제
      if (action === 'unsuspend') {
        try {
          await dynamodb.send(new UpdateCommand({
            TableName: USER_CACHE_TABLE,
            Key: { user_id: userId },
            UpdateExpression: 'SET is_suspended = :suspended REMOVE suspended_at, suspended_reason',
            ExpressionAttributeValues: {
              ':suspended': false
            }
          }));
        } catch (e) {
          return err(500, 'Failed to unsuspend user: ' + e.message);
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

        try {
          await dynamodb.send(new UpdateCommand({
            TableName: USER_CACHE_TABLE,
            Key: { user_id: userId },
            UpdateExpression: 'SET is_admin = :isAdmin, updated_at = :updatedAt',
            ExpressionAttributeValues: {
              ':isAdmin': isAdmin,
              ':updatedAt': new Date().toISOString()
            }
          }));
        } catch (e) {
          return err(500, 'Failed to update admin status: ' + e.message);
        }

        // 감사 로그 (DynamoDB) - 오류 무시
        try {
          await dynamodb.send(new PutCommand({
            TableName: AUDIT_LOGS_TABLE,
            Item: {
              log_id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              action: 'set_admin',
              target_user_id: userId,
              details: { isAdmin },
              created_at: new Date().toISOString()
            }
          }));
        } catch (e) {
          console.log('Audit log error (ignored):', e.message);
        }

        return ok({ success: true, message: `User ${userId} admin status set to ${isAdmin}` });
      }

      // 잔고 설정 (값 직접 변경)
      if (action === 'setBalance') {
        const { currency = 'BOLT', newBalance, adjustReason } = b;
        if (typeof newBalance !== 'number' || newBalance < 0) return err(400, 'newBalance must be a non-negative number');

        // DynamoDB에서 현재 잔고 조회
        let currentBalance = 0;
        let currentLocked = 0;
        try {
          const { Item: wallet } = await dynamodb.send(new GetCommand({
            TableName: WALLETS_TABLE,
            Key: { user_id: userId, currency: currency }
          }));
          currentBalance = wallet?.available || 0;
          currentLocked = wallet?.locked || 0;
        } catch (e) {
          console.log('Wallet fetch error (ignored):', e.message);
        }

        // DynamoDB에 잔고 저장 (Upsert)
        try {
          await dynamodb.send(new PutCommand({
            TableName: WALLETS_TABLE,
            Item: {
              user_id: userId,
              currency,
              available: newBalance,
              locked: currentLocked,
              updated_at: new Date().toISOString()
            }
          }));
        } catch (updateErr) {
          return err(500, 'Failed to update balance: ' + updateErr.message);
        }

        // 감사 로그 (DynamoDB) - 오류 무시
        try {
          await dynamodb.send(new PutCommand({
            TableName: AUDIT_LOGS_TABLE,
            Item: {
              log_id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              action: 'set_balance',
              target_user_id: userId,
              details: { currency, previousBalance: currentBalance, newBalance, reason: adjustReason },
              created_at: new Date().toISOString()
            }
          }));
        } catch (e) {
          console.log('Audit log error (ignored):', e.message);
        }

        return ok({ success: true, previousBalance: currentBalance, newBalance, currency });
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

      return err(400, 'Invalid action. Supported: getSettings, saveSettings, suspend, unsuspend, setBalance, setHolding, getAllHoldings');
    }

    return err(404, 'Not found');
  } catch (e) {
    console.error('Error:', e);
    return err(500, e.message);
  }
};
