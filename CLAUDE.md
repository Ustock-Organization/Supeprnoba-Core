# Supernoba 프로젝트 가이드라인

> AWS 기반 실시간 주식 거래 플랫폼. C++ 매칭 엔진, React 프론트엔드, Lambda 마이크로서비스로 구성.

---

## 프로젝트 개요

**Supernoba**는 실시간 주식 거래 시뮬레이션 플랫폼으로, 다음 3개의 주요 저장소로 구성됩니다:

| 저장소 | 경로 | 기술 스택 | 역할 |
|--------|------|----------|------|
| **Supernoba-Core_Old** | `C:\develop\supernoba\Supernoba-Core_Old` | C++17, Node.js, Lambda | 매칭 엔진, 스트리밍, Lambda 함수 |
| **Supernoba-front** | `C:\develop\supernoba\Supernoba-front` | React 18, Redux Toolkit | 웹/모바일 프론트엔드 |
| **Supernoba-back** | `C:\develop\supernoba\Supernoba-back` | C++17 | Lambda 통합 프로세서 (stock-processor) |

---

## 아키텍처 흐름

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        클라이언트 (Web/Mobile)                            │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
            ┌────────────────────┴────────────────────┐
            │                                         │
      WebSocket (실시간)                        REST API (조회/주문)
            │                                         │
    ┌───────▼───────┐                        ┌────────▼────────┐
    │ API Gateway   │                        │  API Gateway    │
    │  WebSocket    │                        │    REST         │
    └───────┬───────┘                        └────────┬────────┘
            │                                         │
    ┌───────▼───────┐                        ┌────────▼────────┐
    │   Streamer    │                        │  order-router   │
    │  (Node.js)    │                        │   (Lambda)      │
    └───────┬───────┘                        └────────┬────────┘
            │                                         │
    ┌───────▼──────────────────────────────────────────▼────────┐
    │                    Valkey (Redis)                          │
    │  depth:SYMBOL, candle:1m:SYMBOL, ticker:SYMBOL             │
    └───────▲──────────────────────────────────────────▲────────┘
            │                                          │
    ┌───────┴───────┐                        ┌─────────┴────────┐
    │   Matching    │                        │     Kinesis      │
    │    Engine     │─────────────────────── │   Streams        │
    │   (C++)       │   supernoba-orders     │ supernoba-fills  │
    └───────────────┘                        └────────┬─────────┘
                                                      │
                                             ┌────────▼─────────┐
                                             │  stock-processor │
                                             │     (C++)        │
                                             │  - fill_processor│
                                             │  - history_saver │
                                             │  - notifier      │
                                             │  - order_status  │
                                             └────────┬─────────┘
                                                      │
                      ┌───────────────┬───────────────┼───────────────┐
                      │               │               │               │
               ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
               │  DynamoDB   │ │ PostgreSQL  │ │   Valkey    │ │ WebSocket   │
               │  (Orders,   │ │ (History)   │ │  (Cache)    │ │ (Notify)    │
               │  Holdings,  │ │             │ │             │ │             │
               │  Wallets)   │ │             │ │             │ │             │
               └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
```

---

## 저장소별 구조

### 1. Supernoba-Core_Old (C++ 매칭 엔진 + Lambda)

```
Supernoba-Core_Old/
├── wrapper/                      # C++ 매칭 엔진 (EC2)
│   ├── src/
│   │   ├── main.cpp             # 진입점
│   │   ├── engine_core.cpp      # Liquibook OrderBook 래퍼
│   │   ├── market_data_handler.cpp  # 이벤트 리스너 (fill, depth 등)
│   │   ├── kinesis_consumer.cpp # Kinesis 주문 수신
│   │   ├── kinesis_producer.cpp # 체결 이벤트 발행
│   │   └── redis_client.cpp     # Valkey Lua Script (캔들 집계)
│   ├── include/                 # 헤더 파일
│   ├── CMakeLists.txt           # CMake 빌드 설정
│   └── vcpkg.json               # C++ 의존성
│
├── streamer/node/               # 스트리밍 서버 (EC2)
│   ├── index.mjs               # WebSocket 브로드캐스트 (50/500ms 폴링)
│   └── package.json
│
├── aggregator/                  # 캔들 집계 (EC2)
│   ├── src/
│   │   ├── main.cpp
│   │   └── aggregator.cpp       # 1분 → 상위 타임프레임
│   └── CMakeLists.txt
│
├── mm-service/                  # Market Maker 서비스 v10 (EC2)
│   ├── index.mjs               # MM 서비스 메인 (Strategy Pattern)
│   ├── strategies/             # legacy_sine, spread, depth
│   ├── OrderManager.mjs        # 주문 관리
│   ├── InventoryTracker.mjs    # 포지션 추적
│   ├── PriceFeed.mjs           # 가격 피드
│   └── package.json            # 의존성
│
├── lambda/                      # AWS Lambda 함수들 (47개)
│   ├── Supernoba-order-router/  # 주문 검증 및 Kinesis 전송
│   ├── Supernoba-admin/         # 종목 관리
│   ├── Supernoba-chart-data-handler/  # 차트 조회
│   ├── Supernoba-connect-handler/     # WebSocket $connect
│   ├── Supernoba-subscribe-handler/   # 종목 구독
│   ├── Supernoba-disconnect-handler/  # WebSocket $disconnect
│   ├── Supernoba-payments/            # Stripe 결제
│   ├── Supernoba-stripe-webhook/      # Stripe 웹훅
│   ├── Supernoba-apple-iap/           # Apple IAP
│   ├── Supernoba-push-tokens/         # 푸시 토큰 관리
│   ├── Supernoba-push-sender/         # APNs 발송
│   ├── layers/                        # Lambda 레이어
│   │   ├── supernoba-common/          # 공통 유틸리티
│   │   ├── supernoba-auth/            # Cognito 인증
│   │   └── supernoba-pg/              # PostgreSQL
│   │
│   │   # DEPRECATED (stock-processor로 이전됨)
│   ├── Supernoba-fill-processor/      # @deprecated
│   ├── Supernoba-history-saver/       # @deprecated
│   ├── Supernoba-notifier/            # @deprecated
│   └── Supernoba-order-status-processor/  # @deprecated
│
├── sql/                         # RDS SQL 스크립트
│   ├── 000_daily_close_install.sql
│   ├── 001_daily_close_tables.sql
│   ├── 002_daily_close_functions.sql
│   ├── 003_pg_cron_jobs.sql
│   └── 004_valkey_sync_functions.sql
│
├── deploy/                      # 배포 자동화 (systemd 기반)
│   ├── env/                    # 환경변수 파일
│   ├── systemd/                # systemd 서비스 파일
│   ├── logrotate/              # 로그 로테이션 설정
│   ├── install-services.sh     # 서비스 설치 스크립트
│   ├── supernoba-ctl.sh       # 마스터 제어 스크립트
│   ├── reset-platform.sh      # 플랫폼 초기화 스크립트
│   └── delist-symbol.sh       # 상장폐지 운영 도구
│
└── .github/workflows/           # CI/CD
    ├── deploy-lambda.yml        # Lambda 자동 배포 (Node 22)
    ├── deploy-layer.yml         # Lambda 레이어 자동 배포
    └── deploy-engine.yml        # EC2 서비스 자동 배포
```

### 2. Supernoba-front (React 프론트엔드)

```
Supernoba-front/
├── src/
│   ├── app/App.js               # 라우팅, 인증, WebSocket 초기화
│   ├── features/                # 기능 모듈 (Feature-Based Architecture)
│   │   ├── auth/               # 인증 (Login, Sign, AccessControl)
│   │   ├── market-data/        # 실시간 시세
│   │   ├── trading/            # 주문 입력 (Trading, Orderbook)
│   │   ├── portfolio/          # 포지션/주문/체결
│   │   ├── favorites/          # 즐겨찾기
│   │   ├── chart/              # 캔들차트 (lightweight-charts)
│   │   ├── treemap/            # 트리맵 시각화
│   │   ├── game/               # 3D 게임 (Three.js + Zustand)
│   │   └── admin/              # 관리자 대시보드
│   ├── shared/                  # 크로스피처 인프라
│   │   ├── services/           # WebSocketService, ApiService
│   │   ├── store/              # Redux Store
│   │   └── lib/                # cognitoClient (AWS Cognito OAuth)
│   └── layouts/                 # 데스크탑/모바일 레이아웃
├── package.json
└── capacitor.config.ts          # iOS 네이티브 설정
```

### 3. Supernoba-back (C++ 백엔드 프로세서)

```
Supernoba-back/
├── include/
│   ├── clients/
│   │   ├── dynamodb_client.h   # DynamoDB TransactWriteItems
│   │   ├── postgres_client.h   # PostgreSQL 연결
│   │   ├── redis_client.h      # Valkey 클라이언트
│   │   └── websocket_client.h  # API Gateway 알림
│   ├── consumers/
│   │   ├── kinesis_consumer.h  # Kinesis 스트림 소비
│   │   └── fill_consumer.h     # supernoba-fills 소비
│   └── processors/
│       ├── fill_processor.h    # 체결 처리 (DynamoDB 트랜잭션)
│       ├── order_status_processor.h  # 주문 상태 변경
│       ├── history_processor.h       # PostgreSQL 저장
│       └── notification_processor.h  # WebSocket 알림
├── src/
│   └── main.cpp                # 진입점
├── deploy/
│   ├── supernoba-ctl.sh       # 운영 제어 (start/stop/restart)
│   └── install-services.sh    # 일회성 설정
├── CMakeLists.txt
├── vcpkg.json
└── .github/workflows/
    └── deploy-processor.yml    # Processor 자동 배포
```

---

## 기술 스택

### 백엔드

| 컴포넌트 | 기술 | 버전 |
|----------|------|------|
| 매칭 엔진 | C++ (Liquibook) | C++17 |
| 스트리밍 | Node.js | 22.x |
| Lambda | JavaScript (ESM) | Node 22 |
| 캐시 | Valkey (Redis 호환) | 7.x |
| DB | DynamoDB, PostgreSQL (Aurora) | - |
| 메시지 큐 | AWS Kinesis | - |
| 인증 | AWS Cognito | - |

### 프론트엔드

| 컴포넌트 | 기술 | 버전 |
|----------|------|------|
| UI | React | 18.3.1 |
| 상태 관리 | Redux Toolkit | 2.2.7 |
| 차트 | lightweight-charts | 4.2.0 |
| 레이아웃 | react-grid-layout | 1.5.0 |
| UI 컴포넌트 | Ant Design | 5.21.4 |
| 모바일 | Capacitor | 7.4.4 |

---

## EC2 인스턴스 구성

**단일 EC2 t2.xlarge** (172.31.10.211, 4 vCPU / 16 GB) — 5개 서비스 통합

| SSH 별칭 | systemd 서비스 | 역할 |
|----------|---------------|------|
| `server` | `supernoba-engine` | Matching Engine (C++) |
| `server` | `supernoba-mm` | Market Maker v10 (Node.js) |
| `server` | `supernoba-streamer` | Streamer (Node.js) |
| `server` | `supernoba-processor` | Stock Processor (C++) |
| `server` | `supernoba-aggregator` | Aggregator (C++) |

**서비스 제어 (systemd):**
```bash
./supernoba-ctl.sh start all      # 시작
./supernoba-ctl.sh stop all       # 종료
./supernoba-ctl.sh restart all    # 재시작
./supernoba-ctl.sh health         # 헬스체크
./supernoba-ctl.sh kill-all       # 강제 종료
```

---

## 배포 자동화 (GitHub Actions)

모든 배포는 **GitHub Actions**를 통해 자동화됩니다. develop push → 워크플로우 자동 트리거.

### 배포 워크플로우

| 워크플로우 | 레포 | 트리거 | 대상 |
|-----------|------|--------|------|
| `deploy-lambda.yml` | Supernoba-Core_Old | `lambda/` 변경 push | Lambda 47개 (변경분만) |
| `deploy-layer.yml` | Supernoba-Core_Old | `lambda/layers/` 변경 push | Lambda 레이어 3개 |
| `deploy-engine.yml` | Supernoba-Core_Old | `wrapper/`, `streamer/`, `mm-service/`, `aggregator/` 변경 push | EC2 서비스 4개 |
| `deploy-processor.yml` | Supernoba-back | `src/`, `include/` 변경 push | EC2 Processor |
| `deploy.yml` | Supernoba-front | master push | S3 + CloudFront |
| `pr-preview.yml` | Supernoba-front | PR open/sync | S3 프리뷰 |

### 배포 흐름
```
코드 수정 → git push develop → GitHub Actions 자동 감지 → 빌드/배포 → 검증 → Slack 알림
```

### 운영 스크립트 (수동, 일회성)

| 스크립트 | 역할 |
|---------|------|
| `deploy/supernoba-ctl.sh` | 서비스 제어 (GitHub Actions도 사용) |
| `deploy/install-services.sh` | 새 EC2 프로비저닝 시 설치 |
| `deploy/deploy-4cache.sh` | 4-Cache 초기 세팅 |
| `deploy/reset-platform.sh` | 플랫폼 데이터 초기화 |
| `deploy/delist-symbol.sh` | 상장폐지 운영 |

---

## Valkey 4-Cache 키 구조

### Depth Cache (포트 6379)
```
depth:{SYMBOL}                    # JSON: {b: [[price, qty]...], a: [...]}
ticker:{SYMBOL}                   # JSON: {p, c, cp, h, l, v, pc}
ohlc:{SYMBOL}                     # JSON: {o, h, l, c, v, change, t}
prev:{SYMBOL}                     # String: 전일 종가
```

### Candle Cache (포트 6380)
```
candle:1m:{SYMBOL}               # Hash: {o, h, l, c, v, t, t_epoch}
candle:closed:1m:{SYMBOL}        # List: 마감된 1분봉 (집계 대기)
```

### Backup Cache (포트 6381)
```
snapshot:{SYMBOL}                # String: 오더북 스냅샷
kinesis:checkpoint:*             # String: Kinesis 체크포인트
ranking:marketcap                # SortedSet: 시가총액 순위
ranking:volume                   # SortedSet: 거래량 순위
ranking:gainers/losers           # SortedSet: 급등/급락 순위
rankings:snapshot                # String: 랭킹 JSON (TTL 15s)
```

### Operating Cache (포트 6382)
```
ws:{connectionId}                # String: 연결 정보
user:{userId}:connections        # Set: 사용자 연결 ID 목록
symbol:{SYMBOL}:main             # Set: 해당 종목 구독 연결 목록
subscribed:symbols               # Set: 구독 가능한 종목 목록
deleted:symbols                  # Set: 삭제된 종목 목록
mm:control                       # Pub/Sub: 제어 명령 채널
mm:status                        # Pub/Sub: 상태 브로드캐스트 채널
mm:running                       # String: 전체 실행 상태 (1/0)
mm:running:symbols               # Set: 실행 중인 종목 목록
mm:config:{SYMBOL}               # Hash: 종목별 MM 설정
mm:price:{SYMBOL}                # String: 현재 MM 가격
```

---

## DynamoDB 테이블 구조

### supernoba-orders
```
PK: user_id (String)
SK: order_id (String)
Attributes:
  - symbol, side, type, price, quantity
  - filled_qty, lock_amount, status
  - version (낙관적 잠금)
  - cancel_processed (멱등성)
  - created_at, updated_at
```

### supernoba-holdings
```
PK: user_id (String)
SK: symbol (String)
Attributes:
  - quantity, locked, avg_price, version
```

### supernoba-wallets
```
PK: user_id (String)
Attributes:
  - available, locked, version
```

---

## 일반적인 문제 해결

### GitHub Actions 배포 실패

**증상**: SSH keyscan 실패, 배포 워크플로우 에러
**원인**: EC2 보안 그룹에서 GitHub Actions IP 차단
**해결**:
1. EC2 보안 그룹에서 SSH (22) 포트를 GitHub Actions IP 허용
2. 또는 수동 배포: EC2에 SSH 접속 후 빌드/재시작

### WebSocket 연결 끊김

**증상**: 실시간 데이터 수신 중단
**원인**: API Gateway 연결 타임아웃 (10분)
**해결**: 프론트엔드에서 지수 백오프 재연결 로직 확인

### Lambda 함수 timeout

**증상**: 주문 처리 지연, 5초 이상 소요
**원인**: VPC 콜드 스타트 또는 DynamoDB 처리량 부족
**해결**:
1. Provisioned Concurrency 설정
2. DynamoDB 용량 증가

---

## 커밋 메시지 규칙

```
<type>: <description>

[optional body]

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

**타입:**
- `feat`: 새 기능
- `fix`: 버그 수정
- `refactor`: 코드 리팩토링
- `docs`: 문서 수정
- `chore`: 빌드, 설정 변경
- `test`: 테스트 추가

---

## 핵심 파일 경로

### 핵심 로직

| 파일 | 역할 |
|------|------|
| `Supernoba-Core_Old/wrapper/src/market_data_handler.cpp` | 체결/호가 이벤트 처리, WebSocket 전송 |
| `Supernoba-Core_Old/wrapper/src/engine_core.cpp` | Liquibook 오더북 래퍼 |
| `Supernoba-Core_Old/wrapper/src/redis_client.cpp` | Valkey Lua Script (캔들 집계) |
| `Supernoba-back/src/processors/fill_processor.cpp` | 체결 처리 (DynamoDB 트랜잭션) |
| `Supernoba-front/src/shared/services/WebSocketService.js` | WebSocket 연결 관리 |
| `Supernoba-front/src/features/market-data/store/MarketSlice.js` | 마켓 데이터 상태 |

### 배포 설정

| 파일 | 역할 |
|------|------|
| `Supernoba-Core_Old/.github/workflows/deploy-lambda.yml` | Lambda 자동 배포 (Node 22) |
| `Supernoba-Core_Old/.github/workflows/deploy-layer.yml` | Lambda 레이어 자동 배포 |
| `Supernoba-Core_Old/.github/workflows/deploy-engine.yml` | EC2 서비스 자동 배포 |
| `Supernoba-back/.github/workflows/deploy-processor.yml` | Processor 자동 배포 |

### 환경 설정

| 파일 | 역할 |
|------|------|
| `Supernoba-Core_Old/deploy/env/` | EC2 서비스 환경변수 |
| `Supernoba-front/src/config/env.js` | 프론트엔드 API 엔드포인트 |
| `Supernoba-back/include/config/config.h` | C++ 환경 설정 |

---

## 보안 고려사항

- **MM (Market Maker) ID 관리**: `mm-buyer`, `mm-seller`는 order-router에서 잔고 체크를 우회
- **AWS Secrets Manager**: DB 자격증명, MM ID 목록 캐싱 (5분/1시간 TTL)
- **DynamoDB 낙관적 잠금**: `version` 필드로 동시성 제어
- **API 인증**: AWS Cognito JWT 토큰 (id_token 필수)

---

## 다음 세션을 위한 컨텍스트

이 프로젝트는 **AWS 기반 실시간 주식 거래 플랫폼**입니다.

1. **매칭 엔진** (`wrapper/`): Kinesis에서 주문을 받아 Liquibook으로 매칭, 체결 결과를 Kinesis로 발행
2. **스트리밍** (`streamer/node/`): Valkey에서 호가/캔들을 폴링하여 WebSocket으로 브로드캐스트
3. **MM 서비스 v10** (`mm-service/`): Strategy Pattern + OrderManager + InventoryTracker + PriceFeed
4. **백엔드 프로세서** (`Supernoba-back`): Kinesis 이벤트를 소비하여 DynamoDB/PostgreSQL 업데이트
5. **프론트엔드** (`Supernoba-front`): React + Redux로 실시간 거래 UI 제공

**주요 이벤트 흐름**:
```
주문 → order-router → Kinesis → Matching Engine → Kinesis → stock-processor → DynamoDB/WebSocket
```

**MM 이벤트 흐름**:
```
Admin Panel → admin-mm Lambda → mm:control (Pub/Sub) → MM Service → Kinesis → Matching Engine
```

**EC2**: 단일 t2.xlarge (172.31.10.211) — engine, streamer, mm, processor, aggregator 5개 서비스 통합
**배포**: 모든 배포는 GitHub Actions 자동화 (develop push → 빌드 → 배포 → 검증 → Slack 알림)

---

*마지막 업데이트: 2026-03-19 by Claude Opus 4.6*
