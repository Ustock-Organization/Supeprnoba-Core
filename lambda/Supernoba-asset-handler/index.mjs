import { createClient } from '@supabase/supabase-js';

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
                return await getOrderHistory(client, userId);
            } else if (path.includes('/trades')) {
                return await getTradeHistory(client, userId); // Optional/TODO
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

async function getOrderHistory(supabase, userId) {
    const { data: orders, error } = await supabase
        .from('orders')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50); // Limit 50

    if (error) throw error;
    
    // Enhance or map fields if necessary
    // Supabase has snake_case, JS uses snake_case usually for this project based on prev code
    
    return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ orders: orders || [] })
    };
}

async function getTradeHistory(supabase, userId) {
    // Current SQL plan didn't have 'fills' table explicitly separate from ledger, 
    // but we can query 'ledger' for reason='FILL' or just return empty for now.
    // Or users might expect executed orders.
    
    // Let's return FILLED orders for now (Simple MVP)
    const { data: trades, error } = await supabase
        .from('orders')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'FILLED')
        .order('updated_at', { ascending: false });

    if (error) throw error;

    return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ trades: trades || [] })
    };
}
