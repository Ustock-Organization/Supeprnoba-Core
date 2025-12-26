// symbol-manager Lambda (Supernoba-admin)
// Source of Truth: Supabase (symbols table)
// Cache: Redis (active:symbols, depth:*)

import Redis from 'ioredis';
import { createClient } from '@supabase/supabase-js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ScanCommand, DeleteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import pg from 'pg';
const { Pool } = pg;

// === Configuration (ALL FROM ENVIRONMENT VARIABLES) ===
// Required
const VALKEY_HOST = process.env.VALKEY_HOST;
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT || '6379');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;                    // Anon Key (Read)
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // Service Role (Write)
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

// RDS Config
const DB_SECRET_ARN = process.env.DB_SECRET_ARN;
const RDS_ENDPOINT = process.env.RDS_ENDPOINT;
const DB_NAME = process.env.DB_NAME || 'postgres';
const secretsManager = new SecretsManagerClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });

// Helper: Create Partitions on RDS (trade_history + candle_history)
async function ensureRdsPartition(symbol) {
    if (!DB_SECRET_ARN || !RDS_ENDPOINT) { 
        console.warn('Skipping RDS Partition creation (Missing Config)');
        return;
    }
    
    let client = null;
    try {
        // 1. Get Secret
        const secretRes = await secretsManager.send(new GetSecretValueCommand({ SecretId: DB_SECRET_ARN }));
        const creds = JSON.parse(secretRes.SecretString);
        
        // 2. Connect
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
        
        // 3. Create Partitions (trade_history + candle_history)
        const cleanSymbol = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
        
        const sql = `
            -- Trade History 마스터 테이블
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
            ) PARTITION BY LIST (symbol);
            
            -- Trade History 파티션
            CREATE TABLE IF NOT EXISTS public.trade_history_${cleanSymbol} 
            PARTITION OF public.trade_history 
            FOR VALUES IN ('${cleanSymbol}');
            
            -- Candle History 마스터 테이블
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
            ) PARTITION BY LIST (symbol);
            
            -- Candle History 파티션
            CREATE TABLE IF NOT EXISTS public.candle_history_${cleanSymbol} 
            PARTITION OF public.candle_history 
            FOR VALUES IN ('${cleanSymbol}');
        `;
        
        await client.query(sql);
        console.log(`[RDS] Partitions created for ${cleanSymbol} (trade_history + candle_history)`);
        
    } catch (err) {
        console.error(`[RDS] Partition creation failed for ${symbol}:`, err);
        // Do not crash the Lambda, just log.
    } finally {
        if (client) await client.end();
    }
}

// Optional (with defaults)
const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-2';
const DYNAMODB_CANDLE_TABLE = process.env.DYNAMODB_TABLE || 'candle_history';
const S3_BUCKET = process.env.S3_BUCKET || 'supernoba-market-data';

// Validate Required Config
if (!VALKEY_HOST || !SUPABASE_URL || !SUPABASE_KEY || !SUPABASE_SERVICE_KEY || !ADMIN_API_KEY) {
    console.error('Missing required environment variables!');
    console.error('Required: VALKEY_HOST, SUPABASE_URL, SUPABASE_KEY, SUPABASE_SERVICE_ROLE_KEY, ADMIN_API_KEY');
}

const valkey = new Redis({
  host: VALKEY_HOST,
  port: VALKEY_PORT,
  tls: {}, // Enable TLS for ElastiCache (TransitEncryptionEnabled=true)
  connectTimeout: 5000,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});

valkey.on('error', (err) => console.error('Redis error:', err.message));

// Clients
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// DynamoDB & S3 (For Reset Logic)
const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: AWS_REGION })
);
const s3 = new S3Client({ region: AWS_REGION });

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

// Admin Check
function isAdmin(event) {
  const authHeader = event.headers?.Authorization || event.headers?.authorization;
  if (authHeader !== ADMIN_API_KEY) {
      console.log(`[AUTH FAIL] Expected: '${ADMIN_API_KEY}', Got: '${authHeader}'`);
      console.log('[AUTH FAIL] All Headers:', JSON.stringify(event.headers));
      return false;
  }
  return true; 
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

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS' || event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  
  const method = event.httpMethod || event.requestContext?.http?.method;
  const path = event.path || event.requestContext?.http?.path || '/';
  const pathParams = event.pathParameters || {};
  const queryParams = event.queryStringParameters || {};
  const symbolParam = pathParams.symbol;

  try {
    // === GET /symbols (List & Search & Preview) ===
    if (method === 'GET' && !symbolParam && !path.includes('/sync') && !path.includes('/approve')) {
       // Check for Preview Action
       if (queryParams.action === 'preview' && queryParams.url) {
           const url = queryParams.url;
           try {
                console.log(`[PREVIEW] Fetching: ${url}`);
                if (!url.startsWith('http')) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid URL' }) };

                // Use helper to detect platform
                const platform = detectPlatform(url);
                
                // DEBUG LOGS
                console.log(`[PREVIEW] Platform: ${platform}`);
                console.log(`[PREVIEW] Env Check - YouTube: ${!!process.env.YOUTUBE_API_KEY}, X: ${!!process.env.TWITTER_BEARER_TOKEN}`);

                let image = null;
                let title = null;
                let errorDetails = null;

                // 1. YouTube Data API
                if (platform === 'YOUTUBE' && process.env.YOUTUBE_API_KEY) {
                    console.log('[PREVIEW] Attempting YouTube API...');
                    try {
                        let handle = null;
                        let channelId = null;
                        if (url.includes('@')) {
                            const parts = url.split('@');
                            handle = parts[parts.length - 1].split('/')[0];
                        } else if (url.includes('channel/')) {
                             channelId = url.split('channel/')[1].split('/')[0];
                        }

                        if (handle || channelId) {
                             const ytKey = process.env.YOUTUBE_API_KEY;
                             let ytUrl = '';
                             if (handle) {
                                 ytUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet&forHandle=@${handle}&key=${ytKey}`;
                             } else {
                                 ytUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${channelId}&key=${ytKey}`;
                             }
                             
                             const ytRes = await fetch(ytUrl);
                             const ytData = await ytRes.json();
                             if (ytData.items && ytData.items.length > 0) {
                                 image = ytData.items[0].snippet.thumbnails.high?.url || ytData.items[0].snippet.thumbnails.default?.url;
                                 title = ytData.items[0].snippet.title;
                                 console.log('[PREVIEW] YouTube API Success');
                             } else {
                                 console.log('[PREVIEW] YouTube API found no items');
                             }
                        }
                    } catch (err) {
                        console.error('[PREVIEW] YouTube API Error:', err);
                        errorDetails = err.message;
                    }
                }

                // 2. X (Twitter) API v2
                if (platform === 'X' && process.env.TWITTER_BEARER_TOKEN) {
                    console.log('[PREVIEW] Attempting X (Twitter) API...');
                    try {
                        const parts = url.split('/');
                        const username = parts[parts.length - 1].split('?')[0]; 
                        
                        if (username) {
                             console.log(`[PREVIEW] X Username extracted: ${username}`);
                             const xRes = await fetch(`https://api.twitter.com/2/users/by/username/${username}?user.fields=profile_image_url,name`, {
                                 headers: {
                                     'Authorization': `Bearer ${process.env.TWITTER_BEARER_TOKEN}`
                                 }
                             });
                             
                             if (!xRes.ok) {
                                 const errText = await xRes.text();
                                 console.error(`[PREVIEW] X API Failed: ${xRes.status} ${errText}`);
                                 errorDetails = `X API ${xRes.status}: ${errText}`;
                             } else {
                                 const xData = await xRes.json();
                                 if (xData.data) {
                                     image = xData.data.profile_image_url?.replace('_normal', '_400x400');
                                     title = xData.data.name;
                                     console.log('[PREVIEW] X API Success');
                                 } else {
                                    console.log('[PREVIEW] X API returned no data');
                                 }
                             }
                        }
                    } catch (err) {
                         console.error('[PREVIEW] X API Error:', err);
                         errorDetails = err.message;
                    }
                }

                if (!image) {
                     console.log('[PREVIEW] No API result or Platform not supported. Skipping scraping (Strict Mode).');
                }
                
                return { 
                    statusCode: 200, 
                    headers, 
                    body: JSON.stringify({ 
                        url, 
                        title: title || '', 
                        image: image || '', 
                        debug_error: errorDetails,
                        debug_logs: `PF:${platform}, YT:${!!process.env.YOUTUBE_API_KEY}, X:${!!process.env.TWITTER_BEARER_TOKEN}`
                    }) 
                };
           } catch (e) {
               console.error('[PREVIEW] Error:', e.message);
               return { statusCode: 200, headers, body: JSON.stringify({ url, image: '' }) };
           }
       }
    
       const q = queryParams.q;
       let query = supabase.from('symbols').select('*');
       if (q) query = query.or(`symbol.ilike.%${q}%,name.ilike.%${q}%`);
       

       
       const { data: symbols, error } = await query;
       if (error) throw error;
       
       return {
           statusCode: 200, headers,
           body: JSON.stringify({ symbols, count: symbols?.length || 0, source: 'supabase' })
       };
    }

    // === GET /symbols/{symbol} ===
    if (method === 'GET' && symbolParam) {
       const { data: symData } = await supabase.from('symbols').select('*').eq('symbol', symbolParam.toUpperCase()).single();
       const exists = await valkey.sismember('active:symbols', symbolParam.toUpperCase());
       if (!exists && !symData) {
           return { statusCode: 404, headers, body: JSON.stringify({ error: 'Symbol not found' }) };
       }
       const [ticker, depth] = await Promise.all([
         valkey.get(`ticker:${symbolParam.toUpperCase()}`),
         valkey.get(`depth:${symbolParam.toUpperCase()}`),
       ]);
       return {
           statusCode: 200, headers,
           body: JSON.stringify({
               symbol: symbolParam.toUpperCase(),
               meta: symData,
               active: !!exists,
               ticker: ticker ? JSON.parse(ticker) : null,
               depth: depth ? JSON.parse(depth) : null,
           })
       };
    }
    
    // === POST /sync (Hydrate Redis) ===
    if (method === 'POST' && path.includes('sync')) {
        const { data: allSymbols } = await supabase.from('symbols').select('symbol');
        let count = 0;
        if (allSymbols?.length > 0) {
            const pipeline = valkey.pipeline();
            allSymbols.forEach(s => pipeline.sadd('active:symbols', s.symbol));
            await pipeline.exec();
            count = allSymbols.length;
        }
        return { statusCode: 200, headers, body: JSON.stringify({ message: 'Synced', count }) };
    }



    // === POST /approve (Admin Approval) ===
    // Support both path-based (/approve) and query-based (?action=approve)
    if (method === 'POST' && (path.includes('approve') || queryParams.action === 'approve')) {
        const body = JSON.parse(event.body || '{}');
        const { requestId, symbol, name, logo_url } = body;
        
        console.log(`[APPROVE] Processing: ${symbol}, ReqID: ${requestId}`);
        
        if (!symbol || !name) return { statusCode: 400, headers, body: JSON.stringify({error: 'Missing fields'}) };

        // DEBUG: Check if using Service Role Key
        const usingServiceKey = !!process.env.SUPABASE_SERVICE_ROLE_KEY;
        console.log(`[APPROVE] Using Service Role Key: ${usingServiceKey}`);
        console.log(`[APPROVE] RequestId: ${requestId}, Symbol: ${symbol}, Name: ${name}`);

        // 1. Update Request (Using Admin Client to bypass RLS)
        if (requestId) {
             // Fetch Creator URL to detect platform
             const { data: currentReq } = await supabaseAdmin
                .from('creator_requests')
                .select('creator_url')
                .eq('id', requestId)
                .single();
                
             let detectedPlatform = 'ETC';
             if (currentReq?.creator_url) {
                 detectedPlatform = detectPlatform(currentReq.creator_url);
             }

             const { data: reqData, error: reqErr } = await supabaseAdmin
                .from('creator_requests')
                .update({ 
                    status: 'approved', // Lowercase fixed
                    platform: detectedPlatform // Update platform
                })
                .eq('id', requestId)
                .select();
                
             if (reqErr) {
                 console.error('[APPROVE] Request Update Error:', reqErr);
                 return { 
                     statusCode: 500, 
                     headers, 
                     body: JSON.stringify({ 
                         error: 'Failed to update request status', 
                         details: reqErr,
                         debug: { usingServiceKey, requestId }
                     }) 
                 };
             }
        }

        // 2. Insert Symbol (Using Admin Client)
        const newSymbol = {
            symbol: symbol.toUpperCase(),
            name, 
            base_asset: symbol.toUpperCase(), 
            quote_asset: 'BOLT', 
            logo_url, 
            status: 'ACTIVE'
        };
        
        const { error: symErr } = await supabaseAdmin.from('symbols').upsert(newSymbol);
        
        if (symErr) {
            console.error('[APPROVE] Symbol Insert Error:', symErr);
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to insert symbol', details: symErr }) };
        }

        // 3. Add to Redis
        await valkey.sadd('active:symbols', newSymbol.symbol);
        
        // 4. Create RDS Partition (Async/fire-and-forget to keep latency low, or await if critical)
        await ensureRdsPartition(newSymbol.symbol);
        
        console.log('[APPROVE] Success');
        
        return { statusCode: 200, headers, body: JSON.stringify({ message: 'Approved, Symbol Created, Redis Updated', symbol: newSymbol }) };
    }

    // === POST /reject (Admin Rejection) ===
    if (method === 'POST' && (path.includes('reject') || queryParams.action === 'reject')) {
        if (!isAdmin(event)) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };
        
        const body = JSON.parse(event.body || '{}');
        const { requestId, reason } = body;
        
        console.log(`[REJECT] Processing: RequestId: ${requestId}, Reason: ${reason}`);
        
        if (!requestId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'requestId is required' }) };
        
        const { data, error } = await supabaseAdmin
            .from('creator_requests')
            .update({ 
                status: 'rejected',
                processed_at: new Date().toISOString(),
                admin_note: reason || 'Rejected by admin'
            })
            .eq('id', requestId)
            .select();
        
        if (error) {
            console.error('[REJECT] Update Error:', error);
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to reject request', details: error }) };
        }
        
        console.log('[REJECT] Success');
        return { statusCode: 200, headers, body: JSON.stringify({ message: 'Request rejected', data }) };
    }


    // === POST /symbols (Manual Add or Reset or Request) ===
    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      
      // 1. Public Request Submission
      const action = body.action || queryParams.action;
      if (action === 'request') {
          const { creator_name, creator_url, platform, logo_url } = body;
          if (!creator_url) return { statusCode: 400, headers, body: JSON.stringify({ error: 'URL is required' }) };
          
          console.log(`[REQUEST] New submission: ${creator_name} (${creator_url})`);
          
          const { data, error } = await supabaseAdmin
            .from('creator_requests')
            .insert({ creator_name, creator_url, platform, logo_url, status: 'pending' })
            .select().single();
            
          if (error) {
              console.error('[REQUEST] Insert Error:', error);
              return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
          }
          return { statusCode: 200, headers, body: JSON.stringify({ message: 'Request submitted', data }) };
      }

      // 2. Admin Actions (Reset / Add)
      if (!isAdmin(event)) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };
      
      if (body.action === 'resetDatabase') {
          return { statusCode: 200, headers, body: JSON.stringify({ message: 'Reset functionality is temporarily disabled during migration check.' }) };
      }
      
      const { symbol, name, logo_url } = body;
      if (!symbol) return { statusCode: 400, headers, body: JSON.stringify({error: 'symbol required'}) };
      
      const newSymbol = {
          symbol: symbol.toUpperCase(),
          name: name || symbol, base_asset: symbol.toUpperCase(), quote_asset: 'BOLT', logo_url, status: 'ACTIVE'
      };
      
      const { error } = await supabaseAdmin.from('symbols').upsert(newSymbol);
      if (error) throw error;
      
      
      await valkey.sadd('active:symbols', newSymbol.symbol);
      
      // Create RDS Partition
      await ensureRdsPartition(newSymbol.symbol);
      
      return { statusCode: 201, headers, body: JSON.stringify({ message: 'Symbol added', symbol: newSymbol }) };

    }

    // === DELETE /symbols/{symbol} ===
    // === DELETE /symbols (Support both Path and Body) ===
    if (method === 'DELETE') {
        if (!isAdmin(event)) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };
        
        let targetSymbol = symbolParam;
        if (!targetSymbol) {
            try {
                const body = JSON.parse(event.body || '{}');
                targetSymbol = body.symbol;
            } catch (e) {}
        }

        if (targetSymbol) {
             await supabaseAdmin.from('symbols').delete().eq('symbol', targetSymbol.toUpperCase());
             await valkey.srem('active:symbols', targetSymbol.toUpperCase());
             return { statusCode: 200, headers, body: JSON.stringify({ message: 'Deleted', symbol: targetSymbol }) };
        }
    }
    
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not Found' }) };

  } catch (error) {
    console.error('Admin/Symbol Error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message, details: error }) };
  }
};
