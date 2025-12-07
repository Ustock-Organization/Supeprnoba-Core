import Redis from 'ioredis';
const valkey = new Redis({
  host: process.env.VALKEY_HOST,
  port: process.env.VALKEY_PORT,
  password: process.env.VALKEY_AUTH_TOKEN,
  tls: {},
});


// subscribe-handler Lambda
export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const body = JSON.parse(event.body);
  const { symbols } = body; // ["AAPL", "GOOGL"]
  
  for (const symbol of symbols) {
    await valkey.sadd(`symbol:${symbol}:subscribers`, connectionId);
  }
  
  return { statusCode: 200, body: 'Subscribed' };
};
