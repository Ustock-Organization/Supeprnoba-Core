# Supernoba 프로젝트 가이드라인

> AWS 기반 실시간 주식 거래 플랫폼. C++ 매칭 엔진, React 프론트엔드, Lambda 마이크로서비스로 구성.

---

## 프로젝트 개요

**Supernoba**는 실시간 주식 거래 시뮬레이션 플랫폼으로, 다음 3개의 주요 저장소로 구성됩니다:

| 저장소 | 경로 | 기술 스택 | 역할 |
|--------|------|----------|------|
| **liquibook** | `C:\develop\liquibook` | C++17, Node.js, Lambda | 매칭 엔진, 스트리밍, Lambda 함수 |
| **Supernoba-front** | `C:\develop\Supernoba-front` | React 18, Redux Toolkit | 웹/모바일 프론트엔드 |
| **Supernoba-back** | `C:\develop\Supernoba-back` | C++17 | Lambda 통합 프로세서 (stock-processor) |

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

### 1. liquibook (C++ 매칭 엔진 + Lambda)

```
liquibook/
├── wrapper/                      # C++ 매칭 엔진 (EC2: stock-streamer)
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
├── streamer/node/               # 스트리밍 서버 (EC2: stock-streamer)
│   ├── index.mjs               # WebSocket 브로드캐스트 (50/500ms 폴링)
│   └── package.json
│
├── aggregator/                  # 캔들 집계 (EC2: stock-aggregator)
│   ├── src/
│   │   ├── main.cpp
│   │   └── aggregator.cpp       # 1분 → 상위 타임프레임
│   └── CMakeLists.txt
│
├── mm-service/                  # Market Maker 서비스 (EC2: server/stock-bastion)
│   ├── index.mjs               # MM 서비스 메인 (v7)
│   ├── run_mm.sh               # 실행 스크립트
│   ├── package.json            # 의존성
│   └── CLAUDE.md               # MM 서비스 문서
│
├── lambda/                      # AWS Lambda 함수들
│   ├── Supernoba-order-router/  # 주문 검증 및 Kinesis 전송
│   ├── Supernoba-admin/         # 종목 관리
│   ├── Supernoba-chart-data-handler/  # 차트 조회
│   ├── Supernoba-connect-handler/     # WebSocket $connect
│   ├── Supernoba-subscribe-handler/   # 종목 구독
│   ├── Supernoba-disconnect-handler/  # WebSocket $disconnect
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
│   └── reset-platform.sh      # 플랫폼 초기화 스크립트
│
└── .github/workflows/           # CI/CD
    ├── deploy-lambda.yml        # Lambda 자동 배포
    └── deploy-engine.yml        # Engine 자동 배포
```

### 2. Supernoba-front (React 프론트엔드)

```
Supernoba-front/
├── src/
│   ├── app/App.js               # 라우팅, 인증, WebSocket 초기화
│   ├── modules/                 # 페이지 모듈
│   │   ├── Main/               # 메인 거래 페이지
│   │   ├── Grid/               # 위젯 레이아웃 (react-grid-layout)
│   │   ├── Navbar/             # 네비게이션 바
│   │   ├── Admin/              # 관리자 대시보드
│   │   └── MobilePage/         # 모바일 페이지
│   ├── widgets/                # 위젯 컴포넌트
│   │   ├── Chart/              # 캔들차트 (lightweight-charts)
│   │   ├── Trading/            # 주문 입력 폼
│   │   ├── Orderbook/          # 호가창
│   │   ├── Position/           # 포지션 정보
│   │   └── favorite/           # 즐겨찾기
│   ├── services/
│   │   ├── WebSocketService.js # WebSocket 연결 관리
│   │   ├── websocket/MessageHandler.js  # 메시지 처리
│   │   └── ApiService.js       # REST API 클라이언트
│   ├── shared/redux/
│   │   ├── Store.js            # Redux Store
│   │   └── slices/
│   │       ├── AuthSlice.js    # 인증 상태
│   │       ├── MarketSlice.js  # 마켓 데이터 (depth, ticker)
│   │       ├── TradingSlice.js # 현재 종목
│   │       └── OrderSlice.js   # 주문/거래 이력
│   └── lib/cognitoClient.js    # AWS Cognito OAuth
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
├── CMakeLists.txt
└── vcpkg.json
```

---

## 기술 스택

### 백엔드

| 컴포넌트 | 기술 | 버전 |
|----------|------|------|
| 매칭 엔진 | C++ (Liquibook) | C++17 |
| 스트리밍 | Node.js | 20.x |
| Lambda | JavaScript (ESM) | Node 20 |
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

## 자주 사용되는 명령어

### 빌드 및 배포

```bash
# === liquibook ===

# Lambda 전체 배포
cd C:\develop\liquibook\lambda
powershell .\deploy-all-lambdas.ps1

# C++ 엔진 빌드 (EC2에서)
cd ~/liquibook/wrapper
cmake -B build -S . -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=~/vcpkg/scripts/buildsystems/vcpkg.cmake
cmake --build build -j$(nproc)
./run_engine.sh --debug

# Streamer 실행 (EC2에서)
cd ~/liquibook/streamer/node
npm install
./run_streamer.sh

# === Supernoba-front ===

# 개발 서버
cd C:\develop\Supernoba-front
yarn start

# 프로덕션 빌드
yarn build

# === Supernoba-back ===

# stock-processor 빌드 (EC2에서)
cd ~/Supernoba-back
cmake -B build -S . -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=~/vcpkg/scripts/buildsystems/vcpkg.cmake
cmake --build build -j$(nproc)
./build/stock-processor
```

### Git 작업

```bash
# liquibook 커밋 및 배포
cd C:\develop\liquibook
git add .
git commit -m "feat: 기능 설명"
git push origin develop  # GitHub Actions 자동 배포 트리거

# Supernoba-front 커밋
cd C:\develop\Supernoba-front
git add .
git commit -m "fix: 수정 내용"
git push origin develop
```

### AWS 확인

```bash
# Lambda 함수 상태 확인
aws lambda get-function --function-name Supernoba-order-router --region ap-northeast-2 --query 'Configuration.[State,LastModified]'

# Kinesis 스트림 확인
aws kinesis describe-stream --stream-name supernoba-orders --region ap-northeast-2

# EC2 인스턴스 확인
aws ec2 describe-instances --filters "Name=tag:Name,Values=stock-*" --query 'Reservations[].Instances[].[InstanceId,State.Name,Tags[?Key==`Name`].Value|[0]]' --region ap-northeast-2
```

---

## 자주 내려지는 명령어 패턴

### 1. 코드 분석 및 검토

```
"Supernoba-back 프로젝트 코드를 검토해줘"
"stock-processor에서 fill 처리 로직을 분석해줘"
"WebSocket 메시지 전송 코드를 확인해줘"
"prevClose 필드가 제대로 전송되는지 확인해줘"
```

### 2. 버그 수정 및 기능 추가

```
"프론트엔드에서 prevClose가 표시되지 않는 문제를 수정해줘"
"market_data_handler.cpp에 pc 필드를 추가해줘"
"MarketSlice.js에서 dayOpen fallback을 추가해줘"
"사용되지 않는 Lambda를 정리해줘"
```

### 3. 아키텍처 변경

```
"Lambda 함수를 stock-processor (C++)로 이전해줘"
"Kinesis 이벤트 체인을 검토해줘"
"DynamoDB 원자적 트랜잭션을 확인해줘"
"전일종가 집계 로직을 RDS에서 처리하도록 SQL을 작성해줘"
```

### 4. 배포

```
"Git 커밋하고 배포해줘"
"Lambda 배포 스크립트를 실행해줘"
"GitHub Actions 워크플로우 상태를 확인해줘"
"EC2에 수동 배포해줘"
```

### 5. 에이전트 활용

```
"ai-agents 프로젝트에서 20명의 에이전트를 소환해서 토론시켜줘"
"병렬로 여러 파일을 분석해줘"
"context-aware-architect 에이전트로 아키텍처를 분석해줘"
```

---

## EC2 인스턴스 구성

| SSH 별칭 | 인스턴스명 | 역할 | systemd 서비스 |
|----------|------------|------|---------------|
| `server` | stock-bastion | Matching Engine, **MM Service** | `supernoba-engine`, `supernoba-mm` |
| `streamer` | stock-streamer | Streamer | `supernoba-streamer` |
| `processor` | stock-processor | Stock Processor | `supernoba-processor` |
| `aggregator` | stock-aggregator | Aggregator | `supernoba-aggregator` |

**서비스 제어 (systemd):**
```bash
./supernoba-ctl.sh start all      # 시작
./supernoba-ctl.sh stop all       # 종료
./supernoba-ctl.sh restart all    # 재시작
./supernoba-ctl.sh health         # 헬스체크
./supernoba-ctl.sh kill-all       # 강제 종료
```

**전체 배포:**
```bash
./supernoba-ctl.sh deploy         # git pull + build + restart
```

---

## 배포 자동화 (deploy/)

systemd 기반 서비스 관리 및 배포 자동화. 상세: `deploy/README.md`

### 디렉토리 구조
- `env/` - 환경변수 파일 (common + 서비스별)
- `systemd/` - systemd 서비스 파일
- `logrotate/` - 로그 로테이션 설정

### 주요 스크립트

| 스크립트 | 역할 |
|---------|------|
| `supernoba-ctl.sh` | 마스터 제어 (start/stop/restart/logs/health/kill) |
| `install-services.sh` | systemd 서비스 설치 (동적 메모리 할당) |
| `reset-platform.sh` | 플랫폼 데이터 전체 초기화 |

### 호스트별 서비스 자동 감지

스크립트가 호스트명을 자동 감지하여 해당 서비스만 제어:

| 호스트명 | 자동 실행 서비스 |
|----------|----------------|
| stock-bastion | engine, mm |
| stock-streamer | streamer |
| stock-processor | processor |
| stock-aggregator | aggregator |

### 설치 및 사용

```bash
# 최초 설치 (root 필요)
sudo ./install-services.sh

# 서비스 활성화 및 시작
./supernoba-ctl.sh enable all
./supernoba-ctl.sh start all

# 플랫폼 초기화 (주의: 모든 데이터 삭제!)
./reset-platform.sh --dry-run     # 삭제 대상 확인
./reset-platform.sh --confirm     # 실제 초기화
```

---

## Valkey (Redis) 키 구조

```
# 실시간 호가
depth:{SYMBOL}                    # JSON: {b: [[price, qty]...], a: [...]}

# 티커 정보
ticker:{SYMBOL}                   # JSON: {p, c, cp, h, l, v, pc}

# 캔들 데이터
candle:1m:{SYMBOL}               # Hash: {o, h, l, c, v, t, t_epoch}
candle:closed:1m:{SYMBOL}        # List: 마감된 1분봉 (집계 대기)

# 전일종가
prev:{SYMBOL}                    # String: 전일 종가

# WebSocket 연결
user:{userId}:connections        # Set: 사용자 연결 ID 목록
ws:{connectionId}                # String: 연결 정보
symbol:{SYMBOL}:main             # Set: 해당 종목 구독 연결 목록

# Market Maker (MM)
mm:control                       # Pub/Sub: 제어 명령 채널 (start, stop, reload)
mm:status                        # Pub/Sub: 상태 브로드캐스트 채널
mm:running                       # String: 전체 실행 상태 (1/0)
mm:running:symbols               # Set: 실행 중인 종목 목록
mm:config:{SYMBOL}               # Hash: 종목별 MM 설정 (basePrice, period, amplitude 등)
mm:price:{SYMBOL}                # String: 현재 MM 가격
mm:started_at:{SYMBOL}           # String: 종목 시작 시간

# 종목 관리
subscribed:symbols               # Set: 구독 가능한 종목 목록
deleted:symbols                  # Set: 삭제된 종목 목록 (복구 대기)
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
2. 또는 수동 배포: EC2에 SSH 접속 후 `git pull && make`

### WebSocket 연결 끊김

**증상**: 실시간 데이터 수신 중단
**원인**: API Gateway 연결 타임아웃 (10분)
**해결**: 프론트엔드에서 지수 백오프 재연결 로직 확인

### prevClose 미표시

**증상**: 전일종가가 0 또는 표시되지 않음
**원인**:
1. C++ wrapper에서 `pc` 필드 미전송
2. 프론트엔드에서 fallback 미처리
**해결**:
1. `market_data_handler.cpp`에서 `depth_json["pc"]` 추가
2. `MarketSlice.js`에서 `dayOpen` fallback 추가

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

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

**타입:**
- `feat`: 새 기능
- `fix`: 버그 수정
- `refactor`: 코드 리팩토링
- `docs`: 문서 수정
- `chore`: 빌드, 설정 변경
- `test`: 테스트 추가

---

## 중요 파일 경로

### 핵심 로직

| 파일 | 역할 |
|------|------|
| `liquibook/wrapper/src/market_data_handler.cpp` | 체결/호가 이벤트 처리, WebSocket 전송 |
| `liquibook/wrapper/src/engine_core.cpp` | Liquibook 오더북 래퍼 |
| `liquibook/wrapper/src/redis_client.cpp` | Valkey Lua Script (캔들 집계) |
| `Supernoba-back/src/processors/fill_processor.cpp` | 체결 처리 (DynamoDB 트랜잭션) |
| `Supernoba-front/src/services/WebSocketService.js` | WebSocket 연결 관리 |
| `Supernoba-front/src/shared/redux/slices/MarketSlice.js` | 마켓 데이터 상태 |

### 배포 설정

| 파일 | 역할 |
|------|------|
| `liquibook/.github/workflows/deploy-lambda.yml` | Lambda 자동 배포 |
| `liquibook/.github/workflows/deploy-engine.yml` | C++ 엔진 자동 배포 |
| `liquibook/lambda/deploy-all-lambdas.ps1` | Lambda 수동 배포 스크립트 |

### 환경 설정

| 파일 | 역할 |
|------|------|
| `liquibook/wrapper/run_engine.sh` | 엔진 환경변수 설정 |
| `Supernoba-front/src/config/env.js` | 프론트엔드 API 엔드포인트 |
| `Supernoba-back/include/config/config.h` | C++ 환경 설정 |

---

## 보안 고려사항

- **MM (Market Maker) ID 관리**: `mm-buyer`, `mm-seller`는 order-router에서 잔고 체크를 우회
- **AWS Secrets Manager**: DB 자격증명, MM ID 목록 캐싱 (5분/1시간 TTL)
- **DynamoDB 낙관적 잠금**: `version` 필드로 동시성 제어
- **API 인증**: AWS Cognito JWT 토큰

---

## 다음 세션을 위한 컨텍스트

이 프로젝트는 **AWS 기반 실시간 주식 거래 플랫폼**입니다.

1. **매칭 엔진** (`wrapper/`): Kinesis에서 주문을 받아 Liquibook으로 매칭, 체결 결과를 Kinesis로 발행 (EC2: server)
2. **스트리밍** (`streamer/node/`): Valkey에서 호가/캔들을 폴링하여 WebSocket으로 브로드캐스트 (EC2: streamer)
3. **MM 서비스** (`mm-service/`): Admin 패널에서 제어하는 마켓메이커, Kinesis에 주문 발행 (EC2: server)
4. **백엔드 프로세서** (`Supernoba-back`): Kinesis 이벤트를 소비하여 DynamoDB/PostgreSQL 업데이트 (EC2: processor)
5. **프론트엔드** (`Supernoba-front`): React + Redux로 실시간 거래 UI 제공

**주요 이벤트 흐름**:
```
주문 → order-router → Kinesis → Matching Engine → Kinesis → stock-processor → DynamoDB/WebSocket
```

**MM 이벤트 흐름**:
```
Admin Panel → admin-mm Lambda → mm:control (Pub/Sub) → MM Service → Kinesis → Matching Engine
```

**현재 상태** (2026-01-18):
- 4개 Lambda (fill-processor, history-saver, notifier, order-status-processor)가 `stock-processor` (C++)로 이전됨
- MM Service v7: `mm:config` HASH 타입 지원, server 인스턴스에서 실행
- 종목 관리 기능 개선: 비활성화 종목 UI, 복구 기능
- **배포 자동화**: systemd 서비스 관리, 동적 메모리 할당, 플랫폼 초기화 스크립트 추가

---

*마지막 업데이트: 2026-01-18 by Claude Opus 4.5*
