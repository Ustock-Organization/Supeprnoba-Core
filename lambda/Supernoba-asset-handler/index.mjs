import { createClient } from '@supabase/supabase-js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

// DynamoDB Client
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const ddb = DynamoDBDocumentClient.from(dynamoClient);
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'supernoba-orders';

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

    const { httpMethod, path, queryStringParameters } = event;
    const userId = queryStringParameters?.userId;

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
    // 1. Fetch all wallets for user
    const { data: wallets, error } = await supabase
        .from('wallets')
        .select('*')
        .eq('user_id', userId);

    if (error) throw error;

    // 2. Initialize if empty (Auto-Init Strategy)
    if (!wallets || wallets.length === 0) {
        console.log(`[UserId: ${userId}] No wallets found. Initializing default BOLT wallet.`);
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
        
        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({
                balance: { 
                    available: newWallet.available, 
                    locked: newWallet.locked, 
                    total: newWallet.available + newWallet.locked, 
                    currency: 'BOLT' 
                },
                holdings: [] 
            })
        };
    }

    // 3. Format Response
    let balance = { available: 0, locked: 0, total: 0, currency: 'BOLT' };
    let holdings = [];

    wallets.forEach(w => {
        const total = Number(w.available) + Number(w.locked);
        if (w.currency === 'BOLT') {
            balance = {
                available: Number(w.available),
                locked: Number(w.locked),
                total: total,
                currency: 'KRW'
            };
        } else {
            holdings.push({
                symbol: w.currency,
                quantity: total, // For simplicity in UI, show Total Qty? Or Available?
                // Frontend 'Info.js' expects 'quantity'
                // Let's verify what UI expects. Usually Available + Locked.
                available: Number(w.available),
                locked: Number(w.locked),
                avgPrice: 0,     // Supabase doesn't have avgPrice in 'wallets'. Need 'positions' table? 
                                 // For now, return 0. (AvgPrice needs a separate table or calculation)
                currentPrice: 0, 
                valuation: 0     
            });
        }
    });
    
    // Compatibility: Map 'holdings' quantity to total
    holdings = holdings.map(h => ({ ...h, quantity: h.available + h.locked }));

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
        user_id: item.user_id,
        symbol: item.symbol,
        side: item.side,
        type: item.type,
        price: item.price,
        quantity: item.quantity,
        filled_qty: item.filled_qty || 0,
        status: item.status,
        created_at: item.created_at,
        updated_at: item.updated_at
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
            updated_at: item.updated_at
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
