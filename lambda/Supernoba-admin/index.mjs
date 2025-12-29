
import Redis from 'ioredis';
import { createClient } from '@supabase/supabase-js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ScanCommand, GetCommand, DeleteCommand, PutCommand, UpdateCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// === Configuration ===
const VALKEY_HOST = process.env.VALKEY_HOST;
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT || '6379');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; 
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-2';

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

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }));
const SYMBOLS_TABLE = process.env.SYMBOLS_TABLE || 'supernoba-symbols';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

// Helper: Detect Platform (Used in Request)
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

    try {
        const path = event.path || '';
        const method = event.httpMethod;
        const queryParams = event.queryStringParameters || {};
        
        // Extract Symbol from path if present
        const pathParts = path.split('/').filter(p => p);
        let symbolParam = null;

        // Ignore base path parts (admin, Supernoba-admin, symbols, etc.)
        const basePaths = ['admin', 'supernoba-admin', 'symbols', 'sync', 'request', 'approve', 'reject'];
        const relevantParts = pathParts.filter(p => !basePaths.includes(p.toLowerCase()));

        if (relevantParts.length > 0) {
            symbolParam = relevantParts[relevantParts.length - 1];
        }
        
        // === POST /sync (Hydrate Redis) ===
        if (method === 'POST' && path.includes('sync')) {
             if (!isAdmin(event)) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

             console.log('[SYNC] Starting Redis hydration...');
             const { Items } = await dynamodb.send(new ScanCommand({ TableName: SYMBOLS_TABLE }));
             
             if (Items && Items.length > 0) {
                 const pipeline = valkey.pipeline();
                 pipeline.del('active:symbols');
                 
                 for (const item of Items) {
                     if (item.status === 'ACTIVE') {
                         pipeline.sadd('active:symbols', item.symbol);
                         pipeline.set(`ticker:${item.symbol}`, JSON.stringify({
                             symbol: item.symbol,
                             price: item.listingPrice || 0,
                             changePercent: 0,
                             volume: 0,
                             high: 0,
                             low: 0
                         }));
                     }
                 }
                 await pipeline.exec();
                 console.log(`[SYNC] Hydrated ${Items.length} symbols.`);
                 return { statusCode: 200, headers, body: JSON.stringify({ message: `Synced ${Items.length} symbols` }) };
             }
             return { statusCode: 200, headers, body: JSON.stringify({ message: 'No symbols to sync' }) };
        }

        // === GET /symbols (List & Search) ===
        if (method === 'GET' && !symbolParam && !path.includes('sync')) {
             // Check if requesting creator_requests
             if (queryParams.type === 'requests') {
                 if (!isAdmin(event)) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

                 const status = queryParams.status || 'pending';
                 const { data, error } = await supabaseAdmin
                     .from('creator_requests')
                     .select('*')
                     .eq('status', status)
                     .order('created_at', { ascending: true });

                 if (error) {
                     console.error('[REQUESTS] Fetch error:', error);
                     return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to fetch requests', details: error.message }) };
                 }

                 return { statusCode: 200, headers, body: JSON.stringify(data || []) };
             }

             // Check if requesting auth check
             if (queryParams.type === 'auth') {
                 const userId = queryParams.userId;
                 const twitterUsername = queryParams.twitterUsername;
                 const googleEmail = queryParams.googleEmail;

                 if (!userId && !twitterUsername && !googleEmail) {
                     return { statusCode: 400, headers, body: JSON.stringify({ error: 'userId, twitterUsername, or googleEmail required' }) };
                 }

                 try {
                     let isAdminUser = false;
                     let userData = null;

                     // Check by user ID first (for existing admin users in DB)
                     if (userId) {
                         const { data, error } = await supabaseAdmin
                             .from('user_profiles')
                             .select('id, username, email, is_admin')
                             .eq('id', userId)
                             .single();

                         if (!error && data) {
                             isAdminUser = data.is_admin === true;
                             userData = data;
                         }
                     }

                     // Check by Twitter username - @tchinnom is admin
                     if (twitterUsername && !isAdminUser) {
                         const cleanUsername = twitterUsername.replace('@', '').toLowerCase();
                         isAdminUser = (cleanUsername === 'tchinnom');

                         if (userId && isAdminUser) {
                             await supabaseAdmin
                                 .from('user_profiles')
                                 .upsert({
                                     id: userId,
                                     username: cleanUsername,
                                     is_admin: true,
                                     updated_at: new Date().toISOString()
                                 }, { onConflict: 'id' });
                         }
                     }

                     // Check by Google email - specific emails are admin
                     if (googleEmail && !isAdminUser) {
                         const cleanEmail = googleEmail.toLowerCase();
                         // Allowed Google admin emails
                         const allowedGoogleAdmins = [
                             'tchinnom@gmail.com',
                             'admin@supernoba.com'
                         ];
                         isAdminUser = allowedGoogleAdmins.includes(cleanEmail);

                         if (userId && isAdminUser) {
                             await supabaseAdmin
                                 .from('user_profiles')
                                 .upsert({
                                     id: userId,
                                     email: cleanEmail,
                                     is_admin: true,
                                     updated_at: new Date().toISOString()
                                 }, { onConflict: 'id' });
                         }
                     }

                     return {
                         statusCode: 200,
                         headers,
                         body: JSON.stringify({ isAdmin: isAdminUser, user: userData })
                     };
                 } catch (e) {
                     console.error('[AUTH CHECK] Error:', e);
                     return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
                 }
             }

             const q = queryParams.q ? queryParams.q.toUpperCase() : null;
             const { Items } = await dynamodb.send(new ScanCommand({ TableName: SYMBOLS_TABLE }));
             let results = Items || [];

             if (q) {
                 results = results.filter(s => s.symbol.includes(q) || (s.name && s.name.toUpperCase().includes(q)));
             }

             return { statusCode: 200, headers, body: JSON.stringify(results) };
        }

        // === GET /symbols/{symbol} (Detail) ===
        if (method === 'GET' && symbolParam) {
            const { Item } = await dynamodb.send(new GetCommand({
                TableName: SYMBOLS_TABLE,
                Key: { symbol: symbolParam.toUpperCase() }
            }));
            
            if (!Item) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Symbol not found' }) };
            return { statusCode: 200, headers, body: JSON.stringify(Item) };
        }

        // === POST /symbols (Request Listing or Admin Direct Add) ===
        if (method === 'POST' && !path.includes('sync')) {
             const body = JSON.parse(event.body || '{}');
             const action = body.action || queryParams.action;

             // Admin direct login
             if (queryParams.type === 'auth') {
                 const { email, password } = body;

                 // Direct admin credentials check
                 if (email === 'admin' && password === 'Shworms747**') {
                     try {
                         const adminEmail = 'admin@supernoba.com';

                         // Try to sign in first
                         const { data: signInData, error: signInError } = await supabaseAdmin.auth.signInWithPassword({
                             email: adminEmail,
                             password: password
                         });

                         if (signInError) {
                             // If user doesn't exist, create them
                             if (signInError.message.includes('Invalid login credentials')) {
                                 const { data: signUpData, error: signUpError } = await supabaseAdmin.auth.admin.createUser({
                                     email: adminEmail,
                                     password: password,
                                     email_confirm: true,
                                     user_metadata: { full_name: 'Admin', is_admin: true }
                                 });

                                 if (signUpError) {
                                     console.error('[AUTH] Create admin user error:', signUpError);
                                     return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to create admin user', details: signUpError.message }) };
                                 }

                                 // Update profile with admin flag
                                 await supabaseAdmin
                                     .from('user_profiles')
                                     .upsert({
                                         id: signUpData.user.id,
                                         username: 'admin',
                                         email: adminEmail,
                                         is_admin: true,
                                         updated_at: new Date().toISOString()
                                     }, { onConflict: 'id' });

                                 // Sign in with new account
                                 const { data: newSignIn, error: newSignInError } = await supabaseAdmin.auth.signInWithPassword({
                                     email: adminEmail,
                                     password: password
                                 });

                                 if (newSignInError) {
                                     return { statusCode: 401, headers, body: JSON.stringify({ error: 'Auth failed after create' }) };
                                 }

                                 return {
                                     statusCode: 200,
                                     headers,
                                     body: JSON.stringify({
                                         success: true,
                                         session: newSignIn.session,
                                         user: newSignIn.user,
                                         isAdmin: true
                                     })
                                 };
                             }
                             return { statusCode: 401, headers, body: JSON.stringify({ error: signInError.message }) };
                         }

                         // Ensure admin flag is set
                         await supabaseAdmin
                             .from('user_profiles')
                             .upsert({
                                 id: signInData.user.id,
                                 username: 'admin',
                                 email: adminEmail,
                                 is_admin: true,
                                 updated_at: new Date().toISOString()
                             }, { onConflict: 'id' });

                         return {
                             statusCode: 200,
                             headers,
                             body: JSON.stringify({
                                 success: true,
                                 session: signInData.session,
                                 user: signInData.user,
                                 isAdmin: true
                             })
                         };
                     } catch (e) {
                         console.error('[AUTH LOGIN] Error:', e);
                         return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
                     }
                 }

                 return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid credentials' }) };
             }

             // User request for listing
             if (action === 'request') {
                  const { creator_name, creator_url, logo_url } = body;
                  if (!creator_url) return { statusCode: 400, headers, body: JSON.stringify({ error: 'URL is required' }) };

                  const detected = detectPlatform(creator_url);
                  const { data, error } = await supabaseAdmin
                      .from('creator_requests')
                      .insert([{
                          creator_name: creator_name || 'Unknown',
                          creator_url,
                          logo_url: logo_url || '',
                          status: 'pending',
                          platform: detected
                      }])
                      .select();

                  if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: 'DB Error', details: error }) };
                  return { statusCode: 201, headers, body: JSON.stringify({ message: 'Request submitted', data }) };
             }

             // Admin approve creator request
             if (action === 'approve') {
                  if (!isAdmin(event)) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

                  const { requestId, symbol, name, logo_url, base_asset } = body;
                  if (!requestId || !symbol) {
                      return { statusCode: 400, headers, body: JSON.stringify({ error: 'requestId and symbol are required' }) };
                  }

                  // Get the request from Supabase
                  const { data: request, error: fetchError } = await supabaseAdmin
                      .from('creator_requests')
                      .select('*')
                      .eq('id', requestId)
                      .single();

                  if (fetchError || !request) {
                      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Request not found' }) };
                  }

                  const symbolUpper = symbol.toUpperCase();
                  const now = new Date().toISOString();
                  const detectedPlatform = request.platform || detectPlatform(request.creator_url);

                  // Check if symbol already exists
                  const { Item: existing } = await dynamodb.send(new GetCommand({
                      TableName: SYMBOLS_TABLE,
                      Key: { symbol: symbolUpper }
                  }));

                  if (existing) {
                      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Symbol already exists', symbol: symbolUpper }) };
                  }

                  // Create new symbol in DynamoDB
                  const newSymbol = {
                      symbol: symbolUpper,
                      name: name || request.creator_name || symbolUpper,
                      base_asset: base_asset || symbolUpper,
                      quote_asset: 'BOLT',
                      status: 'ACTIVE',
                      listingDate: now,
                      listingPrice: 0,
                      delistingDate: null,
                      platform: detectedPlatform,
                      creatorUrl: request.creator_url || '',
                      profileUrl: `/creator/${symbolUpper}`,
                      logoUrl: logo_url || request.logo_url || '',
                      marketCap: 0,
                      totalSupply: 0,
                      circulatingSupply: 0,
                      volume24h: 0,
                      priceChange24h: 0,
                      allTimeHigh: 0,
                      allTimeLow: 0,
                      platformStats: { subscribers: 0, followers: 0, views: 0, videos: 0, lastUpdated: null },
                      tags: [],
                      categories: [],
                      verified: false,
                      trustScore: 5,
                      userRating: 0,
                      ratingCount: 0,
                      description: `Official symbol for ${name || request.creator_name || symbolUpper}`
                  };

                  await dynamodb.send(new PutCommand({
                      TableName: SYMBOLS_TABLE,
                      Item: newSymbol
                  }));

                  // Add to Valkey
                  await valkey.sadd('active:symbols', symbolUpper);
                  await valkey.set(`ticker:${symbolUpper}`, JSON.stringify({
                      symbol: symbolUpper,
                      price: 0,
                      changePercent: 0,
                      volume: 0,
                      high: 0,
                      low: 0
                  }));

                  // Update request status in Supabase
                  await supabaseAdmin
                      .from('creator_requests')
                      .update({ status: 'approved', processed_at: now, admin_note: `Approved as ${symbolUpper}` })
                      .eq('id', requestId);

                  console.log(`[ADMIN] Approved request ${requestId} as symbol: ${symbolUpper}`);
                  return { statusCode: 201, headers, body: JSON.stringify({ message: 'Approved', symbol: newSymbol }) };
             }

             // Admin reject creator request
             if (action === 'reject') {
                  if (!isAdmin(event)) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

                  const { requestId, reason } = body;
                  if (!requestId) {
                      return { statusCode: 400, headers, body: JSON.stringify({ error: 'requestId is required' }) };
                  }

                  const now = new Date().toISOString();

                  const { error } = await supabaseAdmin
                      .from('creator_requests')
                      .update({ status: 'rejected', processed_at: now, admin_note: reason || 'Rejected by admin' })
                      .eq('id', requestId);

                  if (error) {
                      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to reject', details: error }) };
                  }

                  console.log(`[ADMIN] Rejected request ${requestId}`);
                  return { statusCode: 200, headers, body: JSON.stringify({ message: 'Rejected' }) };
             }

             // Admin direct add (no action or action=add)
             if (!action || action === 'add') {
                  if (!isAdmin(event)) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

                  const { symbol, name, logo_url, description, creator_url, platform } = body;

                  if (!symbol) {
                      return { statusCode: 400, headers, body: JSON.stringify({ error: 'symbol is required' }) };
                  }

                  const symbolUpper = symbol.toUpperCase();
                  const now = new Date().toISOString();
                  const detectedPlatform = platform || detectPlatform(creator_url);

                  // Check if symbol already exists
                  const { Item: existing } = await dynamodb.send(new GetCommand({
                      TableName: SYMBOLS_TABLE,
                      Key: { symbol: symbolUpper }
                  }));

                  if (existing) {
                      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Symbol already exists', symbol: symbolUpper }) };
                  }

                  const newSymbol = {
                      symbol: symbolUpper,
                      name: name || symbolUpper,
                      base_asset: symbolUpper,
                      quote_asset: 'BOLT',
                      status: 'ACTIVE',
                      listingDate: now,
                      listingPrice: 0,
                      delistingDate: null,
                      platform: detectedPlatform,
                      creatorUrl: creator_url || '',
                      profileUrl: `/creator/${symbolUpper}`,
                      logoUrl: logo_url || '',
                      marketCap: 0,
                      totalSupply: 0,
                      circulatingSupply: 0,
                      volume24h: 0,
                      priceChange24h: 0,
                      allTimeHigh: 0,
                      allTimeLow: 0,
                      platformStats: { subscribers: 0, followers: 0, views: 0, videos: 0, lastUpdated: null },
                      tags: [],
                      categories: [],
                      verified: false,
                      trustScore: 5,
                      userRating: 0,
                      ratingCount: 0,
                      description: description || `Official symbol for ${name || symbolUpper}`
                  };

                  // Save to DynamoDB
                  await dynamodb.send(new PutCommand({
                      TableName: SYMBOLS_TABLE,
                      Item: newSymbol
                  }));

                  // Add to Valkey active:symbols
                  await valkey.sadd('active:symbols', symbolUpper);

                  // Initialize ticker cache
                  await valkey.set(`ticker:${symbolUpper}`, JSON.stringify({
                      symbol: symbolUpper,
                      price: 0,
                      changePercent: 0,
                      volume: 0,
                      high: 0,
                      low: 0
                  }));

                  console.log(`[ADMIN] Symbol created: ${symbolUpper}`);
                  return { statusCode: 201, headers, body: JSON.stringify({ message: 'Symbol created', symbol: newSymbol }) };
             }

             return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action' }) };
        }

        // === PUT /symbols/{symbol} (Update Symbol) ===
        if (method === 'PUT') {
             if (!isAdmin(event)) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

             let targetSymbol = symbolParam;
             if (!targetSymbol) {
                 try {
                     const body = JSON.parse(event.body || '{}');
                     targetSymbol = body.symbol;
                 } catch (e) {}
             }

             if (!targetSymbol) {
                 return { statusCode: 400, headers, body: JSON.stringify({ error: 'symbol is required' }) };
             }

             const symbolUpper = targetSymbol.toUpperCase();
             const body = JSON.parse(event.body || '{}');
             const { name, logo_url, description, status, creator_url, platform } = body;

             // Check if symbol exists
             const { Item: existing } = await dynamodb.send(new GetCommand({
                 TableName: SYMBOLS_TABLE,
                 Key: { symbol: symbolUpper }
             }));

             if (!existing) {
                 return { statusCode: 404, headers, body: JSON.stringify({ error: 'Symbol not found' }) };
             }

             // Build update expression
             const updateExprParts = [];
             const exprAttrValues = {};
             const exprAttrNames = {};

             if (name !== undefined) {
                 updateExprParts.push('#name = :name');
                 exprAttrValues[':name'] = name;
                 exprAttrNames['#name'] = 'name';
             }
             if (logo_url !== undefined) {
                 updateExprParts.push('logoUrl = :logoUrl');
                 exprAttrValues[':logoUrl'] = logo_url;
             }
             if (description !== undefined) {
                 updateExprParts.push('description = :description');
                 exprAttrValues[':description'] = description;
             }
             if (status !== undefined) {
                 updateExprParts.push('#status = :status');
                 exprAttrValues[':status'] = status;
                 exprAttrNames['#status'] = 'status';
             }
             if (creator_url !== undefined) {
                 updateExprParts.push('creatorUrl = :creatorUrl');
                 exprAttrValues[':creatorUrl'] = creator_url;
             }
             if (platform !== undefined) {
                 updateExprParts.push('platform = :platform');
                 exprAttrValues[':platform'] = platform;
             }

             if (updateExprParts.length === 0) {
                 return { statusCode: 400, headers, body: JSON.stringify({ error: 'No fields to update' }) };
             }

             // Update DynamoDB
             await dynamodb.send(new UpdateCommand({
                 TableName: SYMBOLS_TABLE,
                 Key: { symbol: symbolUpper },
                 UpdateExpression: `SET ${updateExprParts.join(', ')}`,
                 ExpressionAttributeValues: exprAttrValues,
                 ...(Object.keys(exprAttrNames).length > 0 && { ExpressionAttributeNames: exprAttrNames })
             }));

             // Update Valkey if status changed
             if (status !== undefined) {
                 if (status === 'ACTIVE') {
                     await valkey.sadd('active:symbols', symbolUpper);
                 } else {
                     await valkey.srem('active:symbols', symbolUpper);
                 }
             }

             console.log(`[ADMIN] Symbol updated: ${symbolUpper}`);
             return { statusCode: 200, headers, body: JSON.stringify({ message: 'Symbol updated', symbol: symbolUpper }) };
        }
        
        // === DELETE /symbols/{symbol} ===
        if (method === 'DELETE') {
             if (!isAdmin(event)) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
             
             let targetSymbol = symbolParam;
             if (!targetSymbol) {
                 try {
                     const body = JSON.parse(event.body || '{}');
                     targetSymbol = body.symbol;
                 } catch (e) {}
             }
             
             if (targetSymbol) {
                 const symbolUpper = targetSymbol.toUpperCase();
                 await dynamodb.send(new DeleteCommand({
                     TableName: SYMBOLS_TABLE,
                     Key: { symbol: symbolUpper }
                 }));
                 
                 await Promise.all([
                     valkey.srem('active:symbols', symbolUpper),
                     valkey.srem('subscribed:symbols', symbolUpper),
                     valkey.del(`depth:${symbolUpper}`),
                     valkey.del(`ticker:${symbolUpper}`)
                 ]);
                 
                 return { statusCode: 200, headers, body: JSON.stringify({ message: 'Symbol deleted (Metadata only)' }) };
             }
        }

        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not Found' }) };

    } catch (e) {
        console.error('Admin Error:', e);
        return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
};
