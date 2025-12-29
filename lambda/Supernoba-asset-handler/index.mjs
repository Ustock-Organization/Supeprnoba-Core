import { createClient } from '@supabase/supabase-js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

// DynamoDB Client
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const ddb = DynamoDBDocumentClient.from(dynamoClient);
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'supernoba-orders';
const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';
const HOLDINGS_TABLE = process.env.HOLDINGS_TABLE || 'supernoba-holdings';

// === Configuration ===
const HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,x-api-key",
    "Access-Control-Allow-Methods": "OPTIONS,GET"
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

// Lazy initialization
let supabase = null;
function getSupabase() {
    if (!supabase) {
        if (!SUPABASE_URL || !SUPABASE_KEY) {
            console.error("Missing Supabase Credentials");
            throw new Error("Internal Server Error: Missing DB Config");
        }
        supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    }
    return supabase;
}

export const handler = async (event) => {
    // console.log("Event:", JSON.stringify(event));
    
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: HEADERS, body: '' };
    }

    const { httpMethod, path, queryStringParameters, pathParameters } = event;
    const userId = queryStringParameters?.userId;
    const symbolParam = pathParameters?.symbol || (path.includes('/symbols/') ? path.split('/symbols/')[1] : null);

    // symbols 엔드포인트는 userId 불필요
    if (path.includes('/symbols')) {
        try {
            if (httpMethod === 'GET') {
                if (symbolParam) {
                    return await getSymbolInfo(symbolParam);
                } else {
                    return await getAllSymbols();
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
        if (httpMethod === 'GET') {
            const client = getSupabase();
            
            if (path.includes('/assets')) {
                return await getUserAssets(client, userId);
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

async function getUserAssets(supabase, userId) {
    // 1. Fetch BOLT wallet from Supabase (잔고만)
    const { data: wallets, error } = await supabase
        .from('wallets')
        .select('*')
        .eq('user_id', userId)
        .eq('currency', 'BOLT');

    if (error) throw error;

    // 2. Initialize if empty (Auto-Init Strategy)
    let balance = { available: 0, locked: 0, total: 0, currency: 'BOLT' };
    if (!wallets || wallets.length === 0) {
        console.log(`[UserId: ${userId}] No BOLT wallet found. Initializing default BOLT wallet.`);
        const { data: newWallet, error: initError } = await supabase
            .from('wallets')
            .insert({
                user_id: userId,
                currency: 'BOLT',
                available: 10000000, // 10 Million BOLT Airdrop
                locked: 0
            })
            .select()
            .single();

        if (initError) {
             console.error("Wallet Init Failed:", initError);
             throw initError;
        }
        
        balance = {
            available: Number(newWallet.available),
            locked: Number(newWallet.locked),
            total: Number(newWallet.available) + Number(newWallet.locked),
            currency: 'BOLT'
        };
    } else {
        const w = wallets[0];
        balance = {
            available: Number(w.available),
            locked: Number(w.locked),
            total: Number(w.available) + Number(w.locked),
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
        return {
            symbol: item.symbol,
            quantity: quantity,
            available: quantity - locked,
            locked: locked,
            avgPrice: Number(item.avgPrice || 0)
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
            quantity: item.quantity,
            filled_qty: item.filled_qty || item.quantity,
            status: item.status,
            created_at: item.created_at,
            updated_at: item.updated_at,
            timestamp: item.updated_at || item.created_at // 체결 시간으로 updated_at 사용
        }));
        
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

// DynamoDB에서 종목 정보 조회
async function getSymbolInfo(symbol) {
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
        
        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({
                symbol: result.Item.symbol,
                name: result.Item.name || result.Item.symbol,
                logo_url: result.Item.logo_url || null,
                status: result.Item.status || 'ACTIVE'
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

// 모든 활성 종목 조회 (DynamoDB에서 조회)
async function getAllSymbols() {
    try {
        const result = await ddb.send(new ScanCommand({
            TableName: SYMBOLS_TABLE,
            FilterExpression: '#status = :active',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':active': 'ACTIVE' }
        }));
        
        const symbols = (result.Items || []).map(item => ({
            symbol: item.symbol,
            name: item.name || item.symbol,
            logo_url: item.logo_url || null,
            status: item.status || 'ACTIVE'
        }));
        
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
