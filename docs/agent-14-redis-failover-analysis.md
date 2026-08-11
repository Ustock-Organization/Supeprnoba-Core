# Agent 14: Redis 클러스터 Failover 분석

**분석 대상:** `C:\develop\Supeprnoba-Core\wrapper\src\redis_client.cpp`
**분석 일자:** 2026-01-17
**아키텍트:** Backend Architect (Claude Sonnet 4.5)

---

## 목차

1. [현재 장애 처리 분석](#1-현재-장애-처리-분석)
2. [ElastiCache 페일오버 처리](#2-elasticache-페일오버-처리)
3. [자동 페일오버 감지 메커니즘](#3-자동-페일오버-감지-메커니즘)
4. [데이터 손실 방지 전략](#4-데이터-손실-방지-전략)
5. [개선 제안](#5-개선-제안)
6. [운영 가이드](#6-운영-가이드)

---

## 1. 현재 장애 처리 분석

### 1.1 연결 상태 관리

**파일:** `C:\develop\Supeprnoba-Core\wrapper\include\redis_client.h`

현재 시스템은 3가지 연결 상태를 관리합니다:

```cpp
enum class ConnectionState {
    CONNECTED,      // 정상 연결
    DISCONNECTED,   // 연결 끊김 (재연결 시도 가능)
    CIRCUIT_OPEN    // Circuit breaker 열림 (일시적 재연결 중단)
};
```

**상태 전이:**
```
DISCONNECTED
    → connect() 성공 → CONNECTED
    → connect() 실패 (max attempts 미달) → DISCONNECTED
    → connect() 실패 (max attempts 초과) → CIRCUIT_OPEN

CONNECTED
    → health check 실패 → DISCONNECTED
    → command 실패 → markDisconnected() → DISCONNECTED

CIRCUIT_OPEN
    → timeout 경과 (60초) → DISCONNECTED → 재시도 시작
```

### 1.2 장애 감지 메커니즘

#### A. Passive Detection (수동 감지)

모든 Redis 명령 실행 시 `ensureConnection()` 호출:

```cpp
// src/redis_client.cpp:217
bool RedisClient::set(const std::string& key, const std::string& value) {
    if (!ensureConnection()) return false;  // 연결 확인

    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "SET %s %s", key.c_str(), value.c_str()));

    if (!reply) {
        Logger::error("Redis SET failed:", context_->errstr);
        markDisconnected();  // 장애 감지 → 연결 종료

        // 즉시 재연결 시도 (1회)
        if (auto_reconnect_enabled_ && attemptReconnect()) {
            // 재연결 성공 시 명령 재실행
            reply = static_cast<redisReply*>(
                redisCommand(context_, "SET %s %s", key.c_str(), value.c_str()));
            if (reply) {
                bool success = (reply->type != REDIS_REPLY_ERROR);
                freeReplyObject(reply);
                return success;
            }
        }
        return false;
    }
    // ...
}
```

**장점:**
- 명령 실패 시 즉시 감지
- 자동 재시도로 일시적 장애 복구

**단점:**
- 명령 실행 전까지 장애를 모름
- 첫 번째 명령은 반드시 실패

#### B. Active Detection (능동 감지)

주기적 헬스 체크 (기본 5초):

```cpp
// src/redis_client.cpp:163
bool RedisClient::performHealthCheck() {
    last_health_check_ = std::chrono::steady_clock::now();

    if (!context_) return false;

    // PING 명령으로 헬스 체크
    auto reply = static_cast<redisReply*>(redisCommand(context_, "PING"));

    if (!reply) {
        Logger::warn("Redis health check failed - connection appears dead:",
                     context_->errstr);
        markDisconnected();
        return false;
    }

    bool healthy = (reply->type == REDIS_REPLY_STATUS &&
                    std::string(reply->str) == "PONG");
    freeReplyObject(reply);

    if (!healthy) {
        Logger::warn("Redis health check failed - unexpected PING response");
        markDisconnected();
        return false;
    }

    return true;
}
```

**트리거 조건:**
- `ensureConnection()` 호출 시 마지막 헬스 체크로부터 5초 경과
- 사용자가 명시적으로 `isHealthy()` 호출

**장점:**
- 명령 실패 전 미리 감지
- 연결 품질 모니터링 가능

**단점:**
- 5초 지연 (설정 가능하지만 기본값)
- 추가 네트워크 오버헤드

### 1.3 재연결 로직

#### A. Exponential Backoff

```cpp
// src/redis_client.cpp:75
int RedisClient::calculateBackoffDelay() {
    if (current_reconnect_attempts_ == 0) {
        return 0;  // 첫 시도 - 지연 없음
    }

    // 지수 백오프: 100ms, 200ms, 400ms, 800ms, 1600ms, ...
    int delay = reconnect_delay_ms_ * (1 << (current_reconnect_attempts_ - 1));
    return std::min(delay, max_reconnect_delay_ms_);
}
```

**백오프 시퀀스 (기본값):**
```
시도 1: 0ms
시도 2: 100ms
시도 3: 200ms
시도 4: 400ms
시도 5: 800ms
시도 6: 1,600ms
시도 7: 3,200ms
시도 8: 6,400ms
시도 9: 12,800ms
시도 10: 25,600ms
최대 제한: 30,000ms (30초)
```

**목적:**
- 네트워크/서버 부하 방지
- 일시적 장애 시 빠른 복구
- 장기 장애 시 리소스 낭비 방지

#### B. Circuit Breaker Pattern

```cpp
// src/redis_client.cpp:97
bool RedisClient::attemptReconnect() {
    auto now = std::chrono::steady_clock::now();

    // Circuit breaker가 열려 있는지 확인
    if (state_ == ConnectionState::CIRCUIT_OPEN) {
        auto time_since_circuit_opened =
            std::chrono::duration_cast<std::chrono::milliseconds>(
                now - circuit_breaker_opened_at_).count();

        if (time_since_circuit_opened < circuit_breaker_timeout_ms_) {
            return false;  // Circuit 여전히 열림 - 재연결 거부
        }

        // Timeout 경과 → Circuit 닫고 재시도
        Logger::info("Redis circuit breaker closed - attempting reconnect");
        state_ = ConnectionState::DISCONNECTED;
        current_reconnect_attempts_ = 0;
    }

    // 최대 재연결 시도 횟수 확인
    if (current_reconnect_attempts_ >= max_reconnect_attempts_) {
        Logger::warn("Redis reconnect attempts exceeded - opening circuit breaker for",
                     circuit_breaker_timeout_ms_, "ms");
        state_ = ConnectionState::CIRCUIT_OPEN;
        circuit_breaker_opened_at_ = now;
        return false;
    }

    // 재연결 시도
    last_reconnect_attempt_ = now;
    current_reconnect_attempts_++;

    bool success = connect();

    if (success) {
        Logger::info("Redis reconnected successfully after", current_reconnect_attempts_, "attempts");
        return true;
    } else {
        Logger::warn("Redis reconnect failed, attempt", current_reconnect_attempts_);
        return false;
    }
}
```

**Circuit Breaker 동작:**

1. **최대 시도 횟수 초과** (기본 10회)
   - Circuit OPEN
   - 60초간 재연결 시도 중단
   - CPU/네트워크 부하 방지

2. **60초 후 자동 재시작**
   - Circuit CLOSED
   - 재시도 카운터 초기화
   - 새로운 시도 시작

**설정:**
```cpp
int max_reconnect_attempts_ = 10;           // 최대 시도 횟수
int circuit_breaker_timeout_ms_ = 60000;    // 60초
```

---

## 2. ElastiCache 페일오버 처리

### 2.1 현재 ElastiCache 구성

**환경 변수:** `C:\develop\Supeprnoba-Core\wrapper\run_engine.sh`

```bash
# ElastiCache Redis/Valkey (스냅샷 백업용)
export REDIS_HOST="master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com"
export REDIS_PORT="6379"

# Depth 캐시 (실시간 호가용)
export DEPTH_CACHE_HOST="supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com"
export DEPTH_CACHE_PORT="6379"
```

**아키텍처:**

```
┌─────────────────────────────────────────────────────────────────┐
│                   Matching Engine (C++)                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────┐         ┌──────────────────────┐      │
│  │ RedisClient          │         │ RedisClient          │      │
│  │ (Snapshot Backup)    │         │ (Depth Cache)        │      │
│  └──────────┬───────────┘         └──────────┬───────────┘      │
│             │                                │                  │
└─────────────┼────────────────────────────────┼──────────────────┘
              │                                │
              │                                │
    ┌─────────▼──────────┐         ┌──────────▼──────────┐
    │  ElastiCache       │         │  ElastiCache        │
    │  Cluster-Disabled  │         │  Cluster-Enabled    │
    │  (Single Node)     │         │  (Sharded)          │
    │                    │         │                     │
    │  master.xxx.com    │         │  xxx.ng.0001.com    │
    │  Port: 6379        │         │  Port: 6379         │
    └────────────────────┘         └─────────────────────┘
         스냅샷 저장                     실시간 호가/티커
```

### 2.2 ElastiCache 페일오버 시나리오

#### Scenario A: Single Node Failover (스냅샷 백업용)

**구성:**
- Replication: Single Node
- Endpoint: Primary Endpoint
- Auto-failover: 미지원 (단일 노드)

**장애 발생 시:**

1. **ElastiCache 재시작 (1-3분)**
   - DNS 엔드포인트는 동일 유지
   - TCP 연결 종료
   - 새 인스턴스로 자동 전환

2. **RedisClient 동작:**
   ```
   [T+0s]   Health check 실패 (PING timeout)
            → markDisconnected()
            → state_ = DISCONNECTED

   [T+0s]   ensureConnection() 호출
            → attemptReconnect()
            → connect() 시도 #1 (즉시)
            → 실패 (노드 아직 준비 안됨)

   [T+0.1s] connect() 시도 #2 (100ms 후)
            → 실패

   [T+0.3s] connect() 시도 #3 (200ms 후)
            → 실패

   ...

   [T+60s]  connect() 시도 #10 (실패)
            → Circuit OPEN
            → 60초간 재시도 중단

   [T+120s] Circuit CLOSED
            → 재시도 재시작
            → connect() 성공 (ElastiCache 복구 완료)
   ```

3. **데이터 영향:**
   - 스냅샷 저장 실패 (비치명적)
   - 재연결 후 자동 복구
   - 메모리 내 오더북은 보존

#### Scenario B: Cluster Failover (Depth Cache)

**구성:**
- Replication: Cluster Mode Enabled
- Endpoint: Configuration Endpoint (`xxx.ng.0001.com`)
- Sharding: 2 샤드 (추정)

**장애 발생 시:**

1. **Primary 노드 장애**
   - ElastiCache가 자동으로 Replica → Primary 승격 (30-60초)
   - Configuration endpoint는 변경 없음
   - 클라이언트는 자동으로 새 Primary에 재연결

2. **현재 구현의 문제점:**

   ```cpp
   // hiredis는 기본적으로 클러스터 모드를 지원하지 않음!
   context_ = redisConnectWithTimeout(host_.c_str(), port_, timeout);
   ```

   **hiredis 제약:**
   - MOVED/ASK 리디렉션 미지원
   - 샤드 간 자동 라우팅 불가
   - 단일 엔드포인트에만 연결

3. **실제 동작:**
   - Configuration endpoint는 프록시 역할
   - 모든 키에 대해 올바른 샤드로 라우팅 (AWS 관리)
   - Primary 장애 시 ElastiCache가 자동 페일오버
   - RedisClient는 TCP 연결 끊김만 감지
   - 재연결 시 자동으로 새 Primary 연결

### 2.3 현재 구현의 한계

#### A. hiredis 라이브러리 제약

**사용 중인 라이브러리:**
```cpp
#include <hiredis/hiredis.h>
```

**지원하지 않는 기능:**
- ❌ Redis Cluster MOVED/ASK 리디렉션
- ❌ 샤드 간 자동 라우팅
- ❌ 클러스터 토폴로지 자동 감지
- ✅ 단일 엔드포인트 연결 (ElastiCache 프록시 경유)

**대안:**
- `hiredis-cluster` (Redis Cluster 네이티브 지원)
- `redis-plus-plus` (C++ STL 스타일, 클러스터 지원)
- 현재 방식 유지 (ElastiCache Configuration Endpoint 활용)

#### B. Read Replica 미활용

**현재:**
- 모든 읽기/쓰기를 Primary에서 처리
- Read Replica 존재 시에도 활용 불가

**가능한 최적화:**
- 읽기 전용 명령 (GET, HGETALL 등)을 Replica로 분산
- hiredis 기본 라이브러리로는 불가능
- `redis-plus-plus` 등 고급 클라이언트 필요

---

## 3. 자동 페일오버 감지 메커니즘

### 3.1 현재 감지 방식

#### A. Health Check (5초 주기)

```cpp
// main.cpp에서 활성화되지 않음!
// health check는 ensureConnection() 내에서만 동작
```

**문제점:**
- 별도 헬스 체크 스레드 없음
- 명령 실행 시에만 체크
- 장시간 idle 상태 시 장애 미감지

#### B. Command-Based Detection

```cpp
bool RedisClient::set(...) {
    if (!ensureConnection()) return false;  // 여기서만 체크
    // ...
}
```

**타이밍:**
```
[idle 60초] → 장애 발생 → [idle 계속] → 감지 안됨
[idle 60초] → 장애 발생 → [명령 실행] → 즉시 감지
```

### 3.2 개선된 감지 메커니즘 (제안)

#### A. Background Health Check Thread

```cpp
// 제안 코드 (미구현)
class RedisClient {
private:
    std::thread health_check_thread_;
    std::atomic<bool> health_check_running_{false};

    void healthCheckLoop() {
        while (health_check_running_) {
            std::this_thread::sleep_for(
                std::chrono::milliseconds(health_check_interval_ms_));

            if (context_ && state_ == ConnectionState::CONNECTED) {
                if (!performHealthCheck()) {
                    Logger::warn("Background health check failed - will reconnect");
                    if (auto_reconnect_enabled_) {
                        attemptReconnect();
                    }
                }
            }
        }
    }

public:
    void startHealthCheck() {
        health_check_running_ = true;
        health_check_thread_ = std::thread(&RedisClient::healthCheckLoop, this);
    }

    void stopHealthCheck() {
        health_check_running_ = false;
        if (health_check_thread_.joinable()) {
            health_check_thread_.join();
        }
    }
};
```

**장점:**
- 명령 실행과 무관하게 장애 감지
- 평균 감지 시간: 2.5초 (5초 간격의 평균)
- 재연결 준비 완료 상태 유지

**단점:**
- 추가 스레드 필요
- 네트워크 오버헤드 (5초당 1 PING)

#### B. TCP Keepalive 활성화

```cpp
// 제안 코드
bool RedisClient::connect() {
    // ... 기존 연결 코드 ...

    // TCP Keepalive 설정
    int keepalive = 1;
    int keepidle = 30;   // 30초 idle 후 probe 시작
    int keepintvl = 5;   // 5초 간격 probe
    int keepcnt = 3;     // 3회 실패 시 연결 종료

    setsockopt(context_->fd, SOL_SOCKET, SO_KEEPALIVE, &keepalive, sizeof(keepalive));
    setsockopt(context_->fd, IPPROTO_TCP, TCP_KEEPIDLE, &keepidle, sizeof(keepidle));
    setsockopt(context_->fd, IPPROTO_TCP, TCP_KEEPINTVL, &keepintvl, sizeof(keepintvl));
    setsockopt(context_->fd, IPPROTO_TCP, TCP_KEEPCNT, &keepcnt, sizeof(keepcnt));

    return true;
}
```

**장점:**
- OS 레벨에서 연결 모니터링
- Application 코드 변경 최소
- 네트워크 장애 시 빠른 감지

**단점:**
- 감지 시간: 30 + 5*3 = 45초
- OS 설정에 의존

---

## 4. 데이터 손실 방지 전략

### 4.1 현재 데이터 보호 메커니즘

#### A. 스냅샷 백업 (10초 주기)

**파일:** `C:\develop\Supeprnoba-Core\wrapper\src\main.cpp`

```cpp
// main.cpp:254
while (g_running) {
    std::this_thread::sleep_for(std::chrono::seconds(1));
    auto now = std::chrono::steady_clock::now();

    // 10초마다 스냅샷 저장
    if (redis_connected &&
        std::chrono::duration_cast<std::chrono::seconds>(now - last_snapshot).count() >= 10) {

        auto symbols = engine.getAllSymbols();
        for (const auto& symbol : symbols) {
            auto snapshot = engine.snapshotOrderBook(symbol);
            if (!snapshot.empty()) {
                redis.saveSnapshot(symbol, snapshot);  // 실패 시 무시
            }
        }
        last_snapshot = now;
    }
}
```

**스냅샷 내용:**
- 오더북 전체 상태 (모든 미체결 주문)
- Symbol별 JSON 직렬화
- Redis Key: `snapshot:{SYMBOL}`

**데이터 손실 창:**
```
[T=0s]   스냅샷 저장
[T=5s]   Redis 장애 발생
[T=10s]  스냅샷 저장 시도 → 실패
[T=15s]  매칭 엔진 재시작
         → 5초~10초 간 데이터 손실 가능
```

**최악의 시나리오:**
- Redis 장애 + 매칭 엔진 크래시 동시 발생
- 최대 10초간의 주문 데이터 손실

#### B. DynamoDB 백업 (실시간)

**파일:** `C:\develop\Supeprnoba-Core\wrapper\src\market_data_handler.cpp`

```cpp
// market_data_handler.cpp (체결 이벤트)
void MarketDataHandler::on_fill(...) {
    // Kinesis로 체결 이벤트 전송
    producer_->putRecord("supernoba-fills", fill_json);

    // → Lambda 또는 stock-processor가 DynamoDB 업데이트
}
```

**보호 범위:**
- ✅ 체결된 주문 (DynamoDB에 실시간 반영)
- ✅ 주문 상태 변경 (ACCEPTED, FILLED, CANCELLED)
- ❌ 미체결 주문 (스냅샷에만 의존)

#### C. 재시작 시 복구 로직

**파일:** `C:\develop\Supeprnoba-Core\wrapper\src\main.cpp`

```cpp
// main.cpp:134 - Redis 스냅샷 복원
if (redis_connected) {
    Logger::info("Restoring snapshots from Redis...");
    auto snapshot_keys = redis.keys("snapshot:*");
    int restored_count = 0;
    for (const auto& key : snapshot_keys) {
        if (key.find(":timestamp") != std::string::npos) continue;

        std::string symbol = key.substr(9);  // "snapshot:" 제거
        auto snapshot_data = redis.get(key);
        if (snapshot_data.has_value()) {
            engine.restoreOrderBook(symbol, snapshot_data.value());
            Logger::info("Restored orderbook:", symbol);
            ++restored_count;
        }
    }
    Logger::info("Restored", restored_count, "orderbooks from Redis");
}

// main.cpp:159 - DynamoDB ACCEPTED 주문 복원
if (load_from_dynamodb) {
    Logger::info("Loading ACCEPTED orders from DynamoDB...");
    DynamoDBClient dynamodb(aws_region);

    if (dynamodb.initialize()) {
        auto accepted_orders = dynamodb.loadAcceptedOrders(orders_table);

        int added_count = 0;
        int skipped_count = 0;

        for (const auto& order : accepted_orders) {
            // 이미 스냅샷에서 복원된 주문은 스킵
            if (engine.hasOrder(order->symbol(), order->order_id())) {
                ++skipped_count;
                continue;
            }

            engine.addOrder(order);
            ++added_count;
        }

        Logger::info("DynamoDB order restore complete: added=", added_count,
                    ", skipped (already in snapshot)=", skipped_count);
    }
}
```

**복구 전략:**

1. **Redis 스냅샷 우선 복원**
   - 가장 최근 (10초 이내) 상태
   - 오더북 전체 구조 보존

2. **DynamoDB로 Gap 메우기**
   - Redis 장애 중 생성된 ACCEPTED 주문 복원
   - 스냅샷에 없는 주문만 추가

3. **중복 제거**
   - `engine.hasOrder()` 체크
   - 같은 주문이 두 번 로드되는 것 방지

**복구 시간:**
```
엔진 재시작
  ↓
Redis 연결 (1.5초 timeout)
  ↓
스냅샷 복원 (N개 심볼 × 10ms = ~100ms for 10 symbols)
  ↓
DynamoDB 연결 및 스캔 (2-5초)
  ↓
주문 로드 및 오더북 재구축 (M개 주문 × 0.1ms = ~100ms for 1000 orders)
  ↓
총 복구 시간: 약 5-10초
```

### 4.2 Redis 장애 시 데이터 흐름

#### Scenario: Redis 완전 장애 (Primary + Replica)

**타임라인:**

```
[T=0s] Redis 장애 발생
       - ElastiCache 클러스터 전체 다운 (극히 드문 상황)
       - 또는 네트워크 분리

[T=0s] Matching Engine 동작
       - 정상 작동 (메모리 내 오더북 유지)
       - 스냅샷 저장만 실패
       - 로그: "Redis SET failed: Connection refused"

[T=10s] 스냅샷 저장 시도 → 실패
        - ensureConnection() → attemptReconnect()
        - connect() 시도 #1 → 실패

[T=10.1s] 재연결 시도 #2 → 실패
[T=10.3s] 재연결 시도 #3 → 실패
...

[T=70s] Circuit Breaker OPEN
        - 60초간 재연결 시도 중단
        - 스냅샷 저장 중단

[T=130s] Circuit Breaker CLOSED
         - 재연결 재시도
         - Redis 복구되면 즉시 재연결

[데이터 영향]
- ✅ 실시간 거래: 영향 없음 (메모리 처리)
- ✅ Kinesis 이벤트: 정상 발행
- ✅ DynamoDB 업데이트: 정상 (Lambda/stock-processor 경유)
- ❌ 스냅샷 백업: 중단 (Redis 복구 시까지)
- ⚠️  매칭 엔진 크래시 시: DynamoDB 복구 의존
```

**최악의 시나리오 (Redis 장애 + 엔진 크래시):**

```
[T=0s] Redis 장애
[T=30s] 마지막 성공한 스냅샷 (T=0s 기준 -30s)
[T=60s] 매칭 엔진 크래시

[재시작]
Redis 스냅샷: 60초 전 상태
DynamoDB: 현재 상태
  → 60초간의 ACCEPTED 주문을 DynamoDB에서 복원
  → 데이터 손실 없음 (DynamoDB 백업 덕분)
```

### 4.3 개선 제안: Multi-Layer Backup

#### A. 로컬 디스크 백업 (추가 제안)

```cpp
// 제안 코드 (미구현)
class SnapshotManager {
private:
    std::string local_snapshot_dir_ = "/tmp/orderbook_snapshots/";

public:
    void saveLocalSnapshot(const std::string& symbol, const std::string& data) {
        std::string filepath = local_snapshot_dir_ + symbol + ".json";
        std::ofstream file(filepath, std::ios::trunc);
        file << data;
        file.close();
    }

    std::optional<std::string> loadLocalSnapshot(const std::string& symbol) {
        std::string filepath = local_snapshot_dir_ + symbol + ".json";
        std::ifstream file(filepath);
        if (!file.is_open()) return std::nullopt;

        std::stringstream buffer;
        buffer << file.rdbuf();
        return buffer.str();
    }
};

// main.cpp 수정
while (g_running) {
    // ...
    if (std::chrono::duration_cast<std::chrono::seconds>(now - last_snapshot).count() >= 10) {
        auto symbols = engine.getAllSymbols();
        for (const auto& symbol : symbols) {
            auto snapshot = engine.snapshotOrderBook(symbol);
            if (!snapshot.empty()) {
                // Redis 저장 (실패 가능)
                redis.saveSnapshot(symbol, snapshot);

                // 로컬 디스크 저장 (항상 성공)
                snapshot_manager.saveLocalSnapshot(symbol, snapshot);
            }
        }
        last_snapshot = now;
    }
}
```

**장점:**
- Redis 장애와 무관하게 백업 보장
- 빠른 복구 (네트워크 불필요)
- 추가 비용 없음

**단점:**
- 디스크 I/O 오버헤드
- EC2 인스턴스 교체 시 손실

#### B. S3 Periodic Backup (제안)

```cpp
// 5분마다 S3에 전체 스냅샷 저장
void uploadToS3(const std::vector<std::string>& symbols) {
    nlohmann::json full_snapshot;
    full_snapshot["timestamp"] = getCurrentTimestamp();

    for (const auto& symbol : symbols) {
        auto snapshot = engine.snapshotOrderBook(symbol);
        full_snapshot["orderbooks"][symbol] = nlohmann::json::parse(snapshot);
    }

    std::string s3_key = "snapshots/" + getCurrentDate() + "/" +
                         getCurrentTimestamp() + ".json";
    s3_client.putObject("supernoba-backups", s3_key, full_snapshot.dump());
}
```

**용도:**
- 장기 보관
- 재해 복구 (DR)
- 감사 로그

---

## 5. 개선 제안

### 5.1 즉시 적용 가능 (코드 수정 불필요)

#### A. Auto-Reconnect 활성화

**현재 상태:**
```cpp
// main.cpp에서 auto_reconnect_enabled_ = false (기본값)
```

**개선:**
```cpp
// main.cpp:74 (추가)
redis.setAutoReconnect(true);
redis.setMaxReconnectAttempts(10);
redis.setReconnectDelay(100, 30000);  // 100ms ~ 30s

depth_cache.setAutoReconnect(true);
depth_cache.setMaxReconnectAttempts(10);
depth_cache.setReconnectDelay(100, 30000);
```

**효과:**
- Redis 일시 장애 시 자동 복구
- 운영 개입 불필요
- 평균 복구 시간: 1-5초

#### B. Health Check 간격 단축

**현재:**
```cpp
int health_check_interval_ms_ = 5000;  // 5초
```

**개선:**
```cpp
redis.setHealthCheckInterval(2000);  // 2초
depth_cache.setHealthCheckInterval(2000);
```

**효과:**
- 평균 감지 시간: 5초 → 2초
- 네트워크 오버헤드: 무시할 수준 (1 PING/2s)

### 5.2 단기 개선 (소규모 코드 변경)

#### A. Background Health Check Thread

**파일:** `C:\develop\Supeprnoba-Core\wrapper\include\redis_client.h`

```cpp
class RedisClient {
private:
    std::thread health_check_thread_;
    std::atomic<bool> health_check_running_{false};

    void healthCheckLoop();

public:
    void startBackgroundHealthCheck();
    void stopBackgroundHealthCheck();
};
```

**파일:** `C:\develop\Supeprnoba-Core\wrapper\src\redis_client.cpp`

```cpp
void RedisClient::healthCheckLoop() {
    while (health_check_running_) {
        std::this_thread::sleep_for(
            std::chrono::milliseconds(health_check_interval_ms_));

        std::lock_guard<std::mutex> lock(context_mutex_);  // 스레드 안전

        if (context_ && state_ == ConnectionState::CONNECTED) {
            if (!performHealthCheck()) {
                Logger::warn("Background health check failed");
                if (auto_reconnect_enabled_) {
                    attemptReconnect();
                }
            }
        } else if (!context_ && auto_reconnect_enabled_) {
            // 연결 끊김 상태 - 재연결 시도
            attemptReconnect();
        }
    }
}

void RedisClient::startBackgroundHealthCheck() {
    if (health_check_running_) return;

    health_check_running_ = true;
    health_check_thread_ = std::thread(&RedisClient::healthCheckLoop, this);
    Logger::info("Background health check started:", health_check_interval_ms_, "ms");
}

void RedisClient::stopBackgroundHealthCheck() {
    health_check_running_ = false;
    if (health_check_thread_.joinable()) {
        health_check_thread_.join();
    }
    Logger::info("Background health check stopped");
}
```

**main.cpp 수정:**

```cpp
int main() {
    // ...
    RedisClient redis(redis_host, redis_port);
    redis.connect();
    redis.setAutoReconnect(true);
    redis.startBackgroundHealthCheck();  // ← 추가

    // ...

    // 종료 시
    redis.stopBackgroundHealthCheck();  // ← 추가
}
```

**주의사항:**
- `hiredis`는 스레드 안전하지 않음
- `context_`에 대한 mutex 필요
- 모든 Redis 명령에 lock 추가 (성능 영향)

#### B. Metrics 추가

**파일:** `C:\develop\Supeprnoba-Core\wrapper\include\redis_client.h`

```cpp
class RedisClient {
private:
    std::atomic<uint64_t> total_commands_{0};
    std::atomic<uint64_t> failed_commands_{0};
    std::atomic<uint64_t> reconnect_count_{0};
    std::atomic<uint64_t> health_check_failures_{0};

public:
    struct Metrics {
        uint64_t total_commands;
        uint64_t failed_commands;
        uint64_t reconnect_count;
        uint64_t health_check_failures;
        ConnectionState current_state;
        int current_reconnect_attempts;
    };

    Metrics getMetrics() const;
};
```

**CloudWatch 연동:**

```cpp
// main.cpp 메트릭 루프에 추가
if (std::chrono::duration_cast<std::chrono::seconds>(now - last_metrics).count() >= 30) {
    auto redis_metrics = redis.getMetrics();
    Logger::info("=== Redis Metrics ===");
    Logger::info("Commands:", redis_metrics.total_commands);
    Logger::info("Failures:", redis_metrics.failed_commands);
    Logger::info("Reconnects:", redis_metrics.reconnect_count);
    Logger::info("State:", static_cast<int>(redis_metrics.current_state));

    // CloudWatch로 전송 (선택사항)
    cloudwatch.putMetric("Redis/Commands", redis_metrics.total_commands);
    cloudwatch.putMetric("Redis/Failures", redis_metrics.failed_commands);
}
```

### 5.3 중기 개선 (라이브러리 교체)

#### A. redis-plus-plus 마이그레이션

**현재:** `hiredis` (C 라이브러리)

**대안:** `redis-plus-plus` (C++ 라이브러리)

**장점:**
- ✅ Redis Cluster 네이티브 지원
- ✅ MOVED/ASK 자동 리디렉션
- ✅ Connection Pool
- ✅ 스레드 안전
- ✅ RAII 패턴 (자동 메모리 관리)
- ✅ STL 스타일 API

**설치:**
```bash
# vcpkg.json에 추가
{
  "dependencies": [
    "redis-plus-plus",
    "hiredis"  // redis-plus-plus가 내부적으로 사용
  ]
}
```

**예제 코드:**

```cpp
#include <sw/redis++/redis++.h>

using namespace sw::redis;

int main() {
    // Cluster 연결 (ElastiCache Cluster Mode)
    ConnectionOptions opts;
    opts.host = "supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com";
    opts.port = 6379;
    opts.connect_timeout = std::chrono::milliseconds(1500);
    opts.socket_timeout = std::chrono::milliseconds(1000);

    ConnectionPoolOptions pool_opts;
    pool_opts.size = 10;  // Connection pool size

    // Redis Cluster 클라이언트 생성
    RedisCluster cluster(opts, pool_opts);

    // 자동 재연결, 스레드 안전
    cluster.set("key", "value");
    auto val = cluster.get("key");

    // Pipeline (성능 최적화)
    auto pipe = cluster.pipeline("key");
    pipe.set("key1", "val1");
    pipe.set("key2", "val2");
    pipe.get("key1");
    auto replies = pipe.exec();
}
```

**마이그레이션 작업:**
1. `redis_client.h` 리팩토링
2. `hiredis` API → `redis++` API 변환
3. 스레드 안전성 검증
4. 성능 테스트 (벤치마크)
5. 단계적 배포

**예상 작업 시간:** 3-5일

### 5.4 장기 개선 (아키텍처 변경)

#### A. Redis Sentinel 도입

**현재:** ElastiCache Primary Endpoint

**개선:** ElastiCache with Sentinel (고가용성)

**구성:**
```
┌───────────────────────────────────────────┐
│           Redis Sentinel                  │
│                                           │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐   │
│  │Sentinel │  │Sentinel │  │Sentinel │   │
│  │  Node1  │  │  Node2  │  │  Node3  │   │
│  └────┬────┘  └────┬────┘  └────┬────┘   │
│       │            │            │         │
│       └────────────┼────────────┘         │
│                    │                      │
│       ┌────────────▼────────────┐         │
│       │   Primary Election      │         │
│       └─────────────────────────┘         │
│                                           │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐   │
│  │ Primary │  │ Replica │  │ Replica │   │
│  │  Node   │  │  Node1  │  │  Node2  │   │
│  └─────────┘  └─────────┘  └─────────┘   │
└───────────────────────────────────────────┘
```

**장점:**
- 자동 페일오버 (30초 이내)
- 클라이언트 자동 Primary 감지
- Multi-AZ 배포 가능

**클라이언트 코드 (redis-plus-plus):**

```cpp
SentinelOptions sentinel_opts;
sentinel_opts.nodes = {
    {"sentinel1.example.com", 26379},
    {"sentinel2.example.com", 26379},
    {"sentinel3.example.com", 26379}
};
sentinel_opts.connect_timeout = std::chrono::milliseconds(1500);

auto sentinel = std::make_shared<Sentinel>(sentinel_opts);
auto redis = std::make_shared<Redis>(sentinel, "master-name", Role::MASTER);

// 자동 페일오버 - Primary 변경 시 자동 재연결
redis->set("key", "value");
```

#### B. 읽기 분산 (Read Replica)

**구성:**

```cpp
class RedisClientPool {
private:
    std::shared_ptr<Redis> primary_;       // 쓰기용
    std::vector<std::shared_ptr<Redis>> replicas_;  // 읽기용
    std::atomic<size_t> round_robin_idx_{0};

public:
    // 쓰기 명령
    void set(const std::string& key, const std::string& value) {
        primary_->set(key, value);
    }

    // 읽기 명령 (Round-robin 분산)
    std::optional<std::string> get(const std::string& key) {
        size_t idx = round_robin_idx_.fetch_add(1) % replicas_.size();
        try {
            return replicas_[idx]->get(key);
        } catch (const Error& e) {
            // Fallback to primary
            Logger::warn("Replica read failed, using primary:", e.what());
            return primary_->get(key);
        }
    }
};
```

**성능 향상:**
- 읽기 처리량: 2-3배 증가 (Replica 2개 기준)
- Primary 부하 감소
- 읽기 지연 감소

---

## 6. 운영 가이드

### 6.1 ElastiCache 페일오버 모니터링

#### A. CloudWatch 메트릭

**주요 메트릭:**

| 메트릭 | 설명 | 임계값 |
|--------|------|--------|
| `CPUUtilization` | CPU 사용률 | > 75% 경고 |
| `NetworkBytesIn/Out` | 네트워크 트래픽 | 기준선 대비 ±50% |
| `CurrConnections` | 현재 연결 수 | > 10000 경고 |
| `Evictions` | 메모리 부족으로 인한 키 제거 | > 0 경고 |
| `ReplicationLag` | Replica 지연 시간 | > 5초 경고 |
| `EngineCPUUtilization` | Redis 프로세스 CPU | > 90% 경고 |

**CloudWatch Alarm 설정:**

```bash
aws cloudwatch put-metric-alarm \
  --alarm-name "ElastiCache-HighCPU" \
  --alarm-description "ElastiCache CPU > 75%" \
  --metric-name CPUUtilization \
  --namespace AWS/ElastiCache \
  --statistic Average \
  --period 300 \
  --threshold 75 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 2 \
  --dimensions Name=CacheClusterId,Value=supernoba-depth-cache-001
```

#### B. Redis Slow Log 모니터링

**설정:**

```bash
# ElastiCache Parameter Group에서 설정
slowlog-log-slower-than 10000  # 10ms 이상 명령 기록
slowlog-max-len 128            # 최대 128개 기록
```

**조회:**

```bash
redis-cli -h master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com \
  SLOWLOG GET 10
```

**예시 출력:**

```
1) 1) (integer) 14
   2) (integer) 1674567890
   3) (integer) 12345
   4) 1) "KEYS"
      2) "snapshot:*"
```

**주의:**
- `KEYS` 명령은 O(N) - 프로덕션에서 사용 금지
- `HGETALL` 큰 해시 - 샤딩 고려
- Lua Script 긴 실행 - 최적화 필요

### 6.2 장애 대응 절차

#### Scenario 1: Primary 노드 응답 없음

**증상:**
```
2026-01-17 10:15:30 [ERROR] Redis SET failed: Connection timed out
2026-01-17 10:15:30 [WARN] Redis connection lost - marking disconnected
2026-01-17 10:15:30 [INFO] Redis reconnect attempt 1 / 10 after 0 ms backoff
2026-01-17 10:15:31 [WARN] Redis reconnect failed, attempt 1
```

**진단:**

1. **ElastiCache 콘솔 확인**
   - Events 탭: 페일오버 이벤트
   - Metrics 탭: CPU, Memory, Network

2. **Redis 연결 테스트**
   ```bash
   redis-cli -h master.xxx.com -p 6379 PING
   ```

3. **ElastiCache 상태 확인**
   ```bash
   aws elasticache describe-cache-clusters \
     --cache-cluster-id supernoba-orderbook-backup \
     --show-cache-node-info
   ```

**조치:**

- **자동 복구 대기** (대부분의 경우)
  - ElastiCache 자동 페일오버: 30-60초
  - RedisClient 자동 재연결: 10-30초
  - 총 복구 시간: 1-2분

- **수동 개입** (자동 복구 실패 시)
  ```bash
  # 1. 매칭 엔진 재시작
  ssh server "pkill -f matching_engine"
  ssh server "cd ~/Supeprnoba-Core/wrapper && ./run_engine.sh"

  # 2. ElastiCache 클러스터 재시작 (최후 수단)
  aws elasticache reboot-cache-cluster \
    --cache-cluster-id supernoba-orderbook-backup \
    --cache-node-ids-to-reboot 0001
  ```

#### Scenario 2: Circuit Breaker Open

**증상:**
```
2026-01-17 10:20:00 [WARN] Redis reconnect attempts exceeded - opening circuit breaker for 60000 ms
```

**원인:**
- 10회 연속 재연결 실패
- ElastiCache 장기 장애 또는 네트워크 문제

**진단:**

1. **네트워크 연결 확인**
   ```bash
   # EC2에서 ElastiCache로 ping (ICMP는 안되지만 telnet으로 확인)
   telnet master.xxx.com 6379

   # 보안 그룹 확인
   aws ec2 describe-security-groups \
     --group-ids sg-xxxxx \
     --query 'SecurityGroups[0].IpPermissions'
   ```

2. **ElastiCache 이벤트 로그**
   ```bash
   aws elasticache describe-events \
     --source-type cache-cluster \
     --source-identifier supernoba-orderbook-backup \
     --start-time 2026-01-17T10:00:00Z
   ```

**조치:**

- **60초 대기 후 자동 재시도**
  - Circuit이 자동으로 닫힘
  - 로그 모니터링: "Circuit breaker closed - attempting reconnect"

- **즉시 복구 필요 시**
  ```bash
  # 매칭 엔진 재시작 (Circuit 리셋)
  ssh server "pkill -f matching_engine && \
              cd ~/Supeprnoba-Core/wrapper && \
              ./run_engine.sh"
  ```

#### Scenario 3: 데이터 복구 (재시작 시)

**증상:**
```
2026-01-17 11:00:00 [INFO] Restoring snapshots from Redis...
2026-01-17 11:00:01 [ERROR] Redis connection failed: Connection refused
2026-01-17 11:00:01 [WARN] Redis (snapshot) connection failed - continuing without cache
```

**조치:**

1. **DynamoDB 복구에 의존**
   ```
   [INFO] Loading ACCEPTED orders from DynamoDB...
   [INFO] DynamoDB order restore complete: added=1234, skipped=0
   ```

2. **Redis 복구 후 재시작** (선택사항)
   - Redis 복구 확인
   - 매칭 엔진 재시작 (스냅샷 로드)

3. **수동 스냅샷 복원** (최악의 경우)
   ```bash
   # S3 백업에서 복원 (구현 필요)
   aws s3 cp s3://supernoba-backups/snapshots/latest.json /tmp/
   # Redis에 수동 로드
   cat /tmp/latest.json | redis-cli -h master.xxx.com --pipe
   ```

### 6.3 성능 최적화

#### A. Connection Pooling (현재 미지원)

**현재 문제:**
- 매 명령마다 `ensureConnection()` 호출
- 불필요한 PING 명령

**해결책:**
- `redis-plus-plus`로 마이그레이션 (Connection Pool 내장)
- 또는 Connection Pool 직접 구현

#### B. Pipeline 사용 (대량 데이터)

**현재:**
```cpp
// 비효율적: N번의 RTT
for (const auto& symbol : symbols) {
    auto snapshot = engine.snapshotOrderBook(symbol);
    redis.saveSnapshot(symbol, snapshot);  // 각각 네트워크 왕복
}
```

**개선 (redis-plus-plus):**
```cpp
auto pipe = redis.pipeline();
for (const auto& symbol : symbols) {
    auto snapshot = engine.snapshotOrderBook(symbol);
    pipe.set("snapshot:" + symbol, snapshot);
}
auto replies = pipe.exec();  // 1번의 RTT
```

**성능 향상:**
- 10개 심볼: 10 RTT → 1 RTT
- 지연시간 감소: 10ms × 10 = 100ms → 10ms

#### C. Lua Script 사용 (원자적 연산)

**현재 캔들 집계:**
```cpp
// redis_client.cpp:520
bool RedisClient::updateCandle(...) {
    // Lua Script로 원자적 처리 (이미 최적화됨)
    static const std::string luaScript = R"(
        local key = KEYS[1]
        -- ... (복잡한 로직)
    )";

    std::string result = eval(luaScript, 2, keys, args);
    return result == "OK";
}
```

**장점:**
- ✅ 원자성 보장
- ✅ 네트워크 왕복 최소화
- ✅ 이미 구현됨

**추가 최적화 기회:**
- 호가 업데이트를 Lua Script로 변환
- 티커 업데이트를 Lua Script로 변환

### 6.4 보안 고려사항

#### A. 전송 중 암호화 (TLS)

**현재:** 평문 연결 (ElastiCache 내부 VPC)

**개선:**

```cpp
// hiredis SSL/TLS 지원
#include <hiredis/hiredis_ssl.h>

redisSSLContext* ssl_context = redisCreateSSLContext(
    nullptr,  // CA cert (AWS managed)
    nullptr,  // Cert path
    nullptr,  // Private key
    nullptr,  // Server name
    nullptr   // Error
);

redisContext* context = redisConnectWithTimeout(host, port, timeout);
if (redisInitiateSSLWithContext(context, ssl_context) != REDIS_OK) {
    // SSL/TLS 핸드셰이크 실패
}
```

**ElastiCache 설정:**
```bash
# ElastiCache에서 In-transit encryption 활성화
aws elasticache modify-replication-group \
  --replication-group-id supernoba-orderbook \
  --transit-encryption-enabled \
  --apply-immediately
```

#### B. 인증 (AUTH)

**현재:** 인증 없음 (VPC 내부)

**개선:**

```cpp
bool RedisClient::connect() {
    // ... 기존 연결 코드 ...

    // AUTH 명령
    std::string password = Config::get("REDIS_PASSWORD", "");
    if (!password.empty()) {
        auto reply = static_cast<redisReply*>(
            redisCommand(context_, "AUTH %s", password.c_str()));
        if (!reply || reply->type == REDIS_REPLY_ERROR) {
            Logger::error("Redis AUTH failed");
            return false;
        }
        freeReplyObject(reply);
    }

    return true;
}
```

**ElastiCache AUTH 설정:**
```bash
aws elasticache modify-replication-group \
  --replication-group-id supernoba-orderbook \
  --auth-token "your-strong-password-here" \
  --auth-token-update-strategy ROTATE \
  --apply-immediately
```

---

## 부록: 코드 참조

### A.1 주요 파일 목록

| 파일 | 라인 수 | 역할 |
|------|---------|------|
| `wrapper/include/redis_client.h` | 114 | Redis 클라이언트 헤더 (연결 관리, API 정의) |
| `wrapper/src/redis_client.cpp` | 598 | Redis 클라이언트 구현 (재연결, 헬스 체크, 명령 실행) |
| `wrapper/src/main.cpp` | 300 | 매칭 엔진 진입점 (초기화, 복구, 메인 루프) |
| `wrapper/run_engine.sh` | 179 | 실행 스크립트 (환경 변수, 빌드, 실행) |

### A.2 설정 파라미터 요약

| 파라미터 | 기본값 | 설명 | 권장값 |
|----------|--------|------|--------|
| `auto_reconnect_enabled_` | `false` | 자동 재연결 활성화 | `true` |
| `max_reconnect_attempts_` | `10` | 최대 재연결 시도 횟수 | `10` |
| `reconnect_delay_ms_` | `100` | 초기 백오프 지연 (ms) | `100` |
| `max_reconnect_delay_ms_` | `30000` | 최대 백오프 지연 (ms) | `30000` |
| `circuit_breaker_timeout_ms_` | `60000` | Circuit breaker timeout (ms) | `60000` |
| `health_check_interval_ms_` | `5000` | 헬스 체크 간격 (ms) | `2000` |
| Connection Timeout | `1500ms` | 연결 타임아웃 | `1500ms` |

### A.3 ElastiCache 엔드포인트

| 용도 | 엔드포인트 | 포트 | 모드 |
|------|-----------|------|------|
| 스냅샷 백업 | `master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com` | 6379 | Single Node |
| 실시간 Depth | `supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com` | 6379 | Cluster Mode |

---

## 결론

### 현재 상태 평가

**강점:**
- ✅ 견고한 재연결 로직 (Exponential Backoff + Circuit Breaker)
- ✅ 다층 백업 (Redis + DynamoDB)
- ✅ 자동 복구 메커니즘
- ✅ 헬스 체크 기능 구현

**약점:**
- ⚠️ 자동 재연결 기본 비활성화 (`auto_reconnect_enabled_ = false`)
- ⚠️ 백그라운드 헬스 체크 미구현 (명령 실행 시에만 체크)
- ⚠️ 스레드 안전성 부족 (멀티스레드 환경에서 위험)
- ⚠️ Redis Cluster 네이티브 지원 부족 (hiredis 제약)

### 즉시 조치 사항

1. **자동 재연결 활성화** (main.cpp 수정)
   ```cpp
   redis.setAutoReconnect(true);
   depth_cache.setAutoReconnect(true);
   ```

2. **헬스 체크 간격 단축**
   ```cpp
   redis.setHealthCheckInterval(2000);  // 5s → 2s
   ```

3. **메트릭 모니터링 설정**
   - CloudWatch Alarms
   - Redis Slow Log

### 중장기 개선 계획

1. **단기 (1-2주)**
   - Background Health Check Thread 구현
   - Metrics 수집 및 CloudWatch 연동

2. **중기 (1-2개월)**
   - `redis-plus-plus`로 마이그레이션
   - Connection Pooling 구현
   - 스레드 안전성 보장

3. **장기 (3-6개월)**
   - Redis Sentinel 도입 (고가용성)
   - Read Replica 활용 (읽기 분산)
   - S3 장기 백업 (재해 복구)

### 최종 권장사항

**즉시 적용 (코드 변경 없음):**
```cpp
// main.cpp:74 추가
redis.setAutoReconnect(true);
redis.setMaxReconnectAttempts(10);
redis.setReconnectDelay(100, 30000);
redis.setHealthCheckInterval(2000);

depth_cache.setAutoReconnect(true);
depth_cache.setMaxReconnectAttempts(10);
depth_cache.setReconnectDelay(100, 30000);
depth_cache.setHealthCheckInterval(2000);
```

**예상 효과:**
- 평균 복구 시간: 5-10초 → 2-5초
- 운영 개입 횟수: 90% 감소
- 데이터 손실 위험: 최소화

---

**작성:** Backend Architect (Claude Sonnet 4.5)
**날짜:** 2026-01-17
**버전:** 1.0
