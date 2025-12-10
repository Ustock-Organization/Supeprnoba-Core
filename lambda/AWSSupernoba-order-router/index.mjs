// order-router Lambda - 주문 라우터 (Kinesis 버전)
// Supabase 잔고 확인 + UUID 생성 + Kinesis 발행
import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
import Redis from 'ioredis';
import { createClient } from '@supabase/supabase-js';

const kinesis = new KinesisClient({ region: process.env.AWS_REGION || 'ap-northeast-2' });

const valkey = new Redis({
  host: process.env.VALKEY_HOST,
  port: parseInt(process.env.VALKEY_PORT || '6379'),
});

// Supabase 클라이언트 (지연 초기화 - NAT Gateway 없을 시 사용 안함)
let supabase = null;
function getSupabase() {
  if (!supabase && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
  }
  return supabase;
}

// UUID v4 생성 (crypto 사용)
function generateOrderId() {
  const timestamp = Date.now().toString(36);
  const randomPart = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `ord_${timestamp}_${randomPart}`;
}

// Supabase에서 사용자 잔고 확인 (현재 비활성화 - NAT Gateway 필요)
async function checkBalance(userId, side, symbol, price, quantity) {
  // TODO: NAT Gateway 추가 후 활성화
  return { success: true, skipped: true };
}

export const handler = async (event) => {
  // CORS 헤더
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  
  // OPTIONS 요청 처리 (CORS preflight)
  if (event.httpMethod === 'OPTIONS' || event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  
  try {
    let order;
    if (typeof event.body === 'string') {
      order = JSON.parse(event.body);
    } else if (event.body) {
      order = event.body;
    } else {
      order = event;
    }
    
    // 필수 필드 검증
    if (!order.symbol || !order.side || !order.quantity) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid order format: symbol, side, quantity required' }),
      };
    }
    
    // 사용자 ID 확인
    const userId = order.user_id;
    if (!userId) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'user_id is required' }),
      };
    }
    
    // Supabase 잔고 확인 (선택적 - 미설정 시 건너뜀)
    console.log('Step 1: Balance check starting...');
    const balanceCheck = await checkBalance(userId, order.side, order.symbol, order.price || 0, order.quantity);
    console.log('Step 1: Balance check done:', balanceCheck);
    if (!balanceCheck.success) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'Balance check failed', 
          reason: balanceCheck.reason 
        }),
      };
    }
    
    // Valkey에서 라우팅 정보 조회
    console.log('Step 2: Valkey get starting...');
    const routeInfo = await valkey.get(`route:${order.symbol}`);
    console.log('Step 2: Valkey get done:', routeInfo);
    const route = routeInfo ? JSON.parse(routeInfo) : { status: 'ACTIVE' };
    
    // Kinesis 스트림 선택
    const streamName = route.status === 'MIGRATING' 
      ? 'supernoba-pending-orders' 
      : (process.env.KINESIS_ORDERS_STREAM || 'supernoba-orders');
    
    // 주문 ID 생성 (UUID 기반)
    const orderId = generateOrderId();
    
    // 주문 메시지 구성
    const orderMessage = {
      action: 'ADD',
      order_id: orderId,
      user_id: userId,
      symbol: order.symbol,
      is_buy: order.side === 'BUY' || order.side === 'buy',
      price: order.price || 0,
      quantity: order.quantity,
      order_type: order.order_type || 'LIMIT',
      timestamp: Date.now(),
    };
    
    // Kinesis에 발행
    console.log('Step 3: Kinesis PutRecord starting...');
    await kinesis.send(new PutRecordCommand({
      StreamName: streamName,
      Data: Buffer.from(JSON.stringify(orderMessage)),
      PartitionKey: order.symbol,  // 종목별 순서 보장
    }));
    console.log('Step 3: Kinesis PutRecord done!');
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        message: 'Order accepted',
        order_id: orderId,
        stream: streamName,
        symbol: order.symbol,
        side: order.side,
      }),
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
