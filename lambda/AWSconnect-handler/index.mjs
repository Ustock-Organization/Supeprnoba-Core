// connect-handler Lambda
import Redis from 'ioredis'; // Valkey 호환

const valkey = new Redis({
  host: process.env.VALKEY_HOST,
  port: process.env.VALKEY_PORT,
  password: process.env.VALKEY_AUTH_TOKEN,
  tls: {},
});

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const userId = event.queryStringParameters?.userId || 'anonymous';
  
  // 연결 정보 저장 (24시간 TTL)
  await valkey.setex(`ws:${connectionId}`, 86400, JSON.stringify({
    userId,
    connectedAt: Date.now(),
  }));
  
  // 사용자별 연결 목록에 추가
  await valkey.sadd(`user:${userId}:connections`, connectionId);
  
  return { statusCode: 200, body: 'Connected' };
};