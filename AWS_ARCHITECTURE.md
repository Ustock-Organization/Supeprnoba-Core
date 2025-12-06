# AWS 핫 샤드 마이그레이션 아키텍처

핫 샤드 마이그레이션을 지원하는 AWS 기반 매칭 엔진 인프라의 기술 스택과 구현 방안입니다.

## 전체 아키텍처 개요

```
[Client] -> [API Gateway] -> [Order Router] -> [MSK] -> [Matching Engine Cluster]
                                  |                              |
                                  v                              v
                              [Redis]                    [State Snapshot S3]
                                  |
                                  v
                         [CloudWatch / Step Functions]
```

---

## 1. 클라이언트 진입점 (Ingress Layer)

| 컴포넌트                  | AWS 서비스 / 기술 스택                      | 역할                       |
| --------------------- | ------------------------------------ | ------------------------ |
| **WebSocket Gateway** | Amazon API Gateway (WebSocket API)   | 클라이언트 영구 연결 관리, 호가/체결 푸시 |
| **REST API**          | Amazon API Gateway (HTTP API) 또는 ALB | 주문 제출 REST 엔드포인트         |
| **인증**                | Amazon Cognito 또는 자체 JWT             | 사용자 인증 및 토큰 검증           |

### 구현 포인트
- API Gateway는 직접 MSK로 쏘지 못하므로, Lambda 또는 Fargate로 구현된 **Order Router**를 붙입니다.
- WebSocket은 연결 ID를 DynamoDB/Redis에 저장하여 체결 시 푸시 대상을 식별합니다.

---

## 2. 주문 라우터 (Order Router / Traffic Controller)

| 컴포넌트 | 기술 스택 | 역할 |
|---|---|---|
| **라우터 서비스** | Go 또는 Rust on ECS Fargate / EC2 | 종목코드 기반 라우팅 결정, 핫샤드 감지 시 주문 일시정지(Pause) |
| **라우팅 테이블** | Amazon ElastiCache (Redis) | 종목 -> 인스턴스 매핑 정보 저장, 실시간 조회 |
| **주문 큐** | Amazon MSK | 종목별 파티셔닝, 주문 버퍼링 |

### 구현 포인트 (Order Router)
```go
// 의사 코드 (Go)
func RouteOrder(order Order) {
    // 1. Redis에서 종목 라우팅 정보 조회
    routeInfo := redis.Get("route:" + order.Symbol)

    // 2. 해당 종목이 마이그레이션 중(Paused)이면 MSK에만 적재
    if routeInfo.Status == "MIGRATING" {
        msk.Send("pending-orders", order.Symbol, order) // 파티션 키 = 종목
        return
    }

    // 3. 정상이면 해당 파티션(인스턴스)으로 라우팅
    msk.Send("orders", order.Symbol, order)
}
```

- **파티션 키**를 종목 코드로 설정하면, 동일 종목 주문은 항상 같은 파티션으로 가서 순서 보장됩니다.
- Redis 라우팅 테이블 구조:
  - `route:SAMSUNG` -> `{ "target_instance": "i-0abc123", "status": "ACTIVE" | "MIGRATING" }`

---

## 3. 매칭 엔진 클러스터 (Matching Engine Layer)

| 컴포넌트 | 기술 스택 | 역할 |
|---|---|---|
| **매칭 엔진** | Liquibook (C++) + 커스텀 래퍼 on EC2 (c6i.xlarge 이상) | 주문 매칭 핵심 로직 |
| **MSK Consumer** | librdkafka (C++) 또는 Sarama (Go) | MSK에서 주문 소비 |
| **gRPC/TCP Server** | gRPC (C++) 또는 Boost.Asio | 오케스트레이터(Step Functions)와 통신, 스냅샷 요청/응답 |
| **상태 스냅샷 저장소** | Amazon S3 (대용량) 또는 Redis (저지연) | 오더북 직렬화 데이터 저장 |

### Liquibook 추가 구현 필요 사항
1. **MSK Consumer Thread**: MSK에서 주문을 읽어 `OrderBook::add()` 호출.
2. **gRPC Server**:
   - `SnapshotOrderBook(symbol)`: 해당 종목 오더북 직렬화 후 반환.
   - `RestoreOrderBook(symbol, data)`: 직렬화 데이터로 오더북 복원.
   - `RemoveOrderBook(symbol)`: 해당 종목 오더북 메모리 해제.
3. **메트릭 리포터**: 종목별 TPS, CPU 사용률을 CloudWatch Agent 또는 Prometheus로 전송.

---

## 4. 마이그레이션 오케스트레이터 (Orchestrator)

| 컴포넌트 | AWS 서비스 / 기술 스택 | 역할 |
|---|---|---|
| **상태 머신** | AWS Step Functions | 마이그레이션 전체 플로우 제어 |
| **부하 감지** | Amazon CloudWatch Alarms | CPU > 85% 시 Step Functions 트리거 |
| **인스턴스 제어** | AWS Lambda + EC2 API / ASG | 새 인스턴스 프로비저닝, AMI 시작 |

### Step Functions 상태 머신 플로우
```
1. DetectHotSymbol     -> 가장 부하가 높은 종목 식별
2. ProvisionNewInstance -> Warm Pool에서 EC2 시작
3. PauseRouting        -> Redis 라우팅 status = MIGRATING
4. WaitForDrain        -> 기존 인스턴스 주문 처리 완료 대기
5. TransferSnapshot    -> gRPC로 스냅샷 요청 -> S3 -> 신규 인스턴스 복원
6. SwitchRouting       -> Redis 라우팅 target = 신규 인스턴스
7. ReplayPendingOrders -> pending-orders 토픽 재전송
8. Cleanup             -> 기존 인스턴스에서 오더북 제거
```

---

## 5. 체결 결과 및 시장 데이터 게시 (Egress Layer)

| 컴포넌트 | 기술 스택 | 역할 |
|---|---|---|
| **체결 이벤트 발행** | Amazon MSK | 체결 발생 시 `fills` 토픽으로 발행 |
| **시장 데이터 처리** | Flink on Kinesis Data Analytics 또는 Lambda Consumer | `fills`, `depth` 토픽 소비 후 가공 |
| **클라이언트 푸시** | API Gateway Management API (WebSocket) | 연결된 클라이언트에 JSON 푸시 |
| **호가 캐싱** | ElastiCache (Redis) | 최신 호가창 저장, 클라이언트 폴링 대응 |

---

## 6. Warm Pool 전략 (비용 최적화)

새 인스턴스 프로비저닝 시간을 줄이기 위해 **EC2 Auto Scaling Warm Pool**을 사용합니다.

- **Warm Pool**: 미리 부팅된(또는 최대 절전모드) EC2 인스턴스를 풀에 대기시킵니다.
- **마이그레이션 시**: Cold Start(수 분) 대신 Warm Start(수 초)로 인스턴스 확보.
- **비용**: Running 상태가 아닌 Stopped 상태로 두면 EBS 비용만 발생.

---

## 요약 기술 스택 테이블

| 레이어 | 주요 기술 |
|---|---|
| 클라이언트 진입 | API Gateway (HTTP/WebSocket), Cognito |
| 라우팅 | Go/Rust on Fargate, ElastiCache Redis |
| 메시지 큐 | Amazon MSK (Kafka) |
| 매칭 엔진 | Liquibook C++ + gRPC + MSK Client (librdkafka) on EC2 |
| 오케스트레이션 | Step Functions, Lambda, CloudWatch Alarms |
| 스냅샷 저장 | S3 (또는 Redis for low latency) |
| 시장 데이터 | MSK, Lambda, API Gateway Push |

---

## 7. 용량 산정 (Capacity Planning)

### 7.1 Liquibook 성능 벤치마크 (로컬 테스트 기준)

| 테스트 유형 | 결과 |
|---|---|
| Depth OrderBook TPS | 273,652 주문/초 |
| BBO OrderBook TPS | 260,291 주문/초 |
| No Depth TPS | 297,762 주문/초 |
| 평균 레이턴시 | ~3,000 나노초 (3μs) |

### 7.2 사용자 행동 기반 TPS 추정

| 사용자 유형 | 주문 빈도 | 초당 주문 수 |
|---|---|---|
| 일반 사용자 | 10초에 1회 | 0.1 TPS |
| 활발한 트레이더 | 3초에 1회 | 0.33 TPS |
| 데이 트레이더 | 1초에 1회 | 1 TPS |
| **평균 (혼합)** | 5초에 1회 | **0.2 TPS** |

### 7.3 동시 사용자 수 계산

```
동시 사용자 = 엔진 TPS ÷ 사용자당 TPS
```

**예시 (평균 사용자 0.2 TPS 기준):**

| 환경 | TPS | 동시 사용자 |
|---|---|---|
| 로컬 (273K TPS) | 273,000 | 1,365,000명 |
| t2.micro (~10% 성능) | ~10,000 | ~50,000명 |
| t2.medium | ~40,000 | ~200,000명 |
| c6i.large | ~80,000 | ~400,000명 |

---

## 8. EC2 인스턴스 사이징

### 8.1 인스턴스별 예상 성능

| 인스턴스 | vCPU | RAM | 예상 TPS | 권장 동시 사용자 | 권장 종목 수 |
|---|---|---|---|---|---|
| **t2.micro** | 1 | 1GB | ~10,000 | 5만 명 | 5~10개 |
| **t2.small** | 1 | 2GB | ~15,000 | 7.5만 명 | 10~15개 |
| **t2.medium** | 2 | 4GB | ~40,000 | 20만 명 | 50~100개 |
| **c6i.large** | 2 | 4GB | ~80,000 | 40만 명 | 100~150개 |
| **c6i.xlarge** | 4 | 8GB | ~200,000 | 100만 명 | 300~500개 |

> ⚠️ **주의**: t2 인스턴스는 CPU 크레딧 제한이 있어 지속적인 부하에는 부적합합니다.

### 8.2 시나리오별 권장 구성

#### MVP (동시 사용자 1만 명, 종목 20개)

```
1x t2.medium
- 월 비용: ~$42
- 예상 TPS: 40,000
- 필요 TPS: 1만 × 0.2 = 2,000
- 여유율: 20배
```

#### 성장기 (동시 사용자 5만 명, 종목 100개)

```
1x c6i.large
- 월 비용: ~$69
- 예상 TPS: 80,000
- 필요 TPS: 5만 × 0.2 = 10,000
- 여유율: 8배
```

#### 대규모 (동시 사용자 50만 명, 종목 500개)

```
3x c6i.xlarge (샤딩)
- 월 비용: ~$414
- 예상 TPS: 600,000 (총합)
- 필요 TPS: 50만 × 0.2 = 100,000
- 여유율: 6배
```

---

## 9. 비용 추정 (서울 리전)

### 9.1 EC2 비용

| 인스턴스 | 시간당 | 월 비용 (24/7) | 용도 |
|---|---|---|---|
| t2.micro | $0.0144 | **$10** | 개발/테스트 |
| t2.medium | $0.058 | **$42** | MVP |
| c6i.large | $0.096 | **$69** | 프로덕션 |
| c6i.xlarge | $0.192 | **$138** | 핫 샤드 |

### 9.2 관련 서비스 비용 (월 예상)

| 서비스 | 사양 | 월 비용 |
|---|---|---|
| **Amazon MSK** | kafka.t3.small × 2 | ~$100 |
| **ElastiCache Redis** | cache.t3.micro | ~$15 |
| **API Gateway** | 100만 요청 | ~$3.50 |
| **S3** | 10GB 스냅샷 | ~$0.25 |
| **CloudWatch** | 기본 메트릭 | ~$10 |

### 9.3 총 비용 예상

| 규모 | 월 예상 비용 |
|---|---|
| **개발/테스트** | ~$50 |
| **MVP** | ~$200 |
| **성장기** | ~$400 |
| **대규모** | ~$1,000+ |

---

## 10. 핫 샤드 마이그레이션 트리거 기준

```
┌─────────────────────────────────────────────────────────────┐
│           CPU 사용률 기반 스케일링                           │
├─────────────────────────────────────────────────────────────┤
│  0-50%   │  정상 운영                                       │
│  50-70%  │  경고 (모니터링 강화)                             │
│  70-85%  │  Warm Pool 인스턴스 준비                          │
│  85%+    │  마이그레이션 트리거 → 핫 종목 분리                │
└─────────────────────────────────────────────────────────────┘
```

---

## 11. 래퍼 코드 구현 체크리스트

Liquibook 핵심 엔진을 AWS 프로덕션에 배포하려면 다음 래퍼 코드가 필요합니다:

### 11.1 필수 구현 (🔴)

| 컴포넌트 | 역할 | 기술 스택 |
|---|---|---|
| **MSK Consumer** | MSK → Liquibook 연결 | C++: librdkafka / Go: sarama |
| **TradeListener** | 체결 → MSK 발행 | Liquibook 콜백 구현 |
| **잔고 확인** | 주문 전 잔고 검증 | Order Router에서 처리 |
| **가격 검증** | 호가 제한 (상한가/하한가) | Order Router에서 처리 |

### 11.2 중요 구현 (🟡)

| 컴포넌트 | 역할 | 기술 스택 |
|---|---|---|
| **gRPC Server** | 스냅샷/복원, 오케스트레이션 통신 | C++: grpc / Go: grpc-go |
| **오더북 직렬화** | 스냅샷 → S3/Redis | JSON/Protobuf |
| **메트릭 리포터** | TPS/CPU → CloudWatch | AWS SDK |

### 11.3 권장 구현 (🟢)

| 컴포넌트 | 역할 |
|---|---|
| **로그 수집** | 주문/체결 로그 → CloudWatch Logs |
| **장애 복구** | 인스턴스 다운 시 자동 복구 |
| **중복 주문 방지** | 동일 주문 ID 거부 |

---

## 12. 영속성 (Persistence) 전략

Liquibook은 인메모리 엔진이므로, 데이터 영속성을 별도로 구현해야 합니다:

| 데이터 | 저장소 | 방법 |
|---|---|---|
| **오더북 스냅샷** | S3 | 주기적 직렬화 (1분 간격) |
| **체결 기록** | DynamoDB / RDS | TradeListener에서 기록 |
| **주문 로그** | Amazon MSK (보존) | 주문 토픽 retention 설정 |
| **사용자 잔고** | DynamoDB | 체결 시 업데이트 |

### 장애 복구 시나리오

```
1. 인스턴스 다운 감지 (CloudWatch)
2. Warm Pool에서 새 인스턴스 시작
3. S3에서 최신 스냅샷 복원
4. MSK에서 스냅샷 이후 주문 리플레이
5. 라우팅 테이블 업데이트
6. 서비스 재개
```

---

## 13. 전체 아키텍처 상세 다이어그램

```mermaid
graph TD
    %% Styles
    classDef aws fill:#FF9900,stroke:#232F3E,stroke-width:2px,color:white;
    classDef cpp fill:#00599C,stroke:#004482,stroke-width:2px,color:white;
    classDef client fill:#808080,stroke:#333,stroke-width:2px,color:white;

    subgraph Clients ["Clients (Mobile/Web)"]
        UserApp[User App]:::client
    end

    subgraph AWS_Cloud ["AWS Cloud"]
        style AWS_Cloud fill:#f9f9f9,stroke:#232F3E,stroke-dasharray: 5 5

        APIG[API Gateway]:::aws
        
        subgraph Serverless ["Serverless Layer"]
            OrderRouter[Order Router Lambda]:::aws
            StreamHandler[Stream Handler Lambda]:::aws
        end

        subgraph MSK_Cluster ["Amazon MSK (Kafka)"]
            Topic_Orders[Topic: orders]:::aws
            Topic_Fills[Topic: fills]:::aws
        end

        subgraph EC2_Layer ["Matching Engine (EC2)"]
            style EC2_Layer fill:#e6f3ff,stroke:#00599C
            
            Wrapper[C++ AWS Wrapper]:::cpp
            Liquibook[Liquibook Core]:::cpp
            
            Wrapper <-->|Matches| Liquibook
        end

        subgraph Persistence ["Persistence Layer"]
            Redis[(ElastiCache Redis)]:::aws
            S3[(S3 Snapshots)]:::aws
            DB[(User DB)]:::aws
        end
    end

    %% Connections
    UserApp -->|REST/WS| APIG
    APIG -->|Route| OrderRouter
    APIG <-->|Push Updates| StreamHandler

    OrderRouter -->|Check Balance| DB
    OrderRouter -->|Publish| Topic_Orders
    
    Topic_Orders -->|Consume| Wrapper
    Wrapper -->|Publish Fills| Topic_Fills
    
    Topic_Fills -->|Consume| StreamHandler
    
    Wrapper -.->|Snapshot| S3
    Wrapper -.->|Cache State| Redis
```

## 14. 고화질 아키텍처 다이어그램 생성 (Official Icons)

AWS 공식 아이콘을 사용한 고화질 다이어그램(PNG)을 생성하려면 다음 단계를 따르세요.

1.  **Graphviz 설치**: [Graphviz 다운로드](https://graphviz.org/download/) 및 설치 (시스템 PATH에 추가 필수).
2.  **Python 라이브러리 설치**:
    ```bash
    pip install diagrams
    ```
3.  **스크립트 실행**:
    ```bash
    python generate_architecture.py
    ```
4.  결과물 `liquibook_aws_architecture.png` 확인.


---

*최종 업데이트: 2025-12-05*
