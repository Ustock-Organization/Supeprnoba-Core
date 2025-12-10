// user-stream-handler - 로그인 사용자용 스트리밍 Lambda
// Kinesis fills, order_status 스트림 구독 → 개인 체결 알림 + 주문 상태
import Redis from 'ioredis';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

const valkey = new Redis({
  host: process.env.VALKEY_HOST,
  port: parseInt(process.env.VALKEY_PORT || '6379'),
});

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
      const connInfo = await valkey.get(`ws:${connectionId}`);
      if (connInfo) {
        const { userId } = JSON.parse(connInfo);
        await valkey.srem(`user:${userId}:connections`, connectionId);
      }
      await valkey.del(`ws:${connectionId}`);
    }
    return false;
  }
}

async function sendToUser(client, userId, data) {
  const connections = await valkey.smembers(`user:${userId}:connections`);
  const promises = connections.map(connId => sendToConnection(client, connId, data));
  await Promise.allSettled(promises);
}

export const handler = async (event) => {
  const client = getApiGatewayClient();
  
  // Kinesis 이벤트 처리
  for (const record of event.Records || []) {
    try {
      const value = Buffer.from(record.kinesis.data, 'base64').toString('utf8');
      const data = JSON.parse(value);
      
      // eventSourceARN으로 스트림 식별
      const streamName = record.eventSourceARN?.split('/').pop() || '';
      
      if (streamName.includes('fills')) {
        // 체결 알림 - 매수자/매도자에게 개별 전송
        const { buyer, seller, symbol, price, quantity, trade_id } = data;
        
        if (buyer?.user_id) {
          await sendToUser(client, buyer.user_id, {
            type: 'FILL',
            data: {
              trade_id,
              symbol,
              side: 'BUY',
              order_id: buyer.order_id,
              filled_qty: quantity,
              filled_price: price,
              timestamp: data.timestamp,
            },
          });
        }
        
        if (seller?.user_id) {
          await sendToUser(client, seller.user_id, {
            type: 'FILL',
            data: {
              trade_id,
              symbol,
              side: 'SELL',
              order_id: seller.order_id,
              filled_qty: quantity,
              filled_price: price,
              timestamp: data.timestamp,
            },
          });
        }
        
        console.log(`Fill notification sent: ${trade_id}`);
        
      } else if (streamName.includes('order-status')) {
        // 주문 상태 변경 - 해당 사용자에게 전송
        const { user_id, order_id, symbol, status, reason } = data;
        
        if (user_id) {
          await sendToUser(client, user_id, {
            type: 'ORDER_STATUS',
            data: {
              order_id,
              symbol,
              status, // ACCEPTED, REJECTED, CANCELLED, etc.
              reason,
              timestamp: data.timestamp,
            },
          });
        }
        
        console.log(`Order status sent: ${order_id} -> ${status}`);
      }
      
    } catch (error) {
      console.error('Error processing record:', error);
    }
  }
  
  return { statusCode: 200, body: 'OK' };
};

