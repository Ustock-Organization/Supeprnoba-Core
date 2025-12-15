// symbol-manager Lambda
// 종목 관리 API (공개: 조회, Admin: 추가/삭제/데이터 초기화)

import Redis from 'ioredis';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ScanCommand, DeleteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const valkey = new Redis({
  host: process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com',
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  connectTimeout: 5000,
  maxRetriesPerRequest: 1,
});

valkey.on('error', (err) => console.error('Redis error:', err.message));

const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-2' })
);

const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-northeast-2' });

const DYNAMODB_CANDLE_TABLE = process.env.DYNAMODB_TABLE || 'candle_history';
const DYNAMODB_TRADE_TABLE = process.env.DYNAMODB_TRADE_TABLE || 'trade_history';
const S3_BUCKET = process.env.S3_BUCKET || 'supernoba-market-data';

// CORS 헤더
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

// Admin 권한 확인 (추후 Cognito/API Key로 확장)
function isAdmin(event) {
  const authHeader = event.headers?.Authorization || event.headers?.authorization;
  // TODO: 실제 권한 검증 로직 (Cognito, API Key 등)
  return authHeader === process.env.ADMIN_API_KEY;
}

export const handler = async (event) => {
  // OPTIONS 요청 처리
  if (event.httpMethod === 'OPTIONS' || event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  
  const method = event.httpMethod || event.requestContext?.http?.method;
  const pathParams = event.pathParameters || {};
  const symbol = pathParams.symbol;
  
  try {
    // GET /symbols - 종목 목록 조회 (공개)
    if (method === 'GET' && !symbol) {
      const symbols = await valkey.smembers('active:symbols');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          symbols: symbols.sort(),
          count: symbols.length,
        }),
      };
    }
    
    // GET /symbols/{symbol} - 종목 상세 조회 (공개)
    if (method === 'GET' && symbol) {
      const exists = await valkey.sismember('active:symbols', symbol);
      if (!exists) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Symbol not found', symbol }),
        };
      }
      
      // 추가 정보 조회 (ticker, depth 등)
      const [ticker, depth] = await Promise.all([
        valkey.get(`ticker:${symbol}`),
        valkey.get(`depth:${symbol}`),
      ]);
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          symbol,
          active: true,
          ticker: ticker ? JSON.parse(ticker) : null,
          depth: depth ? JSON.parse(depth) : null,
        }),
      };
    }
    
    // POST /symbols - 종목 추가 (Admin)
    // POST with action: 'resetDatabase' - 데이터 초기화 (Admin)
    if (method === 'POST') {
      if (!isAdmin(event)) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };
      }
      
      const body = JSON.parse(event.body || '{}');
      
      // === 데이터베이스 초기화 액션 ===
      if (body.action === 'resetDatabase') {
        if (!body.confirm) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'confirm: true required' }) };
        }
        
        console.log('[ADMIN] Starting database reset...');
        
        const results = {
          candle_history: { deleted: 0, errors: 0 },
          trade_history: { deleted: 0, errors: 0 },
          s3: { deleted: 0, errors: 0 },
          valkey: { deleted: 0 }
        };
        
        // 헬퍼 함수: DynamoDB 테이블 삭제
        async function clearDynamoTable(tableName, resultKey) {
          let lastEvaluatedKey = undefined;
          let scanCount = 0;
          
          do {
            const scanResult = await dynamodb.send(new ScanCommand({
              TableName: tableName,
              ProjectionExpression: 'pk, sk',
              Limit: 100,
              ExclusiveStartKey: lastEvaluatedKey
            }));
            
            scanCount++;
            lastEvaluatedKey = scanResult.LastEvaluatedKey;
            
            if (scanResult.Items && scanResult.Items.length > 0) {
              for (const item of scanResult.Items) {
                try {
                  await dynamodb.send(new DeleteCommand({
                    TableName: tableName,
                    Key: { pk: item.pk, sk: item.sk }
                  }));
                  results[resultKey].deleted++;
                } catch (e) {
                  results[resultKey].errors++;
                }
              }
            }
            
            console.log(`[ADMIN] ${tableName} scan ${scanCount}: deleted ${results[resultKey].deleted}`);
            
            // 최대 10 스캔으로 제한 (Lambda 타임아웃 방지)
            if (scanCount >= 10) {
              console.log(`[ADMIN] ${tableName} scan limit reached`);
              break;
            }
          } while (lastEvaluatedKey);
        }
        
        // 1. DynamoDB candle_history 테이블 삭제
        try {
          await clearDynamoTable(DYNAMODB_CANDLE_TABLE, 'candle_history');
        } catch (e) {
          console.error('[ADMIN] candle_history error:', e.message);
        }
        
        // 2. DynamoDB trade_history 테이블 삭제
        try {
          await clearDynamoTable(DYNAMODB_TRADE_TABLE, 'trade_history');
        } catch (e) {
          console.error('[ADMIN] trade_history error:', e.message);
        }
        
        // 2. S3 candles 폴더 삭제
        try {
          let continuationToken = undefined;
          
          do {
            const listResult = await s3.send(new ListObjectsV2Command({
              Bucket: S3_BUCKET,
              Prefix: 'candles/',
              MaxKeys: 1000,
              ContinuationToken: continuationToken
            }));
            
            continuationToken = listResult.NextContinuationToken;
            
            if (listResult.Contents && listResult.Contents.length > 0) {
              const deleteParams = {
                Bucket: S3_BUCKET,
                Delete: {
                  Objects: listResult.Contents.map(obj => ({ Key: obj.Key }))
                }
              };
              
              await s3.send(new DeleteObjectsCommand(deleteParams));
              results.s3.deleted += listResult.Contents.length;
              console.log(`[ADMIN] S3 deleted ${results.s3.deleted} objects`);
            }
          } while (continuationToken);
          
        } catch (e) {
          console.error('[ADMIN] S3 error:', e.message);
          results.s3.errors++;
        }
        
        // 3. Valkey candle:closed:* 삭제
        try {
          const candleKeys = await valkey.keys('candle:closed:*');
          if (candleKeys.length > 0) {
            await valkey.del(...candleKeys);
            results.valkey.deleted += candleKeys.length;
          }
          console.log(`[ADMIN] Valkey deleted ${results.valkey.deleted} candle keys`);
        } catch (e) {
          console.error('[ADMIN] Valkey error:', e.message);
        }
        
        console.log('[ADMIN] Database reset complete:', results);
        
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            message: 'Database reset complete',
            results
          })
        };
      }
      
      // === 기존 종목 추가 로직 ===
      const newSymbol = body.symbol?.toUpperCase();
      
      if (!newSymbol) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'symbol is required' }) };
      }
      
      const added = await valkey.sadd('active:symbols', newSymbol);
      console.log(`Symbol added: ${newSymbol}, new=${added > 0}`);
      
      return {
        statusCode: added > 0 ? 201 : 200,
        headers,
        body: JSON.stringify({
          message: added > 0 ? 'Symbol added' : 'Symbol already exists',
          symbol: newSymbol,
        }),
      };
    }
    
    // DELETE /symbols/{symbol} - 종목 삭제 (Admin)
    if (method === 'DELETE' && symbol) {
      if (!isAdmin(event)) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };
      }
      
      const removed = await valkey.srem('active:symbols', symbol);
      console.log(`Symbol removed: ${symbol}, existed=${removed > 0}`);
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          message: removed > 0 ? 'Symbol removed' : 'Symbol not found',
          symbol,
        }),
      };
    }
    
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
