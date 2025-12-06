# AWS 콘솔 수동 세팅 가이드

Liquibook 매칭 엔진을 위한 AWS 인프라 전반부 세팅 가이드입니다.

> **규모 기준**: MVP (t2.medium, 동시 사용자 1만명)  
> **리전**: ap-northeast-2 (서울)

## 전체 아키텍처

```
Client → API Gateway (REST) → Lambda (Order Router) → MSK (Kafka) → EC2 (Matching Engine)
   ↑                              ↓                                         ↓
   └── API Gateway (WebSocket) ←──┴── ElastiCache (Valkey) ←─────── 체결 결과
```

---

## 목차

1. [사전 준비](#1-사전-준비)
2. [VPC 및 보안 그룹 설정](#2-vpc-및-보안-그룹-설정)
3. [ElastiCache Valkey 세팅](#3-elasticache-valkey-세팅)
4. [Amazon MSK (Kafka) 세팅](#4-amazon-msk-kafka-세팅)
5. [Lambda 함수 세팅](#5-lambda-함수-세팅)
6. [API Gateway REST API 세팅](#6-api-gateway-rest-api-세팅)
7. [API Gateway WebSocket API 세팅](#7-api-gateway-websocket-api-세팅)
8. [통합 테스트](#8-통합-테스트)

---

## 1. 사전 준비

### 1.1 IAM 사용자 확인

**AWS Console** → **IAM** → **Users**

필요한 권한:
- `AmazonVPCFullAccess`
- `AmazonElastiCacheFullAccess`
- `AmazonMSKFullAccess`
- `AWSLambda_FullAccess`
- `AmazonAPIGatewayAdministrator`
- `IAMFullAccess` (역할 생성용)

### 1.2 리전 선택

AWS Console 우측 상단 → **아시아 태평양 (서울) ap-northeast-2** 선택

---

## 2. VPC 및 보안 그룹 설정

### 2.1 VPC 확인/생성

**VPC** → **Your VPCs**

기본 VPC를 사용하거나 새로 생성:

| 설정 | 값 |
|---|---|
| Name | `liquibook-vpc` |
| IPv4 CIDR | `10.0.0.0/16` |

### 2.2 서브넷 생성

**VPC** → **Subnets** → **Create subnet**

최소 2개 AZ에 서브넷 필요 (MSK 요구사항):

| 서브넷 | CIDR | AZ |
|---|---|---|
| `liquibook-private-1a` | `10.0.1.0/24` | ap-northeast-2a |
| `liquibook-private-1b` | `10.0.2.0/24` | ap-northeast-2b |
| `liquibook-private-1c` | `10.0.3.0/24` | ap-northeast-2c |

### 2.3 보안 그룹 생성

**VPC** → **Security Groups** → **Create security group**

#### SG 1: Lambda용

| 설정 | 값 |
|---|---|
| Name | `liquibook-lambda-sg` |
| VPC | liquibook-vpc |
| Outbound | All traffic (0.0.0.0/0) |

#### SG 2: Valkey용

| 설정 | 값 |
|---|---|
| Name | `liquibook-valkey-sg` |
| VPC | liquibook-vpc |
| Inbound | TCP 6379 from `liquibook-lambda-sg` |

#### SG 3: MSK용

| 설정 | 값 |
|---|---|
| Name | `liquibook-msk-sg` |
| VPC | liquibook-vpc |
| Inbound | TCP 9092, 9094 from `liquibook-lambda-sg` |
| Inbound | TCP 9092, 9094 from EC2 매칭 엔진 SG |

---

## 3. ElastiCache Valkey 세팅

**ElastiCache** → **Valkey caches** → **Create Valkey cache**

> **Valkey란?** Redis의 오픈소스 포크로, Redis와 100% 호환되면서 BSD 라이선스를 유지합니다. AWS ElastiCache가 2024년부터 공식 지원합니다.

### 3.1 기본 설정

| 설정 | 값 | 설명 |
|---|---|---|
| Cluster mode | Disabled | MVP 규모에 적합 |
| Name | `liquibook-valkey` | |
| Location | AWS Cloud | |
| Multi-AZ | Disabled | 비용 절감 (MVP) |

### 3.2 클러스터 설정

| 설정 | 값 |
|---|---|
| Node type | `cache.t3.micro` |
| Number of replicas | 0 (MVP) |
| Engine version | 7.2 (Valkey 호환) |

### 3.3 연결 설정

| 설정 | 값 |
|---|---|
| Network type | IPv4 |
| Subnet group | 새로 생성 → `liquibook-valkey-subnet` |
| Subnets | 위에서 만든 private 서브넷들 선택 |
| Security groups | `liquibook-valkey-sg` |

### 3.4 보안 설정

| 설정 | 값 |
|---|---|
| Encryption in-transit | Enabled |
| Encryption at-rest | Enabled |
| Auth token | 강력한 토큰 생성 (저장해둘 것!) |

> ⚠️ **Auth token은 반드시 안전한 곳에 저장하세요!**

**Create** 클릭 후 약 5~10분 대기

### 3.5 엔드포인트 확인

생성 완료 후:
- **Primary endpoint** 복사 (예: `liquibook-valkey.xxxxx.apn2.cache.amazonaws.com:6379`)

---

## 4. Amazon MSK (Kafka) 세팅

**Amazon MSK** → **Clusters** → **Create cluster**

### 4.1 생성 방법 선택

**Quick create** 선택 (간편 설정)

### 4.2 클러스터 설정

| 설정 | 값 |
|---|---|
| Cluster name | `liquibook-msk` |
| Cluster type | Provisioned |
| Apache Kafka version | 3.5.x (MSK에서 지원하는 최신 안정 버전) |
| Broker type | `kafka.t3.small` |
| Number of zones | 2 |
| Storage | 100 GiB per broker |

### 4.3 네트워킹

| 설정 | 값 |
|---|---|
| VPC | `liquibook-vpc` |
| Subnets | private 서브넷 2개 이상 선택 |
| Security groups | `liquibook-msk-sg` |

### 4.4 보안 설정

| 설정 | 값 |
|---|---|
| Access control methods | IAM role-based authentication |
| Encryption | TLS encryption |

**Create cluster** 클릭 (생성에 15~30분 소요)

### 4.5 부트스트랩 서버 확인

클러스터 생성 완료 후:
1. 클러스터 선택 → **View client information**
2. **Bootstrap servers** 복사 (IAM 인증용)

### 4.6 토픽 생성

MSK 클러스터에 접속하여 토픽 생성이 필요합니다. Lambda에서 자동 생성되도록 설정하거나, EC2에서 kafka-topics.sh로 생성:

```bash
# EC2에서 실행 (kafka 클라이언트 설치 필요)
kafka-topics.sh --create --topic orders --bootstrap-server <bootstrap-servers> \
  --partitions 10 --replication-factor 2

kafka-topics.sh --create --topic fills --bootstrap-server <bootstrap-servers> \
  --partitions 10 --replication-factor 2
```

---

## 5. Lambda 함수 세팅

### 5.1 IAM 역할 생성

**IAM** → **Roles** → **Create role**

#### Step 1: Trusted entity
- **AWS service** → **Lambda**

#### Step 2: Permissions
다음 정책 연결:
- `AWSLambdaVPCAccessExecutionRole`
- `AWSLambdaBasicExecutionRole`

**인라인 정책 추가** (MSK, ElastiCache Valkey 접근용):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "kafka-cluster:Connect",
        "kafka-cluster:DescribeTopic",
        "kafka-cluster:WriteData",
        "kafka-cluster:ReadData"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "elasticache:Connect"
      ],
      "Resource": "*"
    }
  ]
}
```

#### Step 3: Name
- Role name: `liquibook-lambda-role`

### 5.2 Order Router Lambda 생성

**Lambda** → **Functions** → **Create function**

| 설정 | 값 |
|---|---|
| Function name | `liquibook-order-router` |
| Runtime | Node.js 20.x (또는 Python 3.12) |
| Architecture | arm64 (비용 효율) |
| Execution role | `liquibook-lambda-role` |

### 5.3 VPC 설정

**Configuration** → **VPC** → **Edit**

| 설정 | 값 |
|---|---|
| VPC | `liquibook-vpc` |
| Subnets | private 서브넷 모두 선택 |
| Security groups | `liquibook-lambda-sg` |

### 5.4 환경 변수

**Configuration** → **Environment variables** → **Edit**

| Key | Value |
|---|---|
| `VALKEY_HOST` | liquibook-valkey 엔드포인트 |
| `VALKEY_PORT` | 6379 |
| `VALKEY_AUTH_TOKEN` | Valkey 생성 시 설정한 토큰 |
| `MSK_BOOTSTRAP_SERVERS` | MSK 부트스트랩 서버 |
| `ORDERS_TOPIC` | orders |

### 5.5 기본 설정

**Configuration** → **General configuration** → **Edit**

| 설정 | 값 |
|---|---|
| Memory | 256 MB |
| Timeout | 10 seconds |
| Ephemeral storage | 512 MB |

### 5.6 Lambda 코드 (Node.js 예시)

```javascript
import { Kafka } from 'kafkajs';
import Redis from 'ioredis'; // Valkey는 Redis 프로토콜 호환

const kafka = new Kafka({
  clientId: 'order-router',
  brokers: process.env.MSK_BOOTSTRAP_SERVERS.split(','),
  ssl: true,
  sasl: {
    mechanism: 'aws',
    authorizationIdentity: process.env.AWS_ACCESS_KEY_ID,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  },
});

// Valkey는 Redis 클라이언트와 100% 호환
const valkey = new Redis({
  host: process.env.VALKEY_HOST,
  port: process.env.VALKEY_PORT,
  password: process.env.VALKEY_AUTH_TOKEN,
  tls: {},
});

const producer = kafka.producer();
let producerConnected = false;

export const handler = async (event) => {
  try {
    const order = JSON.parse(event.body);
    
    // 1. 입력 검증
    if (!order.symbol || !order.side || !order.quantity) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid order format' }),
      };
    }
    
    // 2. 라우팅 상태 확인
    const routeInfo = await valkey.get(`route:${order.symbol}`);
    const route = routeInfo ? JSON.parse(routeInfo) : { status: 'ACTIVE' };
    
    // 3. MSK로 주문 전송
    if (!producerConnected) {
      await producer.connect();
      producerConnected = true;
    }
    
    const topic = route.status === 'MIGRATING' ? 'pending-orders' : 'orders';
    
    await producer.send({
      topic,
      messages: [
        {
          key: order.symbol,
          value: JSON.stringify({
            ...order,
            timestamp: Date.now(),
            orderId: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          }),
        },
      ],
    });
    
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        message: 'Order accepted',
        topic,
        symbol: order.symbol,
      }),
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
```

### 5.7 Layer 추가 (의존성)

Lambda Layer를 생성하여 `kafkajs`, `ioredis` 등의 의존성을 추가해야 합니다.

로컬에서 (ioredis는 Valkey와 호환):
```bash
mkdir nodejs && cd nodejs
npm init -y
npm install kafkajs ioredis
cd ..
zip -r lambda-layer.zip nodejs
```

**Lambda** → **Layers** → **Create layer** → ZIP 업로드

---

## 6. API Gateway REST API 세팅

### 6.1 API 생성

**API Gateway** → **Create API** → **REST API** → **Build**

| 설정 | 값 |
|---|---|
| API name | `liquibook-api` |
| API endpoint type | Regional |

### 6.2 리소스 및 메서드 생성

#### /orders 리소스

**Actions** → **Create Resource**

| 설정 | 값 |
|---|---|
| Resource name | orders |
| Resource path | /orders |
| Enable API Gateway CORS | ✅ |

#### POST 메서드

**Actions** → **Create Method** → **POST**

| 설정 | 값 |
|---|---|
| Integration type | Lambda Function |
| Lambda Region | ap-northeast-2 |
| Lambda Function | liquibook-order-router |

### 6.3 API 보안 설정 (중요!)

#### 6.3.1 API Key 인증

**API Gateway** → **API Keys** → **Create API Key**

| 설정 | 값 |
|---|---|
| Name | `liquibook-client-key` |
| Auto Generate | ✅ |

#### 6.3.2 Usage Plan 생성

**API Gateway** → **Usage Plans** → **Create**

| 설정 | 값 |
|---|---|
| Name | `liquibook-basic-plan` |
| Rate | 1000 requests/second |
| Burst | 2000 requests |
| Quota | 1,000,000 requests/month |

**Add API Stage** → 배포 후 설정

#### 6.3.3 메서드에 API Key 요구 설정

**/orders** → **POST** → **Method Request**

| 설정 | 값 |
|---|---|
| API Key Required | true |

### 6.4 요청 검증 (Request Validation)

**API Gateway** → API 선택 → **Models** → **Create**

#### Order 모델

| 설정 | 값 |
|---|---|
| Model name | `OrderRequest` |
| Content type | application/json |

**Schema:**
```json
{
  "$schema": "http://json-schema.org/draft-04/schema#",
  "type": "object",
  "required": ["symbol", "side", "quantity", "price", "orderType"],
  "properties": {
    "symbol": {
      "type": "string",
      "pattern": "^[A-Z0-9]{1,10}$"
    },
    "side": {
      "type": "string",
      "enum": ["BUY", "SELL"]
    },
    "quantity": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000000
    },
    "price": {
      "type": "number",
      "minimum": 0.01
    },
    "orderType": {
      "type": "string",
      "enum": ["LIMIT", "MARKET"]
    },
    "userId": {
      "type": "string"
    }
  }
}
```

**/orders POST** → **Method Request** → **Request Validator**: `Validate body`

### 6.5 Rate Limiting (Throttling)

**Stages** → 스테이지 선택 → **Stage Editor** → **Settings**

| 설정 | 값 |
|---|---|
| Throttling Rate | 1000 |
| Throttling Burst | 2000 |

### 6.6 WAF 연동 (선택, 권장)

**AWS WAF** → **Web ACLs** → **Create web ACL**

권장 규칙:
- AWS Managed Rules - Core rule set
- AWS Managed Rules - Known bad inputs
- Rate-based rule (IP당 분당 1000 요청 제한)

생성 후 API Gateway에 연결:
**API Gateway** → **Stages** → 스테이지 선택 → **Web ACL** 연결

### 6.7 API 배포

**Actions** → **Deploy API**

| 설정 | 값 |
|---|---|
| Deployment stage | [New Stage] |
| Stage name | prod |

**Invoke URL** 복사 (예: `https://abc123.execute-api.ap-northeast-2.amazonaws.com/prod`)

### 6.8 Usage Plan에 API Stage 연결

**Usage Plans** → `liquibook-basic-plan` → **Add API Stage**
- API: `liquibook-api`
- Stage: `prod`

**Add API Key to Usage Plan**
- `liquibook-client-key` 추가

---

## 7. API Gateway WebSocket API 세팅

### 7.1 WebSocket API 생성

**API Gateway** → **Create API** → **WebSocket API** → **Build**

| 설정 | 값 |
|---|---|
| API name | `liquibook-ws` |
| Route selection expression | `$request.body.action` |

### 7.2 라우트 생성

#### $connect 라우트

클라이언트 연결 시 호출:

**Create Route** → Route Key: `$connect`

Lambda 통합 필요 (연결 ID 저장용):

```javascript
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
```

#### $disconnect 라우트

**Create Route** → Route Key: `$disconnect`

```javascript
// disconnect-handler Lambda
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
```

#### subscribe 라우트 (호가 구독)

**Create Route** → Route Key: `subscribe`

```javascript
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
```

### 7.3 WebSocket API 배포

**Actions** → **Deploy API**

| 설정 | 값 |
|---|---|
| Stage | prod |

**WebSocket URL** 복사 (예: `wss://xyz789.execute-api.ap-northeast-2.amazonaws.com/prod`)

### 7.4 메시지 푸시 (체결 시)

매칭 엔진에서 체결 발생 시 WebSocket으로 푸시:

```javascript
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

const client = new ApiGatewayManagementApiClient({
  endpoint: 'https://xyz789.execute-api.ap-northeast-2.amazonaws.com/prod',
});

async function broadcastFill(symbol, fillData) {
  // 해당 종목 구독자 조회 (Valkey에서)
  const subscribers = await valkey.smembers(`symbol:${symbol}:subscribers`);
  
  for (const connectionId of subscribers) {
    try {
      await client.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify(fillData),
      }));
    } catch (error) {
      if (error.statusCode === 410) {
        // 연결 끊김 - 정리
        await valkey.srem(`symbol:${symbol}:subscribers`, connectionId);
      }
    }
  }
}
```

---

## 8. 통합 테스트

### 8.1 REST API 테스트

```bash
# API Key 헤더 포함
curl -X POST https://abc123.execute-api.ap-northeast-2.amazonaws.com/prod/orders \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "symbol": "AAPL",
    "side": "BUY",
    "quantity": 100,
    "price": 150.00,
    "orderType": "LIMIT",
    "userId": "user123"
  }'
```

예상 응답:
```json
{
  "message": "Order accepted",
  "topic": "orders",
  "symbol": "AAPL"
}
```

### 8.2 WebSocket 테스트

```javascript
// 브라우저 또는 Node.js
const ws = new WebSocket('wss://xyz789.execute-api.ap-northeast-2.amazonaws.com/prod?userId=user123');

ws.onopen = () => {
  console.log('Connected');
  ws.send(JSON.stringify({
    action: 'subscribe',
    symbols: ['AAPL', 'GOOGL']
  }));
};

ws.onmessage = (event) => {
  console.log('Received:', event.data);
};
```

### 8.3 CloudWatch 로그 확인

**CloudWatch** → **Log groups**

확인할 로그 그룹:
- `/aws/lambda/liquibook-order-router`
- `/aws/lambda/liquibook-ws-connect`
- API Gateway 실행 로그 (활성화 필요)

### 8.4 엔드투엔드 흐름 확인

```
1. REST API로 주문 제출
   ↓
2. Lambda 로그에서 주문 처리 확인
   ↓
3. MSK 토픽에 메시지 도착 확인
   ↓
4. (EC2 매칭 엔진에서 소비 - 별도 구현)
   ↓
5. WebSocket으로 체결 결과 수신 확인
```

---

## 체크리스트

### 필수 확인 사항

- [ ] VPC 서브넷이 최소 2개 AZ에 구성됨
- [ ] 보안 그룹 인바운드/아웃바운드 규칙 확인
- [ ] Valkey AUTH 토큰 안전하게 저장
- [ ] MSK 부트스트랩 서버 주소 확인
- [ ] Lambda VPC 설정 완료
- [ ] API Gateway API Key 생성 및 Usage Plan 연결
- [ ] 요청 검증 모델 적용
- [ ] WAF 규칙 적용 (권장)

### 보안 점검

- [ ] API Key가 클라이언트에 안전하게 배포됨
- [ ] Valkey 암호화 활성화 (in-transit, at-rest)
- [ ] MSK TLS 암호화 활성화
- [ ] Lambda 환경 변수에 민감 정보 없음 (Secrets Manager 사용 권장)
- [ ] Rate limiting 설정됨

---

## 비용 예상 (MVP 기준)

| 서비스 | 사양 | 월 예상 비용 |
|---|---|---|
| MSK | kafka.t3.small × 2 | ~$100 |
| ElastiCache Valkey | cache.t3.micro | ~$15 |
| API Gateway | 100만 요청 | ~$3.50 |
| Lambda | 100만 호출, 256MB | ~$5 |
| CloudWatch | 기본 메트릭 | ~$10 |
| **합계** | | **~$135/월** |

---

## 9. 트러블슈팅 가이드

> ⚠️ **이 섹션은 실제 세팅 과정에서 겪은 시행착오를 기록한 것입니다.**

### 9.1 Lambda 핸들러 설정 오류

#### 문제: `Runtime.ImportModuleError: Cannot find module 'index'`

**원인**: Lambda Runtime settings의 Handler 값이 잘못 설정됨

**해결**:
| 잘못된 설정 | 올바른 설정 |
|---|---|
| `index.mjs` | `index.handler` |
| `handler` | `index.handler` |
| `index` | `index.handler` |

**핸들러 형식**: `파일명.함수명` (확장자 없이!)

**확인 위치**: Lambda → Code 탭 → 아래쪽 **Runtime settings**

---

### 9.2 Lambda Layer 패키지 누락

#### 문제: `Cannot find package 'kafkajs' imported from /var/task/index.mjs`

**원인**: Lambda Layer의 런타임 호환성 문제 또는 패키지 미설치

**해결**:
1. Lambda 함수 런타임을 **Node.js 20.x**로 설정 (24.x는 호환성 문제 있음)
2. Layer의 Compatible runtimes에 **Node.js 20.x** 포함 확인
3. Layer 구조가 올바른지 확인:

```
layer.zip
└── nodejs/
    ├── node_modules/
    │   ├── kafkajs/
    │   ├── ioredis/
    │   └── aws-msk-iam-sasl-signer-js/  ← MSK IAM 인증용
    ├── package.json
    └── package-lock.json
```

**Layer 생성 명령어**:
```bash
mkdir nodejs && cd nodejs
npm init -y
npm install kafkajs ioredis aws-msk-iam-sasl-signer-js
cd ..
zip -r layer.zip nodejs
```

---

### 9.3 환경 변수 설정 주의사항

#### 문제: `TypeError: Cannot read properties of undefined (reading 'split')`

**원인**: 환경 변수가 설정되지 않았거나 형식이 잘못됨

**올바른 환경 변수 형식**:

| Key | 올바른 형식 | ❌ 잘못된 형식 |
|---|---|---|
| `VALKEY_HOST` | `xxx.cache.amazonaws.com` | `xxx.cache.amazonaws.com:6379` (포트 포함하면 안 됨!) |
| `VALKEY_PORT` | `6379` | |
| `MSK_BOOTSTRAP_SERVERS` | `b-1.xxx:9098,b-2.xxx:9098` | `b-1.xxx:9092` (IAM은 9098 포트!) |
| `ORDERS_TOPIC` | `orders` | |

---

### 9.4 MSK 포트 번호 (중요!)

MSK 인증 방식에 따라 포트가 다릅니다:

| 인증 방식 | 포트 |
|---|---|
| Plaintext (암호화 없음) | 9092 |
| TLS | 9094 |
| SASL/SCRAM | 9096 |
| **IAM** | **9098** ← 가장 많이 사용 |

> ⚠️ **IAM role-based authentication** 사용 시 반드시 **9098** 포트 사용!

---

### 9.5 보안 그룹 설정

#### 문제: Lambda → MSK/Valkey 연결 타임아웃

**체크리스트**:

1. **MSK 보안 그룹** Inbound Rules:
   - TCP **9098** from Lambda Security Group

2. **Valkey 보안 그룹** Inbound Rules:
   - TCP **6379** from Lambda Security Group

3. **Lambda**가 MSK/Valkey와 **같은 VPC**에 있어야 함

4. **Lambda**가 **Private 서브넷**에 배치되어야 함

**보안 그룹 규칙 추가 방법**:
```
VPC → Security Groups → MSK 보안그룹 선택 → Inbound rules → Edit
→ Add rule:
  Type: Custom TCP
  Port: 9098
  Source: Lambda 보안그룹 ID (sg-xxxxxxxx)
  Description: Lambda to MSK
```

---

### 9.6 MSK IAM 인증 코드

#### 문제: 일반 Kafka 코드로 MSK IAM 인증 실패

**원인**: MSK IAM 인증에는 특별한 SASL 설정이 필요

**올바른 코드**:

```javascript
import { Kafka } from 'kafkajs';
import { generateAuthToken } from 'aws-msk-iam-sasl-signer-js';

async function createKafkaClient() {
  const region = 'ap-northeast-2';
  
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
```

**필요한 패키지**:
- `kafkajs`
- `aws-msk-iam-sasl-signer-js`

---

### 9.7 MSK 토픽 생성 권한 오류

#### 문제: `TOPIC_AUTHORIZATION_FAILED`

**원인**: Lambda IAM Role에 MSK 토픽 접근 권한이 없음

**해결 1: Lambda IAM Role에 정책 추가**

Lambda 실행 역할에 다음 정책 추가:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["kafka-cluster:*"],
      "Resource": "*"
    }
  ]
}
```

**해결 2: MSK 클러스터 정책 설정 (권장)**

MSK → Clusters → 클러스터 선택 → Properties → Cluster policy → Edit

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": ["arn:aws:iam::ACCOUNT_ID:role/YOUR-LAMBDA-ROLE"]
      },
      "Action": [
        "kafka-cluster:Connect",
        "kafka-cluster:AlterCluster",
        "kafka-cluster:DescribeCluster"
      ],
      "Resource": "arn:aws:kafka:ap-northeast-2:ACCOUNT_ID:cluster/CLUSTER-NAME/CLUSTER-UUID"
    },
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": ["arn:aws:iam::ACCOUNT_ID:role/YOUR-LAMBDA-ROLE"]
      },
      "Action": [
        "kafka-cluster:CreateTopic",
        "kafka-cluster:DeleteTopic",
        "kafka-cluster:DescribeTopic",
        "kafka-cluster:AlterTopic",
        "kafka-cluster:ReadData",
        "kafka-cluster:WriteData"
      ],
      "Resource": "arn:aws:kafka:ap-northeast-2:ACCOUNT_ID:topic/CLUSTER-NAME/*/*"
    },
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": ["arn:aws:iam::ACCOUNT_ID:role/YOUR-LAMBDA-ROLE"]
      },
      "Action": [
        "kafka-cluster:DescribeGroup",
        "kafka-cluster:AlterGroup"
      ],
      "Resource": "arn:aws:kafka:ap-northeast-2:ACCOUNT_ID:group/CLUSTER-NAME/*/*"
    }
  ]
}
```

> ⚠️ `ACCOUNT_ID`, `YOUR-LAMBDA-ROLE`, `CLUSTER-NAME`, `CLUSTER-UUID`를 실제 값으로 교체!

---

### 9.8 Admin Lambda 생성 (토픽 관리용)

Order Router Lambda에 토픽 생성 로직을 넣으면 성능이 저하됩니다.
**별도 Admin Lambda**를 생성하여 토픽을 관리하세요.

**Admin Lambda 설정**:

| 설정 | 값 |
|---|---|
| Function name | `Supernoba-admin` |
| Runtime | Node.js 20.x |
| Timeout | **60 seconds** |
| VPC | Order Router와 동일 |
| Layer | MSK용 Layer 동일 |

**Admin Lambda 코드**:

```javascript
import { Kafka } from 'kafkajs';
import { generateAuthToken } from 'aws-msk-iam-sasl-signer-js';

async function createKafkaClient() {
  const region = 'ap-northeast-2';
  return new Kafka({
    clientId: 'msk-admin',
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

export const handler = async (event) => {
  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || event;
    const { action, topic, partitions = 3, replicationFactor = 2 } = body;
    
    const kafka = await createKafkaClient();
    const admin = kafka.admin();
    await admin.connect();
    
    let result;
    switch (action) {
      case 'listTopics':
        result = await admin.listTopics();
        break;
      case 'createTopic':
        if (!topic) throw new Error('topic is required');
        await admin.createTopics({
          topics: [{ topic, numPartitions: partitions, replicationFactor }],
        });
        result = { created: topic };
        break;
      case 'deleteTopic':
        if (!topic) throw new Error('topic is required');
        await admin.deleteTopics({ topics: [topic] });
        result = { deleted: topic };
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }
    
    await admin.disconnect();
    return { statusCode: 200, body: JSON.stringify({ success: true, result }) };
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
```

**테스트 이벤트**:
```json
{
  "action": "createTopic",
  "topic": "orders",
  "partitions": 3,
  "replicationFactor": 2
}
```

---

### 9.9 Valkey TLS 설정

#### 문제: Valkey 연결 실패

**확인 사항**:

1. **Encryption in-transit** 활성화 여부 확인 (ElastiCache 콘솔에서)

2. TLS 활성화된 경우 코드에 `tls: {}` 추가:
```javascript
const valkey = new Redis({
  host: process.env.VALKEY_HOST,
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  tls: {},  // TLS 활성화 시 필요
});
```

3. TLS 비활성화된 경우 `tls: {}` 제거:
```javascript
const valkey = new Redis({
  host: process.env.VALKEY_HOST,
  port: parseInt(process.env.VALKEY_PORT || '6379'),
  // tls: {} 제거
});
```

---

### 9.10 API Gateway 테스트 시 주의사항

#### API Gateway 콘솔 테스트 vs 외부 호출

| 항목 | 콘솔 테스트 | 외부 호출 (curl, Postman) |
|---|---|---|
| `x-api-key` 헤더 | 불필요 (자동 bypass) | **필수** |
| URL | 테스트 콘솔에서 자동 처리 | 전체 URL 필요 |
| Body | Request Body 필드에 입력 | `-d` 옵션으로 전달 |

**외부 호출 예시**:
```bash
curl -X POST https://API_ID.execute-api.ap-northeast-2.amazonaws.com/prod/orders \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"symbol":"AAPL","side":"BUY","quantity":100,"price":150.00,"orderType":"LIMIT","userId":"user123"}'
```

---

### 9.11 event.body 파싱 오류

#### 문제: `"undefined" is not valid JSON`

**원인**: Lambda Proxy Integration에서 body가 항상 문자열로 오지 않음

**해결**: 여러 케이스를 처리하는 파싱 로직:

```javascript
export const handler = async (event) => {
  try {
    let order;
    if (typeof event.body === 'string') {
      order = JSON.parse(event.body);
    } else if (event.body) {
      order = event.body;
    } else {
      order = event;  // 직접 테스트 시
    }
    // ...
  }
};
```

---

### 9.12 Lambda 타임아웃 설정

| 용도 | 권장 타임아웃 |
|---|---|
| Order Router (일반 요청) | 10 ~ 30초 |
| Admin Lambda (토픽 생성) | 60초 |
| WebSocket Handler | 10초 |

**설정 위치**: Lambda → Configuration → General configuration → Timeout

---

## 다음 단계

1. **EC2 매칭 엔진 세팅** - MSK Consumer + Liquibook
2. **체결 결과 MSK → WebSocket 푸시** 구현
3. **모니터링 대시보드** - CloudWatch Dashboard 구성
4. **알람 설정** - CPU, 에러율 임계치 알람

---

*작성일: 2025-12-05*
