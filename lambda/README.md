# Lambda Functions

Supernoba 거래 시스템용 AWS Lambda 함수들입니다.

## 디렉토리 구조

```
lambda/
├── AWSconnect-handler/        # WebSocket $connect
├── AWSdisconnect-handler/     # WebSocket $disconnect
├── AWSsubscribe-handler/      # 심볼 구독 요청 처리
├── AWSdepth-stream-public/    # 비로그인 호가 스트림 (0.5초 간격)
├── AWSuser-stream-handler/    # 로그인 사용자 스트림 (체결+호가)
├── AWSSupernoba-order-router/ # 주문 라우터
├── AWSSupernoba-admin/        # MSK 관리 API
└── layer.txt                  # Lambda Layer 정보
```

## Lambda 별 역할

| Lambda | 트리거 | 역할 |
|--------|--------|------|
| `connect-handler` | API Gateway $connect | 연결 정보 Valkey 저장 |
| `disconnect-handler` | API Gateway $disconnect | 연결 정보 정리 |
| `subscribe-handler` | API Gateway $default | 심볼 구독 관리 |
| `depth-stream-public` | MSK (depth) | 비로그인 호가 0.5초 간격 |
| `user-stream-handler` | MSK (fills, depth, order_status) | 로그인 사용자 체결/호가 |
| `order-router` | API Gateway HTTP | 주문 → MSK 발행 |
| `admin` | 직접 호출 | MSK 토픽 관리 |

## 환경변수

### 공통
| 변수 | 설명 |
|------|------|
| `VALKEY_HOST` | ElastiCache Valkey 호스트 |
| `VALKEY_PORT` | Valkey 포트 (6379) |
| `VALKEY_AUTH_TOKEN` | Valkey 인증 토큰 |

### WebSocket Push용
| 변수 | 설명 |
|------|------|
| `WEBSOCKET_ENDPOINT` | API Gateway WebSocket 엔드포인트 |

### MSK용
| 변수 | 설명 |
|------|------|
| `MSK_BOOTSTRAP_SERVERS` | MSK 브로커 주소 (IAM 9098) |
| `ORDERS_TOPIC` | 주문 토픽명 (기본: orders) |

### Supabase용 (order-router)
| 변수 | 설명 |
|------|------|
| `SUPABASE_URL` | Supabase 프로젝트 URL |
| `SUPABASE_SERVICE_KEY` | Supabase 서비스 키 |

## Layer 정보

```
nodejs24.x - layer version 5

의존성:
- @aws-sdk/client-apigatewaymanagementapi
- @aws-sdk/client-kafka
- @supabase/supabase-js
- aws-msk-iam-sasl-signer-js
- ioredis
- kafkajs
```

## 클라이언트 WebSocket 사용법

```javascript
// 연결 (userId 전달)
const ws = new WebSocket('wss://xxx.execute-api.ap-northeast-2.amazonaws.com/prod?userId=user123');

// 심볼 구독
ws.send(JSON.stringify({ action: 'subscribe', symbols: ['AAPL', 'GOOGL'] }));

// 호가 수신
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'DEPTH') {
    console.log(msg.symbol, msg.data.bids, msg.data.asks);
  } else if (msg.type === 'FILL') {
    console.log('체결:', msg.data);
  } else if (msg.type === 'ORDER_STATUS') {
    console.log('주문상태:', msg.data);
  }
};
```

## 주문 요청 형식

```json
POST /orders
{
  "user_id": "user123",
  "symbol": "AAPL",
  "side": "BUY",
  "price": 15000,
  "quantity": 10,
  "order_type": "LIMIT"
}
```

## 응답 형식

### 체결 알림 (FILL)
```json
{
  "type": "FILL",
  "data": {
    "trade_id": "trd_xxx",
    "symbol": "AAPL",
    "side": "BUY",
    "order_id": "ord_xxx",
    "filled_qty": 10,
    "filled_price": 15000
  }
}
```

### 호가 업데이트 (DEPTH)
```json
{
  "type": "DEPTH",
  "symbol": "AAPL",
  "data": {
    "bids": [{ "price": 150, "quantity": 100, "count": 2 }],
    "asks": [{ "price": 151, "quantity": 50, "count": 1 }]
  }
}
```

---

*최종 업데이트: 2025-12-07*
