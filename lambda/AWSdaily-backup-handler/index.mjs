// daily-backup-handler Lambda
// 매일 00:00 KST에 EventBridge 트리거로 실행
// 전일 데이터를 S3와 DynamoDB에 저장

import Redis from 'ioredis';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

// 환경변수
const VALKEY_HOST = process.env.VALKEY_HOST || 'supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com';
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT || '6379');
const VALKEY_TLS = process.env.VALKEY_TLS === 'true';
const S3_BUCKET = process.env.S3_BUCKET || 'supernoba-market-data';
const DYNAMODB_TABLE_OHLC = process.env.DYNAMODB_TABLE_OHLC || 'symbol_history';
const DYNAMODB_TABLE_TRADES = process.env.DYNAMODB_TABLE_TRADES || 'trade_history';
const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-2';

// Valkey 연결
const valkey = new Redis({
  host: VALKEY_HOST,
  port: VALKEY_PORT,
  tls: VALKEY_TLS ? {} : undefined,
  connectTimeout: 5000,
});

// AWS 클라이언트
const s3Client = new S3Client({ region: AWS_REGION });
const dynamoClient = new DynamoDBClient({ region: AWS_REGION });
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/**
 * 전일 OHLC 데이터를 가져와 저장
 */
async function saveOHLCData(symbol, prevData) {
  const date = prevData.date?.toString() || getYesterday();
  
  // S3에 저장
  const s3Key = `daydata/${symbol}/${date}.json`;
  await s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    Body: JSON.stringify(prevData, null, 2),
    ContentType: 'application/json',
  }));
  console.log(`S3 saved: ${s3Key}`);
  
  // DynamoDB에 저장
  await docClient.send(new PutCommand({
    TableName: DYNAMODB_TABLE_OHLC,
    Item: {
      symbol: symbol,
      date: date,
      open: prevData.open,
      high: prevData.high,
      low: prevData.low,
      close: prevData.close,
      change_rate: prevData.change_rate,
      timestamp: Date.now(),
    },
  }));
  console.log(`DynamoDB OHLC saved: ${symbol} / ${date}`);
}

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0].replace(/-/g, '');
}

export const handler = async (event) => {
  console.log('Daily backup started:', new Date().toISOString());
  
  try {
    // 모든 prev:* 키 조회
    let cursor = '0';
    const prevKeys = [];
    do {
      const [newCursor, keys] = await valkey.scan(cursor, 'MATCH', 'prev:*', 'COUNT', 100);
      cursor = newCursor;
      prevKeys.push(...keys);
    } while (cursor !== '0');
    
    console.log(`Found ${prevKeys.length} symbols with prev data`);
    
    // 각 심볼 처리
    for (const key of prevKeys) {
      const symbol = key.replace('prev:', '');
      const dataJson = await valkey.get(key);
      
      if (dataJson) {
        try {
          const prevData = JSON.parse(dataJson);
          await saveOHLCData(symbol, prevData);
        } catch (e) {
          console.error(`Error processing ${symbol}:`, e.message);
        }
      }
    }
    
    console.log('Daily backup completed');
    return { statusCode: 200, body: `Backed up ${prevKeys.length} symbols` };
    
  } catch (error) {
    console.error('Backup error:', error);
    return { statusCode: 500, body: error.message };
  } finally {
    await valkey.quit();
  }
};
