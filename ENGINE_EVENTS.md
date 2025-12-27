# 엔진에서 전송 가능한 이벤트 유형

## Kinesis 스트림별 이벤트

### 1. `supernoba-fills` 스트림
- **FILL**: 체결 이벤트
  - 형식: `{ event: "FILL", symbol, trade_id, buyer: {user_id, order_id, fully_filled}, seller: {...}, quantity, price, timestamp }`
  - 소비자: `fill-processor`, `history-saver`
  - 용도: 체결 처리 (DynamoDB 업데이트, Supabase 잔고 이체, Aurora 저장)

### 2. `supernoba-order-status` 스트림
- **ORDER_STATUS**: 주문 상태 변경 이벤트
  - 형식: `{ event: "ORDER_STATUS", symbol, order_id, user_id, status, reason?, timestamp }`
  - 소비자: `order-status-processor`
  - 상태 유형:
    - `ACCEPTED`: 주문 접수됨
    - `REJECTED`: 주문 거부됨
    - `CANCELLED`: 주문 취소됨
    - `CANCEL_REJECTED`: 취소 요청 거부됨
    - `REPLACED`: 주문 수정됨
    - `REPLACE_REJECTED`: 수정 요청 거부됨
    - `PARTIALLY_FILLED`: 부분 체결됨 (엔진에서 직접 WebSocket 전송, Kinesis 발행 안 함)
    - `FILLED`: 전량 체결됨
  - 용도: 주문 상태 업데이트 (DynamoDB), 잔고 해제 (CANCELLED), WebSocket 알림 (FILLED)

### 3. `supernoba-trades` 스트림
- **TRADE**: 거래 이벤트
  - 형식: `{ event: "TRADE", symbol, quantity, price, timestamp }`
  - 소비자: 없음 (현재 미사용)
  - 용도: 거래 집계 (필요시 추가 가능)

### 4. `supernoba-depth` 스트림
- **DEPTH**: 호가 변경 이벤트
  - 형식: `{ event: "DEPTH", symbol, bids: [[price, qty]], asks: [[price, qty]], timestamp }`
  - 소비자: 없음 (현재 주석 처리됨)
  - 용도: 호가 데이터 (현재는 Valkey 직접 저장 방식 사용)

## 엔진 콜백 함수별 이벤트 발행

### `on_accept()`
- WebSocket: `ACCEPTED` 상태 전송
- Kinesis: `ORDER_STATUS` (status: `ACCEPTED`) → `order-status` 스트림

### `on_reject()`
- WebSocket: `REJECTED` 상태 전송
- Kinesis: `ORDER_STATUS` (status: `REJECTED`) → `order-status` 스트림

### `on_fill()`
- WebSocket: 부분 체결 시 `PARTIALLY_FILLED` 상태 전송 (엔진 직접)
- Kinesis: 
  - `FILL` → `fills` 스트림 (부분/전량 모두)
  - 전량 체결 시 `ORDER_STATUS` (status: `FILLED`) → `order-status` 스트림

### `on_cancel()`
- WebSocket: `CANCELLED` 상태 전송
- Kinesis: `ORDER_STATUS` (status: `CANCELLED`) → `order-status` 스트림

### `on_cancel_reject()`
- WebSocket: `CANCEL_REJECTED` 상태 전송
- Kinesis: `ORDER_STATUS` (status: `CANCEL_REJECTED`) → `order-status` 스트림

### `on_replace()`
- WebSocket: `REPLACED` 상태 전송
- Kinesis: `ORDER_STATUS` (status: `REPLACED`) → `order-status` 스트림

### `on_replace_reject()`
- WebSocket: `REPLACE_REJECTED` 상태 전송
- Kinesis: `ORDER_STATUS` (status: `REPLACE_REJECTED`) → `order-status` 스트림

## 데이터 흐름 요약

```
엔진 이벤트 발생
  ↓
WebSocket 알림 (실시간)
  ↓
Kinesis 발행
  ├─ FILL → supernoba-fills
  └─ ORDER_STATUS → supernoba-order-status
      ↓
Lambda 처리
  ├─ fill-processor (FILL만)
  ├─ history-saver (FILL만)
  └─ order-status-processor (ORDER_STATUS)
```
