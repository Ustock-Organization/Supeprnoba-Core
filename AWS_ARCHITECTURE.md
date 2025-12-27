# AWS Supernoba 아키텍처

Amazon Kinesis + Valkey 기반 실시간 매칭 엔진 인프라 (2025-12-21 최신)

> **핵심 원칙**: Kinesis는 주문/체결용만 사용. Depth 데이터는 Valkey에 직접 저장 → Streamer가 폴링하여 WebSocket 푸시.

---
## 현재 운영 아키텍처 (전체 흐름)

```mermaid
%%{init: {'theme': 'dark', 'themeVariables': { 'fontSize': '10px' }}}%%
flowchart TD
    Client[클라이언트<br/>Web/Mobile/Test]
    
    Gateway[API Gateway<br/>WebSocket + REST]
    
    Lambda[Lambda Functions<br/>connect/subscribe/order-router<br/>fill-processor/history-saver/chart/admin]
    
    Kinesis[Kinesis Streams<br/>supernoba-orders 4 Shards<br/>supernoba-fills 2 Shards]
    
    Engine[C++ 매칭 엔진 EC2<br/>KinesisConsumer → Liquibook<br/>MarketDataHandler → NotificationClient]
    
    Valkey[Valkey Cache<br/>depth/candle/ticker/ws/user/symbol]
    
    Streamer[Streamer EC2<br/>50ms/500ms 폴링<br/>WebSocket 푸시]
    
    Storage[영구 저장소<br/>DynamoDB Orders<br/>Aurora PostgreSQL<br/>DynamoDB Candles]
    
    Supabase[Supabase<br/>wallets + auth]
    
    Client -->|WebSocket/REST| Gateway
    Gateway -->|라우팅| Lambda
    Lambda -->|주문 검증| Kinesis
    Kinesis -->|주문 수신| Engine
    Engine -->|호가/캔들 저장| Valkey
    Engine -->|체결 발행| Kinesis
    Engine -->|직접 알림| Gateway
    Kinesis -->|Fan-Out| Lambda
    Lambda -->|Orders/Wallets| Storage
    Lambda -->|JWT/잔고| Supabase
    Streamer -->|폴링| Valkey
    Streamer -->|푸시| Gateway
    Gateway -->|실시간 데이터| Client
    
    style Valkey fill:#DC382D,color:#fff
    style Engine fill:#00599C,color:#fff
    style Streamer fill:#2196F3,color:#fff
    style Kinesis fill:#FF9900,color:#000
    style Storage fill:#4CAF50,color:#fff
```

### 데이터 흐름 요약

| # | 단계 | 컴포넌트 | 데이터 예시 | 지연시간 |
|---|------|----------|-------------|----------|
| ① | **주문 제출** | 클라이언트 → API Gateway | `POST /orders {symbol:"TEST", side:"BUY", price:150, qty:10}` | ~50ms |
| ② | **주문 검증** | order-router Lambda | `active:symbols` 확인 + Supabase 잔고 잠금 | ~100ms |
| ③ | **Kinesis 전송** | Lambda → Kinesis | `{action:"ADD", symbol:"TEST", is_buy:true, price:150, quantity:10}` | ~10ms |
| ④ | **엔진 소비** | KinesisConsumer → Liquibook | 매칭 로직 실행 → 체결 발생 | ~3μs |
| ⑤ | **Valkey 저장** | MarketDataHandler | `depth:TEST`, `candle:1m:TEST` (Lua Script) | ~1ms |
| ⑥ | **Kinesis Fan-Out** | KinesisProducer → Kinesis | `{event:"FILL", buyer:{...}, seller:{...}}` | ~10ms |
| ⑦ | **Lambda 처리** | fill-processor, history-saver | DynamoDB Orders + RDS trade_history + Supabase Wallets | ~200ms |
| ⑧ | **직접 알림** | NotificationClient | Engine → API Gateway → 클라이언트 (주문 상태) | ~5ms |
| ⑨ | **Streamer 폴링** | Streamer (EC2) | 50ms(로그인) / 500ms(익명) 주기로 Valkey 폴링 | 50~500ms |
| ⑩ | **WebSocket 푸시** | Streamer → API Gateway | `{e:"d", s:"TEST", b:[[150,30]], a:[[151,20]]}` | ~10ms |
| ⑪ | **클라이언트 수신** | API Gateway → 클라이언트 | 호가창/차트 실시간 업데이트 | ~20ms |

### 캔들 데이터 흐름 (상세)

```mermaid
%%{init: {'theme': 'dark', 'themeVariables': { 'fontSize': '10px' }}}%%
sequenceDiagram
    participant Trade as 체결
    participant Handler as Handler
    participant Lua as Lua Script
    participant Valkey as Valkey
    participant Streamer as Streamer
    participant WS as Gateway
    participant Client as 클라이언트
    
    Note over Trade: on_fill() 호출
    Trade->>Handler: price, qty, timestamp
    Handler->>Lua: EVAL updateCandle
    Lua->>Valkey: HGET candle:1m:SYMBOL t
    alt 같은 분
        Lua->>Valkey: HSET h,l,c<br/>HINCRBY v
    else 새 분
        Lua->>Valkey: LPUSH closed<br/>HMSET 새 캔들
    end
    Valkey-->>Lua: OK
    
    Note over Streamer: 50ms 폴링
    Streamer->>Valkey: HGETALL candle:1m:SYMBOL
    Valkey-->>Streamer: {o,h,l,c,v,t}
    Streamer->>WS: PostToConnection
    WS->>Client: WebSocket
    Client->>Client: TradingView update()
```

---

## 🧪 테스트 클라이언트 데이터 흐름

```mermaid
%%{init: {'theme': 'dark', 'themeVariables': { 'fontSize': '10px' }}}%%
flowchart TD
    TC[Test Console<br/>UI/WebSocket/주문/차트/관리자]
    
    WSS[API Gateway WS<br/>l2ptm85wub]
    REST1[API Gateway REST<br/>4xs6g4w8l6]
    REST2[API Gateway Admin<br/>0eeto6kblk]
    
    CONN[connect-handler]
    SUB[subscribe-handler]
    ROUTER[order-router]
    CHARTAPI[chart-data-handler]
    ADMIN[admin]
    
    TC -->|① WSS 연결| WSS
    TC -->|② subscribe| WSS
    TC -->|③ POST 주문| REST1
    TC -->|④ GET 차트| REST1
    TC -->|⑤ Admin| REST2
    
    WSS --> CONN
    WSS --> SUB
    REST1 --> ROUTER
    REST1 --> CHARTAPI
    REST2 --> ADMIN
    
    WSS -.->|⑥ depth/candle 수신| TC
    
    style WSS fill:#FF9900,color:#000
    style REST1 fill:#FF9900,color:#000
    style REST2 fill:#FF9900,color:#000
```

### API 엔드포인트 목록

| # | 기능 | 메서드 | 엔드포인트 | 데이터 예시 |
|---|------|--------|-----------|-------------|
| ① | **WebSocket 연결** | WSS | `wss://l2ptm85wub.execute-api.ap-northeast-2.amazonaws.com/production/` | `?userId=test-user-1&testMode=true` |
| ② | **심볼 구독** | WS Send | (WebSocket) | `{action:"subscribe", main:"TEST"}` |
| ③ | **주문 제출** | POST | `https://4xs6g4w8l6.../restV2/orders` | `{symbol:"TEST", side:"BUY", price:1000, quantity:10}` |
| ④ | **차트 조회** | GET | `https://4xs6g4w8l6.../restV2/chart` | `?symbol=TEST&interval=1m&limit=100` |
| ⑤ | **종목 관리** | GET/POST | `https://0eeto6kblk.../admin/Supernoba-admin` | `{symbol:"TEST"}` (추가 시) |
| ⑥ | **실시간 수신** | WS Recv | (WebSocket) | `{e:"d", s:"TEST", b:[[1000,10]], a:[[1001,5]]}` |

### 테스트 클라이언트 → 차트 업데이트 흐름

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. 초기 로드 (Main 구독 시)                                               │
├─────────────────────────────────────────────────────────────────────────┤
│  subscribeMain()                                                        │
│       ↓                                                                 │
│  ws.send({action:"subscribe", main:"TEST"})                             │
│       ↓                                                                 │
│  loadChartHistory("TEST")                                               │
│       ↓                                                                 │
│  fetch("/chart?symbol=TEST&interval=1m&limit=100")                      │
│       ↓                                                                 │
│  candleSeries.setData(result.data)  ← 차트 전체 교체                      │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ 2. 실시간 업데이트 (WebSocket 수신)                                       │
├─────────────────────────────────────────────────────────────────────────┤
│  ws.onmessage → handleMessage(msg)                                      │
│       ↓                                                                 │
│  if (msg.e === 'candle')                                                │
│       ↓                                                                 │
│  updateLiveCandleChart(msg)                                             │
│       ↓                                                                 │
│  ymdhmToEpoch("202512161420") → 1734345600                              │
│       ↓                                                                 │
│  candleSeries.update({time:1734345600, o:150, h:155, l:148, c:152})     │
└─────────────────────────────────────────────────────────────────────────┘
```

### 수신 메시지 포맷

| 이벤트              | 필드                                     | 예시                                                                                         |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------ |
| **depth**        | `e`, `s`, `b`, `a`, `t`                | `{e:"d", s:"TEST", b:[[1000,10],[999,20]], a:[[1001,5]], t:1734345600000}`                 |
| **candle**       | `e`, `s`, `o`, `h`, `l`, `c`, `v`, `t` | `{e:"candle", s:"TEST", o:"1000", h:"1050", l:"980", c:"1020", v:"100", t:"202512161420"}` |
| **candle_close** | (candle과 동일)                           | 1분봉 마감 시 발행                                                                                |
| **ticker**       | `e`, `s`, `p`, `c`, `yc`               | `{e:"t", s:"TEST", p:1000, c:2.5, yc:-1.2}`                                                |

## 실시간 스트리밍 흐름 (JWT 인증 포함)

```mermaid
%%{init: {'theme': 'dark', 'themeVariables': { 'fontSize': '10px' }}}%%
sequenceDiagram
    participant C as 클라이언트
    participant G as Gateway WS
    participant Conn as connect-handler
    participant Sub as subscribe-handler
    participant V as Valkey
    participant E as Engine
    participant S as Streamer

    Note over C: 1. WebSocket 연결
    C->>G: ?token=JWT or ?testMode=true
    G->>Conn: $connect
    alt 로그인
        Conn->>V: SET ws:CONNID<br/>SADD user:USERID:connections<br/>SADD realtime:connections
    else 익명
        Conn->>V: SET ws:CONNID<br/>{isLoggedIn:false}
    end
    G-->>C: 연결 완료
    
    Note over C: 2. 심볼 구독
    C->>G: {"action":"subscribe","main":"TEST"}
    G->>Sub: subscribe
    Sub->>V: SADD symbol:TEST:main CONNID<br/>SADD subscribed:symbols TEST
    G-->>C: 구독 확인
    
    Note over E: 3. 주문 처리
    E->>E: Liquibook 매칭
    E->>V: SET depth:TEST<br/>EVAL candle:1m:TEST<br/>SET ticker:TEST
    
    Note over S: 4. 실시간 스트리밍
    loop 50ms (로그인)
        S->>V: SMEMBERS realtime:connections<br/>SMEMBERS symbol:TEST:main<br/>GET depth + HGETALL candle
        V-->>S: 데이터
        S->>G: PostToConnection
        G->>C: 실시간 푸시
    end
    
    loop 500ms (익명)
        S->>V: 캐시 조회
        S->>G: PostToConnection
        G->>C: 캐시 푸시
    end
```

### 주문 상태 실시간 알림 흐름 (직접 전송)

```mermaid
%%{init: {'theme': 'dark', 'themeVariables': { 'fontSize': '10px' }}}%%
sequenceDiagram
    participant C as 클라이언트
    participant WS as Gateway WS
    participant Conn as connect-handler
    participant V as Valkey
    participant E as Engine
    participant N as NotificationClient<br/>Worker Thread
    participant API as Gateway<br/>Management API

    Note over C: 1. 연결 등록
    C->>WS: WebSocket ?token=JWT
    WS->>Conn: $connect
    Conn->>V: SET ws:CONNID<br/>SADD user:USERID:connections
    WS-->>C: 연결 완료
    
    Note over E: 2. 주문 처리
    E->>E: Liquibook 매칭
    alt 접수/체결/거부/취소
        E->>N: on_accept/fill/reject/cancel
        N->>N: 큐에 추가
    end
    
    Note over N: 3. 백그라운드 처리
    loop 워커 루프
        N->>N: 큐에서 추출
        N->>V: SMEMBERS user:USERID:connections
        V-->>N: [CONNID1, CONNID2]
        par 병렬 전송
            N->>API: PostToConnection(CONNID1)
            API->>WS: 연결 확인
            WS->>C: WebSocket 메시지
        and
            N->>API: PostToConnection(CONNID2)
            API->>WS: 연결 확인
            WS->>C: WebSocket 메시지
        end
    end
    
    Note right of N: 지연시간 < 5ms<br/>Kinesis 거치지 않음
```

**직접 알림 아키텍처 (Direct Notification):**
1. **연결 시**: `connect-handler`가 `user:{userId}:connections` Set에 connectionId 저장
2. **주문 처리 시**: `MarketDataHandler`가 `NotificationClient::enqueue()` 호출
3. **백그라운드 처리**: Worker Thread가 큐에서 메시지 추출 → Valkey에서 연결 ID 조회
4. **직접 전송**: `NotificationClient` → API Gateway Management API (HTTPS) → 클라이언트
5. **장점**: Kinesis를 거치지 않아 지연시간 < 5ms (기존 Kinesis 방식 대비 10배 이상 개선)

---

## 차트 데이터 아키텍처

> **Valkey 중심 설계**: C++ Engine에서 Lua Script로 캔들 집계, Lambda는 백그라운드 백업만 담당

```mermaid
%%{init: {'theme': 'dark', 'themeVariables': { 'fontSize': '10px' }}}%%
flowchart TD
    Engine[Engine: 체결 → Handler → Lua Script]
    Active[candle:1m:SYMBOL Hash<br/>EXPIRE 300초]
    Closed[candle:closed:1m:SYMBOL List<br/>EXPIRE 3600초]
    OHLC[ohlc:SYMBOL<br/>당일 OHLC]
    
    FastPoll[Streamer: 50ms 폴링<br/>로그인 사용자]
    SlowPoll[Streamer: 500ms 폴링<br/>익명 사용자]
    Cache[캐시 레이어]
    
    HistSaver[history-saver<br/>Kinesis fills → RDS]
    ChartAPI[chart-data-handler<br/>Hot/Cold 병합]
    Aggregator[aggregator C++<br/>1m → 상위 타임프레임]
    
    RDS[(Aurora PostgreSQL<br/>trade_history)]
    DDB[(DynamoDB<br/>candle_history)]
    S3[(S3 백업)]
    
    Client[클라이언트<br/>TradingView Charts]
    
    Engine -->|updateCandle| Active
    Engine -->|당일 OHLC| OHLC
    Active -.->|분 변경| Closed
    
    Active --> FastPoll
    Active --> SlowPoll
    FastPoll --> Cache
    Cache --> SlowPoll
    FastPoll --> Client
    SlowPoll --> Client
    
    Closed --> HistSaver
    HistSaver --> RDS
    HistSaver -.-> S3
    
    ChartAPI --> Active
    ChartAPI --> DDB
    ChartAPI --> Client
    
    Closed -.-> Aggregator
    Aggregator --> DDB
    Aggregator -.-> S3
    
    style Active fill:#DC382D,color:#fff
    style Closed fill:#DC382D,color:#fff
    style Engine fill:#00599C,color:#fff
    style FastPoll fill:#2196F3,color:#fff
    style RDS fill:#4CAF50,color:#fff
    style DDB fill:#4CAF50,color:#fff
```

### 캔들 처리 흐름

| 단계 | 컴포넌트 | 지연시간 |
|------|----------|----------|
| 체결 → 캔들 집계 | C++ Engine (Lua Script) | ~1ms |
| 캔들 → 클라이언트 | Streamer (50ms/500ms) | 50~500ms |
| 캔들 → 영구 저장 | Lambda (10분마다) | ~분 단위 |

### 타임프레임별 전략 (TradingView Lightweight Charts 준수)

| 타임프레임 | 과거 데이터 | 실시간 업데이트 |
|------------|------------|-----------------|
| **1분** | DynamoDB `CANDLE#SYMBOL#1m` | WebSocket 1분봉 직접 표시 |
| 3분, 5분, 15분, 30분 | DynamoDB 사전 집계 | 클라이언트에서 1분봉 → 집계 |
| **1시간, 4시간, 1일** | DynamoDB 사전 집계 | 클라이언트에서 1분봉 → 집계 |

### TradingView Lightweight Charts 데이터 처리

```
타임프레임 버튼 클릭 (예: 5분)
        ↓
Chart API 호출: /chart?symbol=TEST&interval=5m&limit=200
        ↓
candleSeries.setData(apiData)  ← 전체 데이터 교체 (권장)
        ↓
WebSocket 실시간: 1분봉 수신
        ↓
클라이언트에서 5분봉으로 집계
        ↓
candleSeries.update(aggregatedCandle)  ← 마지막 캔들만 업데이트 (권장)
```

**핵심 원칙**:
- `setData()`: 타임프레임 전환 시 사용 (전체 데이터 교체)
- `update()`: 실시간 업데이트 시 사용 (마지막 캔들만)

---

## Kinesis 스트림 구성

| 스트림 | Shards | 용도 | 방향 | 소비자 |
|--------|--------|------|------|--------|
| `supernoba-orders` | 4 | 주문 입력 | Lambda → Engine | C++ KinesisConsumer |
| `supernoba-fills` | 2 | 체결 이벤트 (Fan-Out) | Engine → Lambda | fill-processor<br/>history-saver<br/>notifier |

> ⚠️ **중요**: 
> - `supernoba-depth` 스트림은 **사용하지 않음**. Depth는 Valkey에 직접 저장.
> - `supernoba-order-status` 스트림은 **삭제됨**. 주문 상태는 Engine에서 직접 WebSocket 전송.
> - `supernoba-trades` 스트림은 현재 미사용 (필요시 추가 가능).

---

## ElastiCache 구성 (Dual Valkey)

| 캐시 | 엔드포인트 | 용도 | TLS |
|------|-----------|------|-----|
| **Backup Cache** | `master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com:6379` | 오더북 스냅샷, 전일 데이터 | ❌ |
| **Depth Cache** | `supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com:6379` | 실시간 호가, 구독자 관리 | ❌ |

---

## Redis 키 구조

### Depth Cache (실시간 데이터)

| 키 패턴                        | 타입     | 용도                                                  | 생성 위치                                     |
| --------------------------- | ------ | --------------------------------------------------- | ----------------------------------------- |
| `depth:SYMBOL`              | String | 실시간 호가 10단계 (Main)                                  | C++ `market_data_handler.cpp`             |
| `ticker:SYMBOL`             | String | 간략 시세 (Sub)                                         | C++ `updateTickerCache()`                 |
| `active:symbols`            | Set    | 거래 가능 종목 목록 (Admin 관리)                              | `symbol-manager`                          |
| `subscribed:symbols`        | Set    | 현재 구독자 있는 심볼 (자동)                                   | `subscribe-handler`, `disconnect-handler` |
| `symbol:SYMBOL:main`        | Set    | Main 구독자 connectionId                               | `subscribe-handler`                       |
| `symbol:SYMBOL:sub`         | Set    | Sub 구독자 connectionId                                | `subscribe-handler`                       |
| `symbol:SYMBOL:subscribers` | Set    | 레거시 구독자 (호환용)                                       | `subscribe-handler`                       |
| `conn:CONNID:main`          | String | 연결별 Main 구독 심볼                                      | `subscribe-handler`                       |
| `ws:CONNID`                 | String | WebSocket 연결 정보 `{userId, isLoggedIn, connectedAt}` | `connect-handler`                         |
| `user:USERID:connections`   | Set    | 사용자별 연결 목록                                          | `connect-handler`                         |
| `realtime:connections`      | Set    | 로그인 사용자 connectionId 목록 (50ms 폴링)                   | `connect-handler`                         |
| `candle:1m:SYMBOL`          | Hash   | 활성 1분봉 `{o, h, l, c, v, t, t_epoch}`<br/>EXPIRE 300초 | C++ Lua Script (`updateCandle`) |
| `candle:closed:1m:SYMBOL`   | List   | 마감 1분봉 버퍼 (최대 1000개, 백업 전)<br/>EXPIRE 3600초 | C++ Lua Script (분 변경 시) |
| `ohlc:SYMBOL`               | String | 당일 OHLC 캐시 `{o, h, l, c, v, change, t}` | C++ `updateTickerCache()` |

### Backup Cache (영구 데이터)

| 키 패턴 | 타입 | 용도 | 생성 위치 |
|---------|------|------|----------|
| `snapshot:SYMBOL` | String | 오더북 스냅샷 | C++ `redis_client.cpp` |
| `prev:SYMBOL` | String | 전일 OHLC | C++ `savePrevDayData()` |

---

## 데이터 포맷

### Depth (호가창)

```json
{"e":"d","s":"TEST","t":1733896438267,"b":[[150,30],[149,20]],"a":[[151,30],[152,25]]}
```

| 필드 | 설명 |
|------|------|
| `e` | 이벤트 타입 ("d" = depth) |
| `s` | 심볼 |
| `t` | 타임스탬프 (epoch ms) |
| `b` | Bids `[[price, qty], ...]` (최대 10개) |
| `a` | Asks `[[price, qty], ...]` (최대 10개) |

### Ticker (전광판)

```json
{"e":"t","s":"TEST","t":1733896438267,"p":150,"c":2.5,"yc":-1.2}
```

| 필드 | 설명 |
|------|------|
| `e` | 이벤트 타입 ("t" = ticker) |
| `p` | 현재가 |
| `c` | 금일 등락률 (%) |
| `yc` | 전일 등락률 (%) |

---

## Lambda 함수

| 함수명 | 트리거 | 역할 | VPC | Kinesis 소비 |
|--------|--------|------|-----|-------------|
| `Supernoba-order-router` | API Gateway REST | 주문 검증 → DynamoDB Orders 생성 → Kinesis 전송<br/>Supabase 잔고 잠금 | ✅ | - |
| `Supernoba-admin` | API Gateway REST | 종목 관리 CRUD (`active:symbols` Set 관리) | ✅ | - |
| `Supernoba-connect-handler` | WebSocket `$connect` | JWT/testMode 검증 → `ws:CONNID`, `user:USERID:connections` 저장 | ✅ | - |
| `Supernoba-subscribe-handler` | WebSocket `subscribe` | Main/Sub 구독 등록 → `symbol:SYMBOL:main/sub` Set 관리 | ✅ | - |
| `Supernoba-disconnect-handler` | WebSocket `$disconnect` | 구독 정리, stale 연결 정리 | ✅ | - |
| `Supernoba-fill-processor` | Kinesis `supernoba-fills` | DynamoDB Orders 업데이트 (filled_qty, status)<br/>Supabase Wallets 잔고 이체 (RPC) | ✅ | ✅ |
| `Supernoba-history-saver` | Kinesis `supernoba-fills` | Aurora PostgreSQL `trade_history` 저장<br/>Partition 자동 생성 | ✅ | ✅ |
| `Supernoba-notifier` | Kinesis `supernoba-fills` | WebSocket 알림 (레거시, 현재는 Engine 직접 전송 사용) | ✅ | ✅ |
| `Supernoba-chart-data-handler` | API Gateway HTTP | Hot(Valkey) + Cold(DynamoDB) 병합 조회<br/>타임프레임별 캔들 데이터 반환 | ✅ | - |
| `Supernoba-asset-handler` | API Gateway HTTP | 사용자 자산 조회 (Supabase wallets) | ✅ | - |

### 인증 관련 환경변수 (connect-handler)

| 변수 | 설명 |
|------|------|
| `SUPABASE_URL` | Supabase 프로젝트 URL |
| `SUPABASE_ANON_KEY` | Supabase Anonymous Key |
| `ALLOW_TEST_MODE` | `true`면 testMode 파라미터 허용 (개발 환경) |

---

## EC2 인스턴스

| 역할 | Private IP | 타입 | 상태 |
|------|------------|------|------|
| **Matching Engine** | 172.31.47.97 | t2.medium | ✅ 운영 중 |
| **Streaming Server** | 172.31.57.219 | t2.micro | ✅ 운영 중 |

---

## 실행 스크립트

### 매칭 엔진 (C++)

```bash
cd ~/liquibook/wrapper
./run_engine.sh           # 기본 (INFO)
./run_engine.sh --debug   # 디버그 (DEBUG)
./run_engine.sh --dev     # 캐시 초기화 후 시작
```

### 스트리밍 서버 (Node.js)

```bash
cd ~/liquibook/streamer/node
./run_streamer.sh           # 기본
./run_streamer.sh --debug   # 디버그
./run_streamer.sh --init    # 익명 사용자 캐시 초기화
```

---

## C++ 매칭 엔진 구현 현황

| 컴포넌트 | 파일 | 설명 |
|----------|------|------|
| **KinesisConsumer** | `kinesis_consumer.cpp` | Kinesis `supernoba-orders` 소비 → 주문 수신 |
| **KinesisProducer** | `kinesis_producer.cpp` | 체결 이벤트 → Kinesis `supernoba-fills` 발행 (Fan-Out) |
| **EngineCore** | `engine_core.cpp` | Liquibook 래퍼, OrderBook 관리 |
| **MarketDataHandler** | `market_data_handler.cpp` | Liquibook 이벤트 리스너<br/>- on_fill: 캔들 업데이트, Kinesis 발행<br/>- on_depth_change: Valkey 저장<br/>- on_accept/reject/cancel: NotificationClient 호출 |
| **RedisClient** | `redis_client.cpp` | Valkey 연결 및 Lua Script 실행<br/>- updateCandle(): 원자적 캔들 집계 |
| **NotificationClient** | `notification_client.cpp` | 백그라운드 워커 스레드<br/>- 큐 기반 비동기 처리<br/>- API Gateway Management API 직접 호출 |
| **gRPC Service** | `grpc_service.cpp` | 스냅샷 API (CreateSnapshot, RestoreSnapshot) |
| **Metrics** | `metrics.cpp` | 통계 수집 (주문 수신/수락/거부, 체결 수) |

> **참고**: `DynamoDBClient`는 제거됨. 체결 저장은 Kinesis → Lambda (history-saver)로 처리.

---

## 환경변수

### 매칭 엔진 (C++)

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `KINESIS_ORDERS_STREAM` | `supernoba-orders` | 주문 입력 스트림 |
| `KINESIS_FILLS_STREAM` | `supernoba-fills` | 체결 이벤트 스트림 (Fan-Out) |
| `REDIS_HOST` | (Backup Cache) | 스냅샷 백업용 Valkey 호스트 |
| `REDIS_PORT` | `6379` | 스냅샷 백업용 Valkey 포트 |
| `DEPTH_CACHE_HOST` | (Depth Cache) | 실시간 호가/캔들용 Valkey 호스트 |
| `DEPTH_CACHE_PORT` | `6379` | 실시간 호가/캔들용 Valkey 포트 |
| `WEBSOCKET_ENDPOINT` | (없음) | API Gateway WebSocket 엔드포인트<br/>예: `wss://l2ptm85wub.execute-api.ap-northeast-2.amazonaws.com/production` |
| `AWS_REGION` | `ap-northeast-2` | AWS 리전 |
| `GRPC_PORT` | `50051` | gRPC 서버 포트 (스냅샷 API) |
| `LOG_LEVEL` | `INFO` | 로그 레벨 (DEBUG/INFO/WARN/ERROR) |

### 스트리밍 서버 (Node.js)

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `VALKEY_HOST` | (Depth Cache) | Valkey 호스트 (실시간 데이터) |
| `VALKEY_PORT` | `6379` | Valkey 포트 |
| `WEBSOCKET_ENDPOINT` | `l2ptm85wub...` | API Gateway WebSocket 엔드포인트 |
| `AWS_REGION` | `ap-northeast-2` | AWS 리전 |
| `DEBUG_MODE` | `false` | 디버그 모드 (상세 로그) |

### Lambda Functions

#### order-router
| 변수 | 설명 |
|------|------|
| `SUPABASE_URL` | Supabase 프로젝트 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Service Role Key (잔고 잠금용) |
| `ORDERS_TABLE` | DynamoDB Orders 테이블명 (기본: `supernoba-orders`) |
| `AWS_REGION` | AWS 리전 |

#### connect-handler
| 변수 | 설명 |
|------|------|
| `SUPABASE_URL` | Supabase 프로젝트 URL |
| `SUPABASE_ANON_KEY` | Supabase Anonymous Key (JWT 검증용) |
| `ALLOW_TEST_MODE` | `true`면 testMode 파라미터 허용 (개발 환경) |

#### fill-processor
| 변수 | 설명 |
|------|------|
| `SUPABASE_URL` | Supabase 프로젝트 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Service Role Key (잔고 이체용) |
| `ORDERS_TABLE` | DynamoDB Orders 테이블명 |

#### history-saver
| 변수 | 설명 |
|------|------|
| `DB_SECRET_ARN` | Secrets Manager ARN (RDS 인증 정보) |
| `RDS_ENDPOINT` | Aurora PostgreSQL 엔드포인트 |
| `DB_NAME` | 데이터베이스명 (기본: `postgres`) |
| `AWS_REGION` | AWS 리전 |

---

## 주문 JSON 포맷

```json
{
  "action": "ADD",
  "symbol": "TEST",
  "order_id": "ord_abc123",
  "user_id": "user_12345",
  "is_buy": true,
  "price": 15000,
  "quantity": 100
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `action` | string | `ADD`, `CANCEL`, `REPLACE` |
| `symbol` | string | 종목 코드 |
| `order_id` | string | 주문 고유 ID |
| `user_id` | string | 사용자 ID |
| `is_buy` | boolean | 매수=true, 매도=false |
| `price` | integer | 주문 가격 |
| `quantity` | integer | 주문 수량 |

---

## 용량 산정

### Liquibook 성능 벤치마크

| 테스트 유형 | 결과 |
|------------|------|
| Depth OrderBook TPS | 273,652 주문/초 |
| 평균 레이턴시 | ~3,000 나노초 (3μs) |

### 인스턴스별 예상 성능

| 인스턴스 | vCPU | RAM | 예상 TPS | 권장 동시 사용자 |
|----------|------|-----|----------|------------------|
| t2.medium | 2 | 4GB | ~40,000 | 20만 명 |
| c6i.large | 2 | 4GB | ~80,000 | 40만 명 |
| c6i.xlarge | 4 | 8GB | ~200,000 | 100만 명 |

---

## TODO

| 기능 | 위치 | 설명 |
|------|------|------|
| **사용자 알림** | `user-notify-handler` Lambda | fills 개인 푸시 |
| **잔고 확인** | `order-router` Lambda | 주문 전 Supabase 잔고 검증 (NAT Gateway 필요) |
| **stale 연결 정리** | Cron Lambda | 주기적으로 만료된 `ws:*` 키 정리 |
| **차트 상위 타임프레임** | Streamer | 3m/5m/15m 롤업 캐싱 |

---

## 체결 데이터 Fan-Out 흐름

```mermaid
%%{init: {'theme': 'dark', 'themeVariables': { 'fontSize': '10px' }}}%%
flowchart TD
    Engine[Engine: Liquibook 매칭<br/>체결 발생]
    Handler[MarketDataHandler<br/>on_fill]
    Producer[KinesisProducer<br/>publishFill]
    
    Kinesis[supernoba-fills<br/>2 Shards]
    
    FillProc[fill-processor<br/>DynamoDB Orders<br/>+ Supabase Wallets]
    HistSaver[history-saver<br/>Aurora PostgreSQL]
    Notifier[notifier<br/>레거시]
    
    DDB_ORD[(DynamoDB<br/>supernoba-orders)]
    RDS[(Aurora PostgreSQL<br/>trade_history)]
    Supabase[(Supabase<br/>wallets)]
    
    DirectNotif[NotificationClient<br/>직접 WebSocket]
    Gateway[API Gateway WS]
    Client[클라이언트]
    
    Engine --> Handler
    Handler --> Producer
    Producer -->|Fan-Out| Kinesis
    
    Kinesis -->|병렬| FillProc
    Kinesis -->|병렬| HistSaver
    Kinesis -->|병렬| Notifier
    
    FillProc --> DDB_ORD
    FillProc --> Supabase
    HistSaver --> RDS
    
    Handler -->|부분 체결<br/>PARTIALLY_FILLED| DirectNotif
    DirectNotif --> Gateway
    Gateway --> Client
    
    Notifier -->|전량 체결<br/>FILLED만| Gateway
    
    style Kinesis fill:#FF9900,color:#000
    style DirectNotif fill:#2196F3,color:#fff
    style RDS fill:#4CAF50,color:#fff
    style DDB_ORD fill:#4CAF50,color:#fff
```

### Fan-Out 아키텍처 설명

1. **단일 발행**: Engine에서 `KinesisProducer::publishFill()` 한 번 호출 (전량 체결 여부 포함)
2. **다중 소비**: Kinesis Stream이 자동으로 여러 Lambda에 전달 (Fan-Out)
3. **병렬 처리**: 각 Lambda가 독립적으로 처리 (실패 시 재시도)
4. **체결 알림 분리**:
   - **부분 체결**: 엔진 `NotificationClient`에서 직접 WebSocket 알림 (실시간 상태 업데이트)
   - **전량 체결**: `notifier Lambda`에서 WebSocket 알림 (Kinesis를 통한 Fan-Out)
5. **역할 분리**: 부분 체결은 실시간성, 전량 체결은 안정성/재시도 보장

---

## 변경 이력

| 날짜 | 변경 내용 |
|------|----------|
| 2025-12-21 | 아키텍처 문서 전면 개편: 실제 구현 반영, 상세 다이어그램 추가 (Obsidian 호환) |
| 2025-12-21 | 알림 아키텍처 변경: Kinesis 제거, Engine 직접 전송 (Latency 개선 < 5ms) |
| 2025-12-20 | 클라이언트 로그인 가드 추가 |
| 2025-12-20 | 시장가 주문 IOC 강제 + 호가 검증 |
| 2025-12-20 | Engine 직접 DynamoDB 저장 제거 → Kinesis Fan-Out 방식으로 변경 |
| 2025-12-16 | Chart API epoch 타임스탬프 변환 구현 |
| 2025-12-16 | Test Console 모듈화 (10개 JS 파일 분리) |
| 2025-12-16 | 아키텍처 다이어그램 크기 80% 축소 (Obsidian 호환) |
| 2025-12-14 | JWT 인증 (Supabase), testMode 지원, realtime:connections 추가 |
| 2025-12-14 | symbol-manager → Supernoba-admin으로 통합 |
| 2025-12-14 | EventBridge 트리거 추가 (trades-backup-10min) |
| 2025-12-14 | Streamer v3: 50ms/500ms 이중 폴링 분리 |
| 2025-12-14 | 테스트 콘솔 캔들 테스트 자동화 추가 |
| 2025-12-13 | C++ Lua Script 캔들 집계 구현 |
| 2025-12-13 | Hot/Cold 하이브리드 차트 데이터 조회 |

---

*최종 업데이트: 2025-12-21*
