// depth-stream-public - 비로그인 호가 스트리밍 Lambda
// MSK depth 토픽 구독 → WebSocket 구독자에게 0.5초 간격 브로드캐스트
import Redis from 'ioredis';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

const valkey = new Redis({
  host: process.env.VALKEY_HOST,
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  password: process.env.VALKEY_AUTH_TOKEN,
  tls: {},
});

// 마지막 전송 시간 캐시 (심볼별)
const lastSentTime = new Map();
const THROTTLE_MS = 500; // 0.5초 간격

function getApiGatewayClient() {
  return new ApiGatewayManagementApiClient({
    endpoint: `https://${process.env.WEBSOCKET_ENDPOINT}`,
    region: process.env.AWS_REGION || 'ap-northeast-2',
  });
}

async function sendToConnection(client, connectionId, data) {
  try {
    await client.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify(data),
    }));
    return true;
  } catch (error) {
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
  const client = getApiGatewayClient();
  
  // MSK 이벤트 처리
  for (const [topic, partitions] of Object.entries(event.records || {})) {
    for (const record of partitions) {
      try {
        const value = Buffer.from(record.value, 'base64').toString('utf8');
        const depthData = JSON.parse(value);
        const symbol = depthData.symbol;
        
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
        
        // 모든 구독자에게 전송
        const sendPromises = subscribers.map(connectionId => 
          sendToConnection(client, connectionId, {
            type: 'DEPTH',
            symbol,
            data: {
              bids: depthData.bids || [],
              asks: depthData.asks || [],
            },
            timestamp: now,
          })
        );
        
        await Promise.allSettled(sendPromises);
        
      } catch (error) {
        console.error('Error processing record:', error);
      }
    }
  }
  
  return { statusCode: 200, body: 'OK' };
};
