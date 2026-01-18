// Supernoba-asset-handler - DynamoDB Version (Supabase Removed)
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

// Common Layer - CORS
import { CORS, response, handleOptions } from '/opt/nodejs/index.mjs';

// Auth Layer (optional - fallback if not available)
let verifyAuth = null;
try {
  const authLayer = await import('/opt/nodejs/verifyAuth.mjs');
  verifyAuth = authLayer.verifyAuth;
} catch (e) {
  console.warn('[asset-handler] Auth layer not available');
}

// DynamoDB Client
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const ddb = DynamoDBDocumentClient.from(dynamoClient);
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'supernoba-orders';
const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';
const HOLDINGS_TABLE = process.env.HOLDINGS_TABLE || 'supernoba-holdings';
const WALLETS_TABLE = process.env.WALLETS_TABLE || 'supernoba-wallets';
const USER_CACHE_TABLE = process.env.USER_CACHE_TABLE || 'supernoba-user-cache';

// === 심볼 캐시 (Lambda 인스턴스 내 메모리 캐시) ===
// 관리자/일반 사용자별 별도 캐시
let symbolsCacheAdmin = null;
let symbolsCacheUser = null;
let symbolsCacheAdminExpiry = 0;
let symbolsCacheUserExpiry = 0;
const SYMBOLS_CACHE_TTL = 5 * 60 * 1000; // 5분

/**
 * 사용자의 관리자/테스터 여부 확인
 * @param {Object} event - Lambda 이벤트
 * @returns {Promise<{isAdmin: boolean, isTester: boolean, userId: string|null}>}
 */
async function checkUserPermissions(event) {
  try {
    // 1. JWT 토큰에서 userId 추출
    let userId = null;

    if (verifyAuth) {
      const authResult = await verifyAuth(event, { required: false });
      if (authResult.success && authResult.userId) {
        userId = authResult.userId;
      }
    }

    // 2. userId가 없으면 일반 사용자로 처리
    if (!userId) {
      return { isAdmin: false, isTester: false, userId: null };
    }

    // 3. user-cache에서 권한 확인
    const userResult = await ddb.send(new GetCommand({
      TableName: USER_CACHE_TABLE,
      Key: { user_id: userId }
    }));

    if (userResult.Item) {
      return {
        isAdmin: userResult.Item.is_admin === true,
        isTester: userResult.Item.is_tester === true,
        userId
      };
    }

    return { isAdmin: false, isTester: false, userId };
  } catch (e) {
    console.error('[asset-handler] checkUserPermissions error:', e);
    return { isAdmin: false, isTester: false, userId: null };
  }
}

// === Layer의 CORS.WITH_API_KEY 사용 (x-api-key 헤더 지원) ===
const HEADERS = CORS.WITH_API_KEY;

export const handler = async (event) => {
    // console.log("Event:", JSON.stringify(event));
    
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: HEADERS, body: '' };
    }

    const { httpMethod, path, queryStringParameters, pathParameters } = event;
    const userId = queryStringParameters?.userId;
    const symbolParam = pathParameters?.symbol || (path.includes('/symbols/') ? path.split('/symbols/')[1] : null);

    // symbols 엔드포인트는 userId 불필요하지만 관리자 여부 확인 필요
    if (path.includes('/symbols')) {
        try {
            // 관리자/테스터 여부 확인
            const permissions = await checkUserPermissions(event);
            const canViewTestSymbols = permissions.isAdmin || permissions.isTester;

            if (httpMethod === 'GET') {
                if (symbolParam) {
                    return await getSymbolInfo(symbolParam, canViewTestSymbols);
                } else {
                    return await getAllSymbols(canViewTestSymbols);
                }
            }
            return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: "Method Not Allowed" }) };
        } catch (error) {
            console.error("Handler Error:", error);
            return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };
        }
    }

    if (!userId) {
        return {
            statusCode: 400,
            headers: HEADERS,
            body: JSON.stringify({ error: "Missing userId parameter" })
        };
    }

    try {
        // === Security: Verify that the requester can access this userId's data ===
        // Either the user is accessing their own data, or they're an admin
        let authUserId = null;
        let isAdmin = false;

        if (verifyAuth) {
            const authResult = await verifyAuth(event, { required: false });
            if (authResult.success && authResult.userId) {
                authUserId = authResult.userId;
            }
        }

        // Check admin permissions (via API key or admin role)
        const permissions = await checkUserPermissions(event);
        isAdmin = permissions.isAdmin;

        // If not admin, verify that the queried userId matches the authenticated user
        if (!isAdmin && authUserId && authUserId !== userId) {
            console.warn(`[asset-handler] Security: User ${authUserId} attempted to access data for ${userId}`);
            return {
                statusCode: 403,
                headers: HEADERS,
                body: JSON.stringify({ error: "Forbidden: Cannot access other user's data" })
            };
        }

        // If no auth and not admin, still allow (for backwards compatibility)
        // but log for monitoring
        if (!authUserId && !isAdmin) {
            console.warn(`[asset-handler] Unauthenticated access to userId: ${userId}`);
        }

        if (httpMethod === 'GET') {
            if (path.includes('/assets')) {
                return await getUserAssets(userId);
            } else if (path.includes('/orders')) {
                return await getOrderHistory(userId);
            } else if (path.includes('/trades')) {
                return await getTradeHistory(userId); // DynamoDB에서 FILLED 주문 조회
            } else {
                 return {
                    statusCode: 404,
                    headers: HEADERS,
                    body: JSON.stringify({ error: "Not Found" })
                };
            }
        }

        return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: "Method Not Allowed" }) };
    } catch (error) {
        console.error("Handler Error:", error);
        return {
            statusCode: 500,
            headers: HEADERS,
            body: JSON.stringify({ error: error.message })
        };
    }
};

async function getUserAssets(userId) {
    // 1. Fetch BOLT wallet from DynamoDB
    const walletResult = await ddb.send(new GetCommand({
        TableName: WALLETS_TABLE,
        Key: { user_id: userId, currency: 'BOLT' }
    }));

    // 2. Initialize if empty (Auto-Init Strategy)
    let balance = { available: 0, locked: 0, total: 0, currency: 'BOLT' };

    if (!walletResult.Item) {
        console.log(`[UserId: ${userId}] No BOLT wallet found. Initializing default BOLT wallet.`);
        const now = new Date().toISOString();
        const newWallet = {
            user_id: userId,
            currency: 'BOLT',
            available: 10000000, // 10 Million BOLT Airdrop
            locked: 0,
            version: 1,
            created_at: now,
            updated_at: now
        };

        try {
            await ddb.send(new PutCommand({
                TableName: WALLETS_TABLE,
                Item: newWallet,
                ConditionExpression: 'attribute_not_exists(user_id)'
            }));
        } catch (e) {
            if (e.name === 'ConditionalCheckFailedException') {
                // Race condition: wallet was created by another request, re-fetch
                const retryResult = await ddb.send(new GetCommand({
                    TableName: WALLETS_TABLE,
                    Key: { user_id: userId, currency: 'BOLT' }
                }));
                if (retryResult.Item) {
                    const w = retryResult.Item;
                    balance = {
                        available: Number(w.available || 0),
                        locked: Number(w.locked || 0),
                        total: Number(w.available || 0) + Number(w.locked || 0),
                        currency: 'BOLT'
                    };
                }
            } else {
                throw e;
            }
        }

        if (balance.total === 0) {
            balance = {
                available: 10000000,
                locked: 0,
                total: 10000000,
                currency: 'BOLT'
            };
        }
    } else {
        const w = walletResult.Item;
        balance = {
            available: Number(w.available || 0),
            locked: Number(w.locked || 0),
            total: Number(w.available || 0) + Number(w.locked || 0),
            currency: 'BOLT'
        };
    }

    // 3. Fetch holdings from DynamoDB
    const holdingsResult = await ddb.send(new QueryCommand({
        TableName: HOLDINGS_TABLE,
        KeyConditionExpression: 'user_id = :uid',
        ExpressionAttributeValues: { ':uid': userId }
    }));

    const holdings = (holdingsResult.Items || []).map(item => {
        const quantity = Number(item.quantity || 0);
        const locked = Number(item.locked || 0);
        // DynamoDB 필드명 호환: avgPrice 또는 avg_price 둘 다 지원
        const avgPrice = Number(item.avgPrice || item.avg_price || 0);
        return {
            symbol: item.symbol,
            quantity: quantity,
            available: quantity - locked,
            locked: locked,
            avgPrice: avgPrice
        };
    });

    return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ balance, holdings })
    };
}

async function getOrderHistory(userId) {
    // Query DynamoDB for orders
    const result = await ddb.send(new QueryCommand({
        TableName: ORDERS_TABLE,
        KeyConditionExpression: 'user_id = :uid',
        ExpressionAttributeValues: { ':uid': userId },
        ScanIndexForward: false, // descending order
        Limit: 50
    }));
    
    const orders = (result.Items || []).map(item => ({
        id: item.order_id,
        order_id: item.order_id, // WebSocket과 호환성을 위해 추가
        user_id: item.user_id,
        symbol: item.symbol,
        side: item.side,
        type: item.type,
        price: item.price,
        filled_price: item.filled_price || null, // 실제 체결 가격
        quantity: item.quantity,
        filled_qty: item.filled_qty || 0,
        status: item.status,
        created_at: item.created_at,
        updated_at: item.updated_at,
        timestamp: item.created_at // WebSocket과 호환성을 위해 추가
    }));
    
    return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ orders })
    };
}

async function getTradeHistory(userId) {
    // 주문 데이터는 DynamoDB에 저장되어 있음
    // FILLED 상태의 주문을 조회하여 체결 이력으로 반환
    try {
        const result = await ddb.send(new QueryCommand({
            TableName: ORDERS_TABLE,
            KeyConditionExpression: 'user_id = :uid',
            FilterExpression: '#status = :filled',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { 
                ':uid': userId,
                ':filled': 'FILLED'
            },
            ScanIndexForward: false, // 최신순
            Limit: 50
        }));
        
        const trades = (result.Items || []).map(item => ({
            id: item.order_id,
            order_id: item.order_id,
            user_id: item.user_id,
            symbol: item.symbol,
            side: item.side,
            type: item.type,
            price: item.price,
            filled_price: item.filled_price || item.price, // 실제 체결 가격 (없으면 주문 가격)
            quantity: item.quantity,
            filled_qty: item.filled_qty || item.quantity,
            status: item.status,
            created_at: item.created_at,
            updated_at: item.updated_at,
            timestamp: item.updated_at || item.created_at // 체결 시간으로 updated_at 사용
        }));

        // timestamp 기준 내림차순 정렬 (최신순)
        trades.sort((a, b) => {
            const timeA = new Date(a.timestamp || 0).getTime();
            const timeB = new Date(b.timestamp || 0).getTime();
            return timeB - timeA;
        });

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({ trades })
        };
    } catch (error) {
        console.error("[asset-handler] getTradeHistory error:", error);
        return {
            statusCode: 500,
            headers: HEADERS,
            body: JSON.stringify({ error: error.message, trades: [] })
        };
    }
}

// DynamoDB에서 종목 정보 조회 (크리에이터 정보 포함)
async function getSymbolInfo(symbol, canViewTestSymbols = false) {
    try {
        const result = await ddb.send(new GetCommand({
            TableName: SYMBOLS_TABLE,
            Key: { symbol: symbol.toUpperCase() }
        }));

        if (!result.Item) {
            return {
                statusCode: 404,
                headers: HEADERS,
                body: JSON.stringify({ error: 'Symbol not found' })
            };
        }

        const item = result.Item;

        // 테스트 종목인데 권한이 없는 경우 404 반환
        if (item.is_test === true && !canViewTestSymbols) {
            return {
                statusCode: 404,
                headers: HEADERS,
                body: JSON.stringify({ error: 'Symbol not found' })
            };
        }
        const platformStats = item.platformStats || {};

        // 소셜 링크 생성 (platform과 creatorUrl 기반)
        const socialLinks = buildSocialLinks(item.platform, item.creatorUrl, item.socialLinks);

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({
                // 기본 정보
                symbol: item.symbol,
                name: item.name || item.symbol,
                logo_url: item.logoUrl || item.logo_url || null,
                status: item.status || 'ACTIVE',

                // 크리에이터 정보
                platform: item.platform || 'ETC',
                creatorUrl: item.creatorUrl || null,
                profileUrl: item.profileUrl || null,
                description: item.description || null,
                verified: item.verified || false,
                trustScore: item.trustScore || 5,

                // 플랫폼 통계
                platformStats: {
                    subscribers: platformStats.subscribers || 0,
                    followers: platformStats.followers || 0,
                    views: platformStats.views || 0,
                    videos: platformStats.videos || 0,
                    lastUpdated: platformStats.lastUpdated || null
                },

                // 마켓 데이터
                marketCap: item.marketCap || 0,
                volume24h: item.volume24h || 0,
                priceChange24h: item.priceChange24h || 0,
                circulatingSupply: item.circulatingSupply || 0,
                totalSupply: item.totalSupply || 0,

                // 소셜 링크
                socialLinks: socialLinks,

                // 기타 메타데이터
                tags: item.tags || [],
                categories: item.categories || [],
                listingDate: item.listingDate || null
            })
        };
    } catch (error) {
        console.error("[asset-handler] getSymbolInfo error:", error);
        return {
            statusCode: 500,
            headers: HEADERS,
            body: JSON.stringify({ error: error.message })
        };
    }
}

// 플랫폼 기반 소셜 링크 생성
function buildSocialLinks(platform, creatorUrl, existingSocialLinks) {
    // 기존에 저장된 소셜 링크가 있으면 사용
    const links = {
        youtube: existingSocialLinks?.youtube || null,
        twitter: existingSocialLinks?.twitter || null,
        instagram: existingSocialLinks?.instagram || null,
        twitch: existingSocialLinks?.twitch || null,
        tiktok: existingSocialLinks?.tiktok || null,
        chzzk: existingSocialLinks?.chzzk || null,
        afreecatv: existingSocialLinks?.afreecatv || null
    };

    // creatorUrl을 해당 플랫폼 링크로 설정
    if (creatorUrl) {
        switch (platform?.toUpperCase()) {
            case 'YOUTUBE':
                links.youtube = creatorUrl;
                break;
            case 'X':
            case 'TWITTER':
                links.twitter = creatorUrl;
                break;
            case 'INSTAGRAM':
                links.instagram = creatorUrl;
                break;
            case 'TWITCH':
                links.twitch = creatorUrl;
                break;
            case 'TIKTOK':
                links.tiktok = creatorUrl;
                break;
            case 'CHZZK':
                links.chzzk = creatorUrl;
                break;
            case 'AFREECATV':
                links.afreecatv = creatorUrl;
                break;
        }
    }

    return links;
}

// 모든 활성 종목 조회 (메모리 캐시 + DynamoDB)
// canViewTestSymbols: 관리자/테스터인 경우 테스트 종목 포함
async function getAllSymbols(canViewTestSymbols = false) {
    try {
        const now = Date.now();

        // 관리자/일반 사용자별 캐시 분리
        const cache = canViewTestSymbols ? symbolsCacheAdmin : symbolsCacheUser;
        const cacheExpiry = canViewTestSymbols ? symbolsCacheAdminExpiry : symbolsCacheUserExpiry;

        // 캐시 확인
        if (cache && now < cacheExpiry) {
            console.log(`[asset-handler] ✅ Symbols cache hit (admin: ${canViewTestSymbols})`);
            return {
                statusCode: 200,
                headers: HEADERS,
                body: JSON.stringify({ symbols: cache })
            };
        }

        console.log(`[asset-handler] Cache miss - fetching from DynamoDB (admin: ${canViewTestSymbols})`);

        // 필터 표현식 동적 구성
        let filterExpression = '#status = :active';
        const expressionAttrValues = { ':active': 'ACTIVE' };

        if (!canViewTestSymbols) {
            // 일반 사용자: 테스트 종목 제외
            filterExpression += ' AND (attribute_not_exists(is_test) OR is_test = :false)';
            expressionAttrValues[':false'] = false;
        }

        const result = await ddb.send(new ScanCommand({
            TableName: SYMBOLS_TABLE,
            FilterExpression: filterExpression,
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: expressionAttrValues
        }));

        const symbols = (result.Items || []).map(item => ({
            symbol: item.symbol,
            name: item.name || item.symbol,
            logo_url: item.logoUrl || item.logo_url || null,
            status: item.status || 'ACTIVE',
            is_test: item.is_test || false
        }));

        // 캐시 업데이트 (관리자/일반 사용자별)
        if (canViewTestSymbols) {
            symbolsCacheAdmin = symbols;
            symbolsCacheAdminExpiry = now + SYMBOLS_CACHE_TTL;
        } else {
            symbolsCacheUser = symbols;
            symbolsCacheUserExpiry = now + SYMBOLS_CACHE_TTL;
        }
        console.log(`[asset-handler] ✅ Cached ${symbols.length} symbols for 5 min (admin: ${canViewTestSymbols})`);

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({ symbols })
        };
    } catch (error) {
        console.error("[asset-handler] getAllSymbols error:", error);
        return {
            statusCode: 500,
            headers: HEADERS,
            body: JSON.stringify({ error: error.message })
        };
    }
}
