# Supernoba-Core 아키텍처 레퍼런스

> 캐시 키, 캔들 데이터 플로우, API Gateway 정보를 통합한 기술 레퍼런스

---

## 1. Valkey (Redis) 키 구조

### 마켓 데이터 (C++ Engine 생성)

| Key | Type | 설명 | TTL |
|-----|------|------|-----|
| `depth:{SYMBOL}` | String | 호가창 스냅샷 (b/a 리스트) | 5분 |
| `ticker:{SYMBOL}` | String | 24시간 티커 (OHLCV + 변동률) | 5분 |
| `prev:{SYMBOL}` | String | 전일 종가 | - |
| `candle:1m:{SYMBOL}` | Hash | 실시간 1분봉 `{o,h,l,c,v,t,t_epoch}` | 5분 |
| `candle:closed:1m:{SYMBOL}` | List | 마감된 1분봉 (max 1000) | 1시간 |

### 연결 관리 (Lambda 생성)

| Key | Type | 설명 |
|-----|------|------|
| `ws:{connId}` | String | 연결 활성 플래그 |
| `conn:{connId}:main` | String | 메인 구독 종목 |
| `symbol:{SYMBOL}:main` | Set | 메인 시청자 목록 |
| `symbol:{SYMBOL}:sub` | Set | 서브 시청자 목록 |
| `user:{userId}:connections` | Set | 사용자 연결 ID 목록 |
| `realtime:connections` | Set | 로그인 세션 목록 (100ms 폴링) |
| `active:symbols` | Set | 거래 가능 종목 목록 |

### Market Maker (mm-service)

| Key | Type | 설명 |
|-----|------|------|
| `mm:running` | String | MM 실행 상태 |
| `mm:running:symbols` | Set | 실행 중인 종목 |
| `mm:config:{SYMBOL}` | String | 종목별 MM 설정 |
| `mm:price:{SYMBOL}` | String | 현재 MM 가격 |

---

## 2. 캔들 데이터 플로우

### 생성 → 저장 → 전송

```
체결 발생
    ↓
C++ Engine (Lua Script)
    ↓ 원자적 OHLCV 업데이트
Valkey [candle:1m:SYMBOL]
    ↓ 100ms 폴링
Streamer (Node.js)
    ↓ WebSocket 브로드캐스트
Client (Browser)
    ↓ 로컬 버퍼 + API 병합
TradingView Chart
```

### 타임프레임 집계 (Aggregator)

| Interval | Seconds | 집계 방식 |
|----------|---------|----------|
| 1m | 60 | Engine 직접 생성 |
| 3m, 5m, 15m, 30m | 180~1800 | 1분봉 집계 |
| 1h, 4h | 3600~14400 | 1분봉 집계 |
| 1d, 1w | 86400~604800 | 1분봉 집계 |

### 클라이언트 병합 전략

```
원칙: "Server is Truth, Buffer is Patch"

1. API 데이터 = 불변의 진실 (절대 덮어쓰지 않음)
2. WebSocket 버퍼 = API에 없는 최신 데이터만 추가
3. 시간 충돌 시 API 우선
```

---

## 3. API Gateway

### WebSocket API

| 이름 | ID | 엔드포인트 |
|------|-----|----------|
| Supernoba-ws | `l2ptm85wub` | `wss://l2ptm85wub.execute-api.ap-northeast-2.amazonaws.com/production` |
| Admin-ws | `2qlrv92731` | `wss://2qlrv92731.execute-api.ap-northeast-2.amazonaws.com/admin` |

### REST API

| 이름 | ID | 용도 |
|------|-----|------|
| Supernoba-api | `4xs6g4w8l6` | 주문 라우팅 |
| Admin-API | `0eeto6kblk` | 관리자 기능 |

### 조회 명령어

```bash
# WebSocket API 목록
aws apigatewayv2 get-apis --region ap-northeast-2

# REST API 목록
aws apigateway get-rest-apis --region ap-northeast-2
```

---

## 4. 스트리밍 폴링 주기

| 사용자 타입 | 주기 | 설명 |
|------------|------|------|
| 로그인 (realtime) | 100ms | Valkey 직접 조회 |
| 익명 (anonymous) | 500ms | 캐시 사용 |

---

## 5. 키 네이밍 컨벤션

### 규칙

1. **구분자**: `:` (콜론) 사용
2. **대소문자**:
   - 접두사/속성: lowercase
   - 변수값 (SYMBOL, CONNID): UPPERCASE
3. **형식**: `namespace:entity:identifier[:attribute]`

### 예시

```
depth:AAPL              # 마켓 데이터
candle:1m:AAPL          # 타임시리즈
symbol:AAPL:main        # 엔티티 속성
user:USER123:connections # 사용자 데이터
```

---

*마지막 업데이트: 2026-01-14*
