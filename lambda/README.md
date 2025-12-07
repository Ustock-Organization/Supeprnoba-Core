# Lambda Functions

비로그인 사용자를 위한 실시간 호가 스트리밍과 WebSocket 관리를 위한 Lambda 함수들입니다.

## 구조

```
lambda/
├── depthStreamHandler/    # MSK depth 토픽 → WebSocket 브로드캐스트
├── wsConnect/             # WebSocket $connect 핸들러
├── wsDisconnect/          # WebSocket $disconnect 핸들러
└── wsMessage/             # WebSocket $default 핸들러 (구독 관리)
```

## 배포 방법

### 1. 의존성 설치

```bash
cd lambda/depthStreamHandler
npm install

cd ../wsConnect
npm install

# 나머지도 동일
```

### 2. ZIP 패키징

```bash
cd lambda/depthStreamHandler
zip -r function.zip index.js node_modules package.json
```

### 3. AWS Lambda 배포

#### depthStreamHandler (MSK 트리거)
```bash
aws lambda create-function \
  --function-name depthStreamHandler \
  --runtime nodejs18.x \
  --handler index.handler \
  --zip-file fileb://function.zip \
  --role arn:aws:iam::ACCOUNT_ID:role/lambda-msk-role \
  --environment Variables="{CONNECTIONS_TABLE=websocket-connections,WEBSOCKET_ENDPOINT=xxx.execute-api.ap-northeast-2.amazonaws.com/prod}"
```

#### MSK 트리거 추가
```bash
aws lambda create-event-source-mapping \
  --function-name depthStreamHandler \
  --event-source-arn arn:aws:kafka:ap-northeast-2:ACCOUNT_ID:cluster/supernobamsk/xxx \
  --topics depth \
  --starting-position LATEST
```

## 환경변수

| 변수 | 설명 | 예시 |
|------|------|------|
| `CONNECTIONS_TABLE` | DynamoDB 연결 테이블 | `websocket-connections` |
| `WEBSOCKET_ENDPOINT` | API Gateway WebSocket 엔드포인트 | `xxx.execute-api.ap-northeast-2.amazonaws.com/prod` |
| `AWS_REGION` | AWS 리전 | `ap-northeast-2` |

## DynamoDB 테이블

### websocket-connections

| 속성 | 타입 | 설명 |
|------|------|------|
| `connectionId` | String (PK) | WebSocket 연결 ID |
| `connectedAt` | Number | 연결 시간 (epoch ms) |
| `subscribedSymbols` | String Set | 구독 중인 심볼 목록 |

### 테이블 생성
```bash
aws dynamodb create-table \
  --table-name websocket-connections \
  --attribute-definitions AttributeName=connectionId,AttributeType=S \
  --key-schema AttributeName=connectionId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

## API Gateway WebSocket 설정

### 라우트
| 라우트 | Lambda |
|--------|--------|
| `$connect` | wsConnect |
| `$disconnect` | wsDisconnect |
| `$default` | wsMessage |

### 클라이언트 메시지 형식
```json
// 심볼 구독
{ "action": "subscribe", "symbol": "AAPL" }

// 구독 해제
{ "action": "unsubscribe", "symbol": "AAPL" }
```

### 서버 푸시 형식
```json
{
  "type": "DEPTH",
  "symbol": "AAPL",
  "data": {
    "bids": [{ "price": 150, "quantity": 100, "count": 2 }],
    "asks": [{ "price": 151, "quantity": 50, "count": 1 }]
  },
  "timestamp": 1701936000000
}
```

---

*최종 업데이트: 2025-12-07*
