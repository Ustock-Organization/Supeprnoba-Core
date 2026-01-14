import Redis from 'ioredis';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutCommand, DeleteCommand, GetCommand, UpdateCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { KinesisClient, PutRecordCommand } from "@aws-sdk/client-kinesis";
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';

// === Configuration ===
const VALKEY_HOST = process.env.VALKEY_HOST;
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT || '6379');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const CREATOR_REQUESTS_TABLE = process.env.CREATOR_REQUESTS_TABLE || 'supernoba-creator-requests';

// RDS Config
const DB_SECRET_ARN = process.env.DB_SECRET_ARN;
const RDS_ENDPOINT = process.env.RDS_ENDPOINT;
const DB_NAME = process.env.DB_NAME || 'postgres';
const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-2';

const secretsManager = new SecretsManagerClient({ region: AWS_REGION });

// Clients
const valkey = new Redis({
  host: VALKEY_HOST,
  port: VALKEY_PORT,
  tls: {},
  connectTimeout: 5000,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});
valkey.on('error', (err) => console.error('Redis error:', err.message));

const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: AWS_REGION })
);
const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';

// Kinesis for order publishing
const kinesis = new KinesisClient({ region: AWS_REGION });
const ORDER_STREAM = process.env.ORDER_STREAM || 'supernoba-orders';

// IPO System Account
const IPO_SYSTEM_ACCOUNT = 'ipo-system';
const HOLDINGS_TABLE = process.env.HOLDINGS_TABLE || 'supernoba-holdings';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

// Helper: Validate and sanitize symbol for safe SQL identifier usage
function validateSymbol(symbol) {
    if (!symbol || typeof symbol !== 'string') return null;
    const cleaned = symbol.toLowerCase().replace(/[^a-z0-9]/g, '');
    // Maximum length 20, minimum 1
    if (cleaned.length < 1 || cleaned.length > 20) return null;
    return cleaned;
}

// Helper: RDS Partition
async function ensureRdsPartition(symbol) {
    if (!DB_SECRET_ARN || !RDS_ENDPOINT) {
        console.warn('Skipping RDS Partition creation (Missing Config)');
        return;
    }

    const cleanSymbol = validateSymbol(symbol);
    if (!cleanSymbol) {
        console.error(`[RDS] Invalid symbol for partition: ${symbol}`);
        return;
    }

    let client = null;
    try {
        const secretRes = await secretsManager.send(new GetSecretValueCommand({ SecretId: DB_SECRET_ARN }));
        const creds = JSON.parse(secretRes.SecretString);

        client = new pg.Client({
             host: RDS_ENDPOINT,
             user: creds.username,
             password: creds.password,
             database: DB_NAME,
             port: 5432,
             ssl: { rejectUnauthorized: false },
             connectionTimeoutMillis: 5000
        });
        await client.connect();

        // Create master tables first (idempotent)
        await client.query(`
            CREATE TABLE IF NOT EXISTS public.trade_history (
                id UUID DEFAULT gen_random_uuid(),
                symbol TEXT NOT NULL,
                price NUMERIC NOT NULL,
                quantity NUMERIC NOT NULL,
                buyer_id UUID,
                seller_id UUID,
                buyer_order_id UUID,
                seller_order_id UUID,
                created_at TIMESTAMPTZ DEFAULT now(),
                timestamp BIGINT,
                PRIMARY KEY (symbol, id)
            ) PARTITION BY LIST (symbol)
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS public.candle_history (
                id SERIAL,
                symbol TEXT NOT NULL,
                interval TEXT NOT NULL,
                time_epoch BIGINT NOT NULL,
                time_ymdhm TEXT NOT NULL,
                open NUMERIC NOT NULL,
                high NUMERIC NOT NULL,
                low NUMERIC NOT NULL,
                close NUMERIC NOT NULL,
                volume NUMERIC DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT now(),
                PRIMARY KEY (symbol, interval, time_epoch)
            ) PARTITION BY LIST (symbol)
        `);

        // Create partitions using quoted identifiers
        const tradeTableName = `trade_history_${cleanSymbol}`;
        const candleTableName = `candle_history_${cleanSymbol}`;

        await client.query(`
            CREATE TABLE IF NOT EXISTS public."${tradeTableName}"
            PARTITION OF public.trade_history
            FOR VALUES IN ($1)
        `, [cleanSymbol]);

        await client.query(`
            CREATE TABLE IF NOT EXISTS public."${candleTableName}"
            PARTITION OF public.candle_history
            FOR VALUES IN ($1)
        `, [cleanSymbol]);

        console.log(`[RDS] Partitions created for ${cleanSymbol}`);
        
    } catch (err) {
        console.error(`[RDS] Partition creation failed for ${symbol}:`, err);
    } finally {
        if (client) await client.end();
    }
}

// Helper: Detect Platform
const detectPlatform = (url) => {
    if (!url) return 'ETC';
    const lower = url.toLowerCase();
    if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'YOUTUBE';
    if (lower.includes('twitter.com') || lower.includes('x.com')) return 'X';
    if (lower.includes('instagram.com')) return 'INSTAGRAM';
    if (lower.includes('tiktok.com')) return 'TIKTOK';
    if (lower.includes('chzzk')) return 'CHZZK';
    if (lower.includes('afreecatv')) return 'AFREECATV';
    return 'ETC';
};

// Admin Check
function isAdmin(event) {
  const authHeader = event.headers?.Authorization || event.headers?.authorization;
  if (!ADMIN_API_KEY) return true; 
  if (authHeader !== ADMIN_API_KEY) {
      console.log(`[AUTH FAIL] Expected: '${ADMIN_API_KEY}', Got: '${authHeader}'`);
      return false;
  }
  return true; 
}

export const handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (!isAdmin(event)) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const path = event.path || '';
        
        // === APPROVE ===
        // Supports /approve path or action=approve
        if (path.includes('approve') || body.action === 'approve') {
            const {
                requestId,
                symbol,
                name,
                logo_url,
                listingPrice = 0,
                totalShares = 0,
                platform: providedPlatform,
                description,
                ipoQuantity = 0,
                ipoPrice = 0
            } = body;

            console.log(`[APPROVE] Processing: ${symbol}, ReqID: ${requestId}, IPO: ${ipoQuantity}@${ipoPrice}`);

            if (!symbol || !name || name.trim().length === 0 || name.length > 100) {
                return { statusCode: 400, headers, body: JSON.stringify({error: 'Invalid symbol or name'}) };
            }

            // Validate numeric inputs
            if (listingPrice !== undefined && listingPrice !== 0 && (isNaN(listingPrice) || listingPrice < 0 || !isFinite(listingPrice))) {
                return { statusCode: 400, headers, body: JSON.stringify({error: 'Invalid listingPrice'}) };
            }
            if (totalShares !== undefined && totalShares !== 0 && (isNaN(totalShares) || totalShares < 0 || !isFinite(totalShares))) {
                return { statusCode: 400, headers, body: JSON.stringify({error: 'Invalid totalShares'}) };
            }
            if (ipoQuantity && (isNaN(ipoQuantity) || ipoQuantity < 0 || !isFinite(ipoQuantity))) {
                return { statusCode: 400, headers, body: JSON.stringify({error: 'Invalid ipoQuantity'}) };
            }
            if (ipoPrice && (isNaN(ipoPrice) || ipoPrice < 0 || !isFinite(ipoPrice))) {
                return { statusCode: 400, headers, body: JSON.stringify({error: 'Invalid ipoPrice'}) };
            }
            // Validate IPO quantity doesn't exceed total shares
            if (ipoQuantity > 0 && totalShares > 0 && ipoQuantity > totalShares) {
                return { statusCode: 400, headers, body: JSON.stringify({error: 'IPO quantity cannot exceed total shares'}) };
            }

            // 삭제된 종목 체크
            const sym = symbol.toUpperCase().trim();
            const isDeleted = await valkey.sismember('deleted:symbols', sym);
            if (isDeleted) {
                console.log(`[APPROVE] Blocked: Symbol ${sym} was previously deleted`);
                return { statusCode: 400, headers, body: JSON.stringify({ error: `Symbol ${sym} was previously deleted and cannot be approved` }) };
            }

            // 1. Update Request (DynamoDB)
            // TODO: creator_requests는 DynamoDB로 마이그레이션됨
            let detectedPlatform = providedPlatform || 'ETC';
            let currentReq = null;

            if (requestId) {
                try {
                    // Primary Key is 'request_id', not 'id'
                    const { Item } = await dynamodb.send(new GetCommand({
                        TableName: CREATOR_REQUESTS_TABLE,
                        Key: { request_id: requestId }
                    }));
                    currentReq = Item;

                    if (!currentReq) {
                        console.error(`[APPROVE] Request not found: ${requestId}`);
                        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Request not found', requestId }) };
                    }

                    if (!providedPlatform && currentReq?.creator_url) {
                        detectedPlatform = detectPlatform(currentReq.creator_url);
                    }

                    await dynamodb.send(new UpdateCommand({
                        TableName: CREATOR_REQUESTS_TABLE,
                        Key: { request_id: requestId },
                        UpdateExpression: 'SET #status = :status, platform = :platform, processed_at = :processed_at, approved_symbol = :symbol',
                        ExpressionAttributeNames: { '#status': 'status' },
                        ExpressionAttributeValues: {
                            ':status': 'approved',
                            ':platform': detectedPlatform,
                            ':processed_at': new Date().toISOString(),
                            ':symbol': symbol.toUpperCase()
                        }
                    }));
                } catch (reqErr) {
                    console.error('[APPROVE] Request Update Error:', reqErr);
                    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update request status', details: reqErr.message }) };
                }
            }

            // 2. Insert Symbol
            const now = new Date().toISOString();
            const newSymbol = {
                symbol: symbol.toUpperCase(),
                name: name || symbol.toUpperCase(),
                base_asset: symbol.toUpperCase(),
                quote_asset: 'BOLT',
                status: 'ACTIVE',
                listingDate: now,
                listingPrice: listingPrice || 0,
                totalShares: totalShares || 0,
                delistingDate: null,
                platform: detectedPlatform,
                creatorUrl: currentReq?.creator_url || '',
                profileUrl: `/creator/${symbol.toUpperCase()}`,
                logoUrl: logo_url || '',
                marketCap: (listingPrice || 0) * (totalShares || 0),
                totalSupply: totalShares || 0,
                circulatingSupply: 0,
                volume24h: 0,
                priceChange24h: 0,
                allTimeHigh: listingPrice || 0,
                allTimeLow: listingPrice || 0,
                platformStats: { subscribers: 0, followers: 0, views: 0, videos: 0, lastUpdated: null },
                tags: [],
                categories: [],
                verified: false,
                trustScore: 5,
                userRating: 0,
                ratingCount: 0,
                description: description || `Official symbol for Creator ${name}`
            };

            await dynamodb.send(new PutCommand({
                TableName: SYMBOLS_TABLE,
                Item: newSymbol
            }));

            await valkey.sadd('active:symbols', symbol.toUpperCase());
            await ensureRdsPartition(symbol.toUpperCase());

            // 3. Create IPO holdings and SELL order if ipoQuantity > 0
            let ipoOrderId = null;
            let ipoError = null;
            if (ipoQuantity > 0 && ipoPrice > 0) {
                console.log(`[APPROVE] Creating IPO order: ${ipoQuantity} shares @ ${ipoPrice}`);

                const holdingKey = `${IPO_SYSTEM_ACCOUNT}#${symbol.toUpperCase()}`;
                let holdingsCreated = false;

                try {
                    // Step 1: Create holdings for ipo-system account (user_id/symbol key schema)
                    await dynamodb.send(new PutCommand({
                        TableName: HOLDINGS_TABLE,
                        Item: {
                            user_id: IPO_SYSTEM_ACCOUNT,
                            symbol: symbol.toUpperCase(),
                            quantity: ipoQuantity,
                            availableQuantity: ipoQuantity,
                            averagePrice: ipoPrice,
                            totalCost: ipoQuantity * ipoPrice,
                            createdAt: now,
                            updatedAt: now,
                            source: 'IPO'
                        }
                    }));
                    holdingsCreated = true;
                    console.log(`[APPROVE] IPO holdings created for ${IPO_SYSTEM_ACCOUNT}: ${ipoQuantity} ${symbol.toUpperCase()}`);

                    // Step 2: Publish SELL order to Kinesis
                    ipoOrderId = uuidv4();
                    const ipoOrder = {
                        orderId: ipoOrderId,
                        userId: IPO_SYSTEM_ACCOUNT,
                        symbol: symbol.toUpperCase(),
                        side: 'SELL',
                        type: 'LIMIT',
                        price: ipoPrice,
                        quantity: ipoQuantity,
                        remainingQuantity: ipoQuantity,
                        status: 'NEW',
                        createdAt: Date.now(),
                        source: 'IPO',
                        timeInForce: 'GTC'
                    };

                    await kinesis.send(new PutRecordCommand({
                        StreamName: ORDER_STREAM,
                        PartitionKey: symbol.toUpperCase(),
                        Data: Buffer.from(JSON.stringify({
                            type: 'NEW_ORDER',
                            order: ipoOrder
                        }))
                    }));
                    console.log(`[APPROVE] IPO SELL order published to Kinesis: ${ipoOrderId}`);

                    // Step 3: Cache in Valkey (best effort, non-blocking)
                    valkey.hset(`order:${ipoOrderId}`, {
                        orderId: ipoOrderId,
                        userId: IPO_SYSTEM_ACCOUNT,
                        symbol: symbol.toUpperCase(),
                        side: 'SELL',
                        type: 'LIMIT',
                        price: ipoPrice.toString(),
                        quantity: ipoQuantity.toString(),
                        remainingQuantity: ipoQuantity.toString(),
                        status: 'NEW',
                        createdAt: Date.now().toString(),
                        source: 'IPO'
                    }).catch(err => console.warn('[APPROVE] Valkey cache failed (non-critical):', err.message));

                } catch (ipoErr) {
                    console.error('[APPROVE] IPO order creation failed:', ipoErr);
                    ipoError = ipoErr.message;

                    // Rollback: Delete holdings if they were created but order failed
                    if (holdingsCreated) {
                        try {
                            await dynamodb.send(new DeleteCommand({
                                TableName: HOLDINGS_TABLE,
                                Key: { user_id: IPO_SYSTEM_ACCOUNT, symbol: symbol.toUpperCase() }
                            }));
                            console.log('[APPROVE] IPO holdings rolled back successfully');
                        } catch (rollbackErr) {
                            console.error('[APPROVE] IPO holdings rollback FAILED:', rollbackErr);
                        }
                    }
                    ipoOrderId = null;
                }
            }

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    message: `Symbol ${symbol} approved and created`,
                    symbol: newSymbol,
                    ipoOrderId: ipoOrderId,
                    ...(ipoError && { ipoError: ipoError })
                })
            };
        }

        // === REJECT ===
        // Supports /reject path or action=reject
        // TODO: creator_requests는 DynamoDB로 마이그레이션됨
        if (path.includes('reject') || body.action === 'reject') {
            const { requestId, reason } = body;

            console.log(`[REJECT] Processing: RequestId: ${requestId}`);

            if (!requestId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'requestId is required' }) };

            try {
                // First check if request exists
                const { Item: existingReq } = await dynamodb.send(new GetCommand({
                    TableName: CREATOR_REQUESTS_TABLE,
                    Key: { request_id: requestId }
                }));

                if (!existingReq) {
                    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Request not found', requestId }) };
                }

                await dynamodb.send(new UpdateCommand({
                    TableName: CREATOR_REQUESTS_TABLE,
                    Key: { request_id: requestId },
                    UpdateExpression: 'SET #status = :status, processed_at = :processed_at, admin_note = :admin_note',
                    ExpressionAttributeNames: { '#status': 'status' },
                    ExpressionAttributeValues: {
                        ':status': 'rejected',
                        ':processed_at': new Date().toISOString(),
                        ':admin_note': reason || 'Rejected by admin'
                    }
                }));

                // 업데이트된 데이터 조회
                const { Item } = await dynamodb.send(new GetCommand({
                    TableName: CREATOR_REQUESTS_TABLE,
                    Key: { request_id: requestId }
                }));

                return { statusCode: 200, headers, body: JSON.stringify({ message: 'Request rejected', data: Item }) };
            } catch (error) {
                console.error('[REJECT] Update Error:', error);
                return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to reject request', details: error.message }) };
            }
        }
        
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Endpoint Not Found', path }) };

    } catch (e) {
        console.error('[HANDLER] Error:', e);
        return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
};
