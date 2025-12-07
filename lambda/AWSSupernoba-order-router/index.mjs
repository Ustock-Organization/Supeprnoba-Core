// order-router Lambda - 주문 라우터 (업데이트 버전)
// Supabase 잔고 확인 + UUID 생성 + MSK 발행
import { Kafka } from 'kafkajs';
import Redis from 'ioredis';
import { generateAuthToken } from 'aws-msk-iam-sasl-signer-js';
import { createClient } from '@supabase/supabase-js';

const valkey = new Redis({
  host: process.env.VALKEY_HOST,
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  password: process.env.VALKEY_AUTH_TOKEN,
  tls: {},
});

// Supabase 클라이언트
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// UUID v4 생성 (crypto 사용)
function generateOrderId() {
  const timestamp = Date.now().toString(36);
  const randomPart = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `ord_${timestamp}_${randomPart}`;
}

async function createKafkaClient() {
  const region = process.env.AWS_REGION || 'ap-northeast-2';
  
  return new Kafka({
    clientId: 'order-router',
    brokers: process.env.MSK_BOOTSTRAP_SERVERS.split(','),
    ssl: true,
    sasl: {
      mechanism: 'oauthbearer',
      oauthBearerProvider: async () => {
        const token = await generateAuthToken({ region });
        return { value: token.token };
      },
    },
  });
}

// Supabase에서 사용자 잔고 확인
async function checkBalance(userId, side, price, quantity) {
  try {
    const { data, error } = await supabase
      .from('user_balances')
      .select('cash_balance, positions')
      .eq('user_id', userId)
      .single();
    
    if (error || !data) {
      console.error('Balance check error:', error);
      return { success: false, reason: 'User not found' };
    }
    
    if (side === 'BUY') {
      const requiredAmount = price * quantity;
      if (data.cash_balance < requiredAmount) {
        return { 
          success: false, 
          reason: `Insufficient balance: need ${requiredAmount}, have ${data.cash_balance}` 
        };
      }
    } else if (side === 'SELL') {
      // 매도 시 보유 수량 확인
      const positions = data.positions || {};
      const heldQty = positions[symbol]?.quantity || 0;
      if (heldQty < quantity) {
        return { 
          success: false, 
          reason: `Insufficient position: need ${quantity}, have ${heldQty}` 
        };
      }
    }
    
    return { success: true, balance: data.cash_balance };
  } catch (error) {
    console.error('Balance check exception:', error);
    return { success: false, reason: error.message };
  }
}

export const handler = async (event) => {
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
        body: JSON.stringify({ error: 'Invalid order format: symbol, side, quantity required' }),
      };
    }
    
    // 사용자 ID 확인
    const userId = order.user_id;
    if (!userId) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'user_id is required' }),
      };
    }
    
    // Supabase 잔고 확인 (환경변수 설정 시)
    if (process.env.SUPABASE_URL) {
      const balanceCheck = await checkBalance(userId, order.side, order.price || 0, order.quantity);
      if (!balanceCheck.success) {
        return {
          statusCode: 400,
          body: JSON.stringify({ 
            error: 'Balance check failed', 
            reason: balanceCheck.reason 
          }),
        };
      }
    }
    
    // Valkey에서 라우팅 정보 조회
    const routeInfo = await valkey.get(`route:${order.symbol}`);
    const route = routeInfo ? JSON.parse(routeInfo) : { status: 'ACTIVE' };
    
    // Kafka 연결
    const kafka = await createKafkaClient();
    const producer = kafka.producer();
    await producer.connect();
    
    const topic = route.status === 'MIGRATING' ? 'pending-orders' : (process.env.ORDERS_TOPIC || 'orders');
    
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
    
    await producer.send({
      topic,
      messages: [{
        key: order.symbol,
        value: JSON.stringify(orderMessage),
      }],
    });
    
    await producer.disconnect();
    
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        message: 'Order accepted',
        order_id: orderId,
        topic,
        symbol: order.symbol,
        side: order.side,
      }),
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};