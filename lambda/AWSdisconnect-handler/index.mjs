// disconnect-handler Lambda
import Redis from 'ioredis';
const valkey = new Redis({
  host: process.env.VALKEY_HOST,
  port: process.env.VALKEY_PORT,
});

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  
  const connInfo = await valkey.get(`ws:${connectionId}`);
  if (connInfo) {
    const { userId } = JSON.parse(connInfo);
    await valkey.srem(`user:${userId}:connections`, connectionId);
  }
  
  await valkey.del(`ws:${connectionId}`);
  
  return { statusCode: 200, body: 'Disconnected' };
};
