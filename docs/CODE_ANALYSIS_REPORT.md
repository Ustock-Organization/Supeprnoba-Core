# Supernoba-Core 프로젝트 코드 분석 보고서

> 분석일: 2025-12-14

---

## 📌 프로젝트 개요

Supernoba-Core는 **Liquibook 기반 실시간 주문 매칭 엔진**으로, AWS 서비스(Kinesis, ElastiCache, Lambda, API Gateway WebSocket)를 활용한 거래 플랫폼 백엔드입니다.

### 주요 구성요소

| 컴포넌트 | 위치 | 설명 |
|---------|------|-----|
| **Liquibook Core** | `src/book/` | 헤더 전용 주문매칭 라이브러리 |
| **C++ Wrapper** | `wrapper/src/` | AWS 연동 래퍼 (Kinesis, Redis, gRPC) |
| **Lambda Handlers** | `lambda/` | 10개의 AWS Lambda 함수 |
| **Node.js Streamer** | `streamer/node/` | WebSocket 데이터 푸시 서버 |

---

## 🔴 미구현 기능 (Critical)

### 1. 사용자 잔고 확인 (Balance Validation)

**위치**: `lambda/Supernoba-order-router/index.mjs` (Line 35-39)

```javascript
// Supabase에서 사용자 잔고 확인 (현재 비활성화 - NAT Gateway 필요)
async function checkBalance(userId, side, symbol, price, quantity) {
  // TODO: NAT Gateway 추가 후 활성화
  return { success: true, skipped: true };
}
```

> ⚠️ **CAUTION**: 주문 제출 전 사용자 잔고/보유량 확인이 **완전히 스킵**되어 있어, 악의적 주문 제출이 가능합니다.

---

### 2. 사용자 체결 알림 (User Fill Notification)

**위치**: `AWS_ARCHITECTURE.md` TODO 항목

```
| **사용자 알림** | `user-notify-handler` Lambda | fills 개인 푸시 |
```

> ⚠️ **WARNING**: `supernoba-fills` Kinesis 스트림에 체결 데이터가 발행되지만, **이를 소비하여 사용자에게 WebSocket 푸시하는 Lambda가 없습니다**.

**필요한 구현**:
- `user-notify-handler` Lambda 생성
- Kinesis fills 스트림 소비
- `user:userId:connections`에서 connectionId 조회
- API Gateway `PostToConnection`으로 체결 알림 푸시

---

### 3. 주문 취소/수정 REST API

**누락 항목**: 프론트엔드 가이드 문서에 명시된 API가 Lambda에 미구현

| API | 문서 표기 | 실제 구현 |
|-----|----------|----------|
| `DELETE /orders/{orderId}` | ✅ 가이드에 명시 | ❌ **미구현** |
| `PUT /orders/{orderId}` (수정) | ❌ 문서 없음 | ❌ **미구현** |

**현재 상태**: C++ Engine의 `cancelOrder()`, `replaceOrder()`는 구현되어 있지만, **Lambda → Kinesis 경로**가 없습니다.

---

### 4. Unsubscribe Route Handler

**위치**: `lambda/Supernoba-subscribe-handler/index.mjs`

프론트엔드 가이드에 명시된 `unsubscribe` action이 Lambda에서 **구현되지 않았습니다**:

```javascript
// 가이드 문서 예시 (지원 필요)
ws.send(JSON.stringify({
  action: 'unsubscribe',
  sub: ['MSFT']  // 특정 Sub 해제
}));
```

---

### 5. Streamer slowPollLoop 비활성화

**위치**: `streamer/node/index.mjs` (Line 182-204)

```javascript
// === 500ms 폴링 (익명 사용자) - 캐시 사용 ===
async function slowPollLoop() {
  // ... 내용 있지만 로직 미완성
  // TODO: 익명/로그인 구분 로직 추가 필요
}

// slowPollLoop(); // 필요시 활성화 ← 주석 처리됨
```

> 익명 사용자와 로그인 사용자를 구분하여 차등 폴링하는 로직이 미완성입니다.

---

## 🟡 Placeholder/Stub 코드 (구현 필요)

### 6. ApiGatewayPusher (C++)

**위치**: `wrapper/src/websocket_server.cpp` (Line 415-438)

```cpp
// API Gateway Pusher (placeholder - requires curl or AWS SDK)
bool ApiGatewayPusher::pushToConnection(const std::string& connectionId, 
                                         const nlohmann::json& message) {
    // TODO: Implement using AWS SDK or libcurl
    Logger::warn("ApiGatewayPusher::pushToConnection not implemented");
    return false;
}
```

> C++ Engine에서 직접 WebSocket 푸시하는 경로가 placeholder로 남아있습니다.

---

### 7. Admin 권한 검증

**위치**: `lambda/Supernoba-symbol-manager/index.mjs` (Line 24-28)

```javascript
function isAdmin(event) {
  const authHeader = event.headers?.Authorization;
  // TODO: 실제 권한 검증 로직 (Cognito, API Key 등)
  return authHeader === process.env.ADMIN_API_KEY;
}
```

> 단순 API Key 비교만 수행. Cognito 또는 JWT 기반 인증 필요.

---

## 🟠 아키텍처 상 잔존 코드

### 8. 사용하지 않는 Kinesis Depth 스트림

**위치**: `wrapper/src/kinesis_producer.cpp` (Line 19)

```cpp
depth_stream_ = Config::get("KINESIS_DEPTH_STREAM", "supernoba-depth");
```

**아키텍처 문서에 명시**: `supernoba-depth` 스트림은 **사용하지 않음**. Depth는 Valkey 직접 저장.

그러나 `publishDepth()` 함수가 여전히 존재:

```cpp
void KinesisProducer::publishDepth(const std::string& symbol,
                                    const nlohmann::json& depth) {
    // ... depth_stream_으로 발행 (불필요)
}
```

---

### 9. C++ WebSocket Server (로컬 전용)

**위치**: `wrapper/src/websocket_server.cpp`

완전한 WebSocket 서버 구현이 있지만, **현재 아키텍처에서는 API Gateway WebSocket을 사용**합니다.

> 이 코드는 로컬 개발/테스트용으로 보이며, 운영에서는 사용되지 않습니다.

---

## 🔵 프론트엔드 연동 시 누락 기능

### 10. 주문 상태 실시간 업데이트

**현재 C++ Engine이 발행하는 이벤트**:
- `publishFill()` - 체결
- `publishOrderStatus()` - 주문 상태 변경

**누락된 부분**: Lambda에서 `supernoba-order-status` 스트림을 소비하여 사용자에게 푸시하는 로직 없음.

---

### 11. 초기 데이터 조회 API

| 기능 | 현재 상태 |
|-----|----------|
| 종목 목록 | ✅ `symbol-manager` GET |
| 차트 데이터 | ✅ `chart-data-handler` |
| 미체결 주문 조회 | ❌ **미구현** |
| 주문 내역 조회 | ❌ **미구현** |
| 체결 내역 조회 | ❌ **미구현** |

---

### 12. Heartbeat/Ping-Pong

WebSocket 연결 유지를 위한 heartbeat 메커니즘이 문서화되어 있지 않습니다.

---

## 📊 구현 현황 요약

| 영역 | 완료 | 미완료 |
|------|:----:|:------:|
| 주문 매칭 엔진 | ✅ | - |
| Kinesis 연동 | ✅ | - |
| Redis/Valkey 캐싱 | ✅ | - |
| WebSocket 구독 | ✅ | unsubscribe |
| 실시간 데이터 푸시 | ✅ | 사용자별 체결 알림 |
| 차트 데이터 API | ✅ | - |
| 잔고 확인 | ❌ | 전체 미구현 |
| 주문 취소/수정 | ⚠️ | REST API 미구현 |
| 사용자 알림 | ❌ | 전체 미구현 |
| Admin 인증 | ⚠️ | 단순 API Key만 |

---

## 🎯 권장 우선순위

| 순위 | 항목 | 중요도 | 난이도 |
|:----:|------|:------:|:------:|
| 1 | 잔고 확인 (`checkBalance`) | 🔴 Critical | 중간 |
| 2 | 사용자 체결 알림 Lambda | 🔴 Critical | 중간 |
| 3 | 주문 취소 REST API | 🟠 High | 낮음 |
| 4 | Unsubscribe 핸들러 | 🟠 High | 낮음 |
| 5 | 미체결 주문 조회 API | 🟡 Medium | 중간 |
| 6 | Admin 인증 강화 | 🟡 Medium | 중간 |
| 7 | slowPollLoop 완성 | 🟢 Low | 낮음 |
| 8 | 잔존 코드 정리 | 🟢 Low | 낮음 |

---

*본 분석은 2025-12-14 기준 코드베이스를 기반으로 작성되었습니다.*
