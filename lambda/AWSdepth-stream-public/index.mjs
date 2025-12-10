// depth-stream-public - 비로그인 호가 스트리밍 Lambda
// Kinesis depth 스트림 구독 → WebSocket 구독자에게 0.5초 간격 브로드캐스트
import Redis from 'ioredis';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

const valkey = new Redis({
  host: process.env.VALKEY_HOST,
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  tls: {},  // ElastiCache TLS 필요
  connectTimeout: 5000,
  maxRetriesPerRequest: 1,
  lazyConnect: false,
});

valkey.on('error', (err) => {
  console.error('Redis connection error:', err.message);
});

valkey.on('connect', () => {
  console.log('Redis connected to:', process.env.VALKEY_HOST);
});

// 마지막 전송 시간 캐시 (심볼별)
const lastSentTime = new Map();
const THROTTLE_MS = 500; // 0.5초 간격

function getApiGatewayClient() {
  const endpoint = `https://${process.env.WEBSOCKET_ENDPOINT}`;
  console.log(`API Gateway endpoint: ${endpoint}`);
  return new ApiGatewayManagementApiClient({
    endpoint,
    region: process.env.AWS_REGION || 'ap-northeast-2',
  });
}

async function sendToConnection(client, connectionId, data) {
  try {
    console.log(`Sending to connection: ${connectionId}`);
    await client.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify(data),
    }));
    console.log(`SUCCESS: Sent to ${connectionId}`);
    return true;
  } catch (error) {
    console.error(`FAILED: ${connectionId} - ${error.name}: ${error.message}`);
    console.error(`Error details: statusCode=${error.$metadata?.httpStatusCode}, requestId=${error.$metadata?.requestId}`);
    if (error.$metadata?.httpStatusCode === 410) {
      // 연결 끊어짐 - 정리
      const connInfo = await valkey.get(`ws:${connectionId}`);
      if (connInfo) {
        const { userId } = JSON.parse(connInfo);
        await valkey.srem(`user:${userId}:connections`, connectionId);
      }
      await valkey.del(`ws:${connectionId}`);
      console.log(`Removed stale connection: ${connectionId}`);
    }
    return false;
  }
}

export const handler = async (event) => {
  console.log(`Received ${event.Records?.length || 0} Kinesis records`);
  const client = getApiGatewayClient();
  
  // Kinesis 이벤트 처리
  for (const record of event.Records || []) {
    try {
      const value = Buffer.from(record.kinesis.data, 'base64').toString('utf8');
      const depthData = JSON.parse(value);
      
      // 컴팩트 포맷: {"e":"d","s":"SYM","t":123,"b":[[p,q],...],"a":[[p,q],...]}
      const symbol = depthData.s;
      
      if (!symbol) continue;
      
      // 스로틀링: 0.5초 이내 동일 심볼은 스킵
      const now = Date.now();
      const lastSent = lastSentTime.get(symbol) || 0;
      if (now - lastSent < THROTTLE_MS) {
        continue;
      }
      lastSentTime.set(symbol, now);
      
      // 해당 심볼 구독자 조회
      const subscribers = await valkey.smembers(`symbol:${symbol}:subscribers`);
      
      console.log(`Broadcasting depth for ${symbol} to ${subscribers.length} subscribers`);
      
      // 모든 구독자에게 컴팩트 포맷 그대로 전송
      const results = await Promise.allSettled(subscribers.map(connectionId => 
        sendToConnection(client, connectionId, depthData)
      ));
      
      const succeeded = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
      const failed = results.length - succeeded;
      console.log(`Broadcast complete: ${succeeded} success, ${failed} failed`);
      
    } catch (error) {
      console.error('Error processing record:', error);
    }
  }
  
  return { statusCode: 200, body: 'OK' };
};
