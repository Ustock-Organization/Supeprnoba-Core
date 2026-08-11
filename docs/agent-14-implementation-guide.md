# Agent 14: Redis Failover 개선 구현 가이드

**관련 문서:** `agent-14-redis-failover-analysis.md`
**작성일:** 2026-01-17

---

## 목차

1. [즉시 적용 가능한 개선](#1-즉시-적용-가능한-개선)
2. [단기 개선 구현](#2-단기-개선-구현)
3. [테스트 시나리오](#3-테스트-시나리오)
4. [배포 절차](#4-배포-절차)

---

## 1. 즉시 적용 가능한 개선

### 1.1 자동 재연결 활성화

**파일:** `C:\develop\Supeprnoba-Core\wrapper\src\main.cpp`

**변경 전:**
```cpp
// main.cpp:73-86
try {
    // Redis 연결 (스냅샷 백업용)
    RedisClient redis(redis_host, redis_port);
    bool redis_connected = redis.connect();
    if (!redis_connected) {
        Logger::warn("Redis (snapshot) connection failed - continuing without cache");
    }

    // Depth 캐시 연결 (실시간 호가용)
    RedisClient depth_cache(depth_cache_host, depth_cache_port);
    bool depth_connected = depth_cache.connect();
    if (!depth_connected) {
        Logger::warn("Redis (depth) connection failed - continuing without depth cache");
    }
```

**변경 후:**
```cpp
// main.cpp:73-100
try {
    // Redis 연결 (스냅샷 백업용)
    RedisClient redis(redis_host, redis_port);
    bool redis_connected = redis.connect();

    // === 자동 재연결 설정 ===
    redis.setAutoReconnect(true);
    redis.setMaxReconnectAttempts(10);
    redis.setReconnectDelay(100, 30000);     // 100ms ~ 30s exponential backoff
    redis.setHealthCheckInterval(2000);      // 2초마다 헬스 체크

    if (!redis_connected) {
        Logger::warn("Redis (snapshot) initial connection failed - will auto-reconnect");
    } else {
        Logger::info("Redis (snapshot) connected with auto-reconnect enabled");
    }

    // Depth 캐시 연결 (실시간 호가용)
    RedisClient depth_cache(depth_cache_host, depth_cache_port);
    bool depth_connected = depth_cache.connect();

    // === 자동 재연결 설정 ===
    depth_cache.setAutoReconnect(true);
    depth_cache.setMaxReconnectAttempts(10);
    depth_cache.setReconnectDelay(100, 30000);
    depth_cache.setHealthCheckInterval(2000);

    if (!depth_connected) {
        Logger::warn("Redis (depth) initial connection failed - will auto-reconnect");
    } else {
        Logger::info("Redis (depth) connected with auto-reconnect enabled");
    }
```

**효과:**
- ElastiCache 일시 장애 시 자동 복구
- 평균 복구 시간: 2-5초
- 운영자 개입 불필요

---

## 2. 단기 개선 구현

### 2.1 Background Health Check Thread

#### 2.1.1 헤더 수정

**파일:** `C:\develop\Supeprnoba-Core\wrapper\include\redis_client.h`

**추가 내용:**
```cpp
#pragma once

#include <hiredis/hiredis.h>
#include <string>
#include <memory>
#include <optional>
#include <vector>
#include <map>
#include <thread>        // ← 추가
#include <mutex>         // ← 추가
#include <atomic>        // ← 추가

namespace aws_wrapper {

class RedisClient {
public:
    // ... 기존 public 메서드 ...

    // === Background Health Check (추가) ===
    void startBackgroundHealthCheck();
    void stopBackgroundHealthCheck();
    bool isBackgroundHealthCheckRunning() const { return health_check_running_.load(); }

    // ... 기존 코드 ...

private:
    // ... 기존 private 멤버 ...

    // === Background Health Check (추가) ===
    std::thread health_check_thread_;
    std::atomic<bool> health_check_running_{false};
    mutable std::mutex context_mutex_;   // context_ 접근 동기화

    void healthCheckLoop();

    // ... 기존 private 메서드 ...
};

} // namespace aws_wrapper
```

#### 2.1.2 구현 추가

**파일:** `C:\develop\Supeprnoba-Core\wrapper\src\redis_client.cpp`

**파일 끝에 추가:**
```cpp
// === Background Health Check Implementation ===

void RedisClient::healthCheckLoop() {
    Logger::info("Background health check thread started for:", host_, ":", port_);

    while (health_check_running_.load()) {
        std::this_thread::sleep_for(
            std::chrono::milliseconds(health_check_interval_ms_));

        std::lock_guard<std::mutex> lock(context_mutex_);

        if (context_ && state_ == ConnectionState::CONNECTED) {
            // 연결된 상태 - 헬스 체크 수행
            if (!performHealthCheck()) {
                Logger::warn("Background health check failed for:", host_);

                // 자동 재연결 활성화 시 재연결 시도
                if (auto_reconnect_enabled_) {
                    if (attemptReconnect()) {
                        Logger::info("Background reconnect successful for:", host_);
                    }
                }
            }
        } else if (!context_ && auto_reconnect_enabled_ &&
                   state_ != ConnectionState::CIRCUIT_OPEN) {
            // 연결 끊김 상태 - 재연결 시도
            if (attemptReconnect()) {
                Logger::info("Background reconnect restored connection for:", host_);
            }
        }
    }

    Logger::info("Background health check thread stopped for:", host_, ":", port_);
}

void RedisClient::startBackgroundHealthCheck() {
    if (health_check_running_.load()) {
        Logger::warn("Background health check already running for:", host_);
        return;
    }

    health_check_running_.store(true);
    health_check_thread_ = std::thread(&RedisClient::healthCheckLoop, this);

    Logger::info("Background health check enabled for:", host_, ":",
                 port_, "interval:", health_check_interval_ms_, "ms");
}

void RedisClient::stopBackgroundHealthCheck() {
    if (!health_check_running_.load()) {
        return;
    }

    Logger::info("Stopping background health check for:", host_, ":", port_);
    health_check_running_.store(false);

    if (health_check_thread_.joinable()) {
        health_check_thread_.join();
    }

    Logger::info("Background health check stopped for:", host_, ":", port_);
}
```

#### 2.1.3 스레드 안전성 보장

**파일:** `C:\develop\Supeprnoba-Core\wrapper\src\redis_client.cpp`

**기존 명령 메서드 수정 (예시):**

```cpp
bool RedisClient::set(const std::string& key, const std::string& value) {
    std::lock_guard<std::mutex> lock(context_mutex_);  // ← 추가

    if (!ensureConnection()) return false;

    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "SET %s %s", key.c_str(), value.c_str()));

    if (!reply) {
        Logger::error("Redis SET failed:", context_->errstr);
        markDisconnected();

        // Try one immediate reconnect
        if (auto_reconnect_enabled_ && attemptReconnect()) {
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

    bool success = (reply->type != REDIS_REPLY_ERROR);
    freeReplyObject(reply);
    return success;
}
```

**주의사항:**
- 모든 public 메서드에 `std::lock_guard<std::mutex> lock(context_mutex_);` 추가
- 성능 영향: 무시할 수준 (Redis 명령 자체가 네트워크 I/O)
- 데드락 방지: 재귀 mutex 불필요 (lock은 메서드 단위)

#### 2.1.4 main.cpp 수정

**파일:** `C:\develop\Supeprnoba-Core\wrapper\src\main.cpp`

**초기화 섹션:**
```cpp
// main.cpp:73-100 (이전 수정에 추가)
try {
    // Redis 연결 (스냅샷 백업용)
    RedisClient redis(redis_host, redis_port);
    bool redis_connected = redis.connect();

    redis.setAutoReconnect(true);
    redis.setMaxReconnectAttempts(10);
    redis.setReconnectDelay(100, 30000);
    redis.setHealthCheckInterval(2000);
    redis.startBackgroundHealthCheck();  // ← 추가

    // Depth 캐시 연결
    RedisClient depth_cache(depth_cache_host, depth_cache_port);
    bool depth_connected = depth_cache.connect();

    depth_cache.setAutoReconnect(true);
    depth_cache.setMaxReconnectAttempts(10);
    depth_cache.setReconnectDelay(100, 30000);
    depth_cache.setHealthCheckInterval(2000);
    depth_cache.startBackgroundHealthCheck();  // ← 추가

    // ... 나머지 초기화 ...
```

**종료 섹션:**
```cpp
// main.cpp:280-290
    // 정리
    Logger::info("Shutting down...");

    // === Background health check 중지 (추가) ===
    redis.stopBackgroundHealthCheck();
    depth_cache.stopBackgroundHealthCheck();

    if (ranking_enabled) {
        ranking_manager.stopSnapshotThread();
    }
    consumer.stop();
    grpc_service.stop();
    producer.flush(5000);

    Logger::info("=== Shutdown Complete ===");
```

### 2.2 메트릭 수집

#### 2.2.1 헤더 수정

**파일:** `C:\develop\Supeprnoba-Core\wrapper\include\redis_client.h`

**추가 내용:**
```cpp
class RedisClient {
public:
    // ... 기존 코드 ...

    // === Metrics (추가) ===
    struct Metrics {
        uint64_t total_commands;
        uint64_t failed_commands;
        uint64_t reconnect_count;
        uint64_t health_check_failures;
        int current_state;  // 0=DISCONNECTED, 1=CONNECTED, 2=CIRCUIT_OPEN
        int current_reconnect_attempts;
        std::chrono::milliseconds uptime;
        std::chrono::milliseconds total_downtime;
    };

    Metrics getMetrics() const;
    void resetMetrics();

private:
    // ... 기존 멤버 ...

    // === Metrics (추가) ===
    mutable std::atomic<uint64_t> total_commands_{0};
    mutable std::atomic<uint64_t> failed_commands_{0};
    mutable std::atomic<uint64_t> reconnect_count_{0};
    mutable std::atomic<uint64_t> health_check_failures_{0};
    std::chrono::steady_clock::time_point start_time_;
    std::chrono::steady_clock::time_point last_disconnect_time_;
    std::chrono::milliseconds total_downtime_{0};
};
```

#### 2.2.2 구현 추가

**파일:** `C:\develop\Supeprnoba-Core\wrapper\src\redis_client.cpp`

**생성자 수정:**
```cpp
RedisClient::RedisClient(const std::string& host, int port)
    : host_(host), port_(port), start_time_(std::chrono::steady_clock::now()) {
    Logger::info("RedisClient created, host:", host, "port:", port);
}
```

**메트릭 메서드 추가:**
```cpp
RedisClient::Metrics RedisClient::getMetrics() const {
    std::lock_guard<std::mutex> lock(context_mutex_);

    Metrics m;
    m.total_commands = total_commands_.load();
    m.failed_commands = failed_commands_.load();
    m.reconnect_count = reconnect_count_.load();
    m.health_check_failures = health_check_failures_.load();
    m.current_state = static_cast<int>(state_);
    m.current_reconnect_attempts = current_reconnect_attempts_;

    auto now = std::chrono::steady_clock::now();
    m.uptime = std::chrono::duration_cast<std::chrono::milliseconds>(
        now - start_time_);

    m.total_downtime = total_downtime_;
    if (state_ != ConnectionState::CONNECTED && last_disconnect_time_.time_since_epoch().count() > 0) {
        m.total_downtime += std::chrono::duration_cast<std::chrono::milliseconds>(
            now - last_disconnect_time_);
    }

    return m;
}

void RedisClient::resetMetrics() {
    std::lock_guard<std::mutex> lock(context_mutex_);

    total_commands_.store(0);
    failed_commands_.store(0);
    reconnect_count_.store(0);
    health_check_failures_.store(0);
    start_time_ = std::chrono::steady_clock::now();
    total_downtime_ = std::chrono::milliseconds{0};

    Logger::info("Metrics reset for:", host_, ":", port_);
}
```

**명령 메서드 수정 (메트릭 기록):**
```cpp
bool RedisClient::set(const std::string& key, const std::string& value) {
    std::lock_guard<std::mutex> lock(context_mutex_);

    total_commands_.fetch_add(1);  // ← 추가

    if (!ensureConnection()) {
        failed_commands_.fetch_add(1);  // ← 추가
        return false;
    }

    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "SET %s %s", key.c_str(), value.c_str()));

    if (!reply) {
        Logger::error("Redis SET failed:", context_->errstr);
        failed_commands_.fetch_add(1);  // ← 추가
        markDisconnected();

        // ... 재연결 로직 ...
        return false;
    }

    bool success = (reply->type != REDIS_REPLY_ERROR);
    if (!success) {
        failed_commands_.fetch_add(1);  // ← 추가
    }

    freeReplyObject(reply);
    return success;
}
```

**markDisconnected 수정:**
```cpp
void RedisClient::markDisconnected() {
    if (state_ == ConnectionState::CONNECTED) {
        Logger::warn("Redis connection lost - marking disconnected");
        state_ = ConnectionState::DISCONNECTED;
        last_disconnect_time_ = std::chrono::steady_clock::now();  // ← 추가
    }

    if (context_) {
        redisFree(context_);
        context_ = nullptr;
    }
}
```

**attemptReconnect 수정:**
```cpp
bool RedisClient::attemptReconnect() {
    // ... 기존 로직 ...

    bool success = connect();

    if (success) {
        reconnect_count_.fetch_add(1);  // ← 추가

        // Downtime 계산
        if (last_disconnect_time_.time_since_epoch().count() > 0) {
            auto downtime = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - last_disconnect_time_);
            total_downtime_ += downtime;
            last_disconnect_time_ = std::chrono::steady_clock::time_point{};
        }

        Logger::info("Redis reconnected successfully after", current_reconnect_attempts_, "attempts");
        return true;
    } else {
        Logger::warn("Redis reconnect failed, attempt", current_reconnect_attempts_);
        return false;
    }
}
```

**performHealthCheck 수정:**
```cpp
bool RedisClient::performHealthCheck() {
    last_health_check_ = std::chrono::steady_clock::now();

    if (!context_) {
        health_check_failures_.fetch_add(1);  // ← 추가
        return false;
    }

    auto reply = static_cast<redisReply*>(redisCommand(context_, "PING"));

    if (!reply) {
        Logger::warn("Redis health check failed - connection appears dead:",
                     context_->errstr);
        health_check_failures_.fetch_add(1);  // ← 추가
        markDisconnected();
        return false;
    }

    bool healthy = (reply->type == REDIS_REPLY_STATUS &&
                    std::string(reply->str) == "PONG");
    freeReplyObject(reply);

    if (!healthy) {
        Logger::warn("Redis health check failed - unexpected PING response");
        health_check_failures_.fetch_add(1);  // ← 추가
        markDisconnected();
        return false;
    }

    return true;
}
```

#### 2.2.3 메트릭 로깅

**파일:** `C:\develop\Supeprnoba-Core\wrapper\src\main.cpp`

**메트릭 루프 수정:**
```cpp
// main.cpp:268-278
    // 30초마다 메트릭 로깅
    if (std::chrono::duration_cast<std::chrono::seconds>(now - last_metrics).count() >= 30) {
        auto& m = Metrics::instance();
        Logger::info("=== Matching Engine Metrics ===");
        Logger::info("Orders received:", m.getOrdersReceived());
        Logger::info("Orders accepted:", m.getOrdersAccepted());
        Logger::info("Trades executed:", m.getTradesExecuted());

        // === Redis Metrics (추가) ===
        auto redis_metrics = redis.getMetrics();
        Logger::info("=== Redis (Snapshot) Metrics ===");
        Logger::info("Total commands:", redis_metrics.total_commands);
        Logger::info("Failed commands:", redis_metrics.failed_commands);
        Logger::info("Reconnects:", redis_metrics.reconnect_count);
        Logger::info("Health check failures:", redis_metrics.health_check_failures);
        Logger::info("Current state:",
                     (redis_metrics.current_state == 0 ? "DISCONNECTED" :
                      redis_metrics.current_state == 1 ? "CONNECTED" :
                      "CIRCUIT_OPEN"));
        Logger::info("Uptime:", redis_metrics.uptime.count(), "ms");
        Logger::info("Total downtime:", redis_metrics.total_downtime.count(), "ms");

        auto depth_metrics = depth_cache.getMetrics();
        Logger::info("=== Redis (Depth) Metrics ===");
        Logger::info("Total commands:", depth_metrics.total_commands);
        Logger::info("Failed commands:", depth_metrics.failed_commands);
        Logger::info("Reconnects:", depth_metrics.reconnect_count);
        Logger::info("Current state:",
                     (depth_metrics.current_state == 0 ? "DISCONNECTED" :
                      depth_metrics.current_state == 1 ? "CONNECTED" :
                      "CIRCUIT_OPEN"));

        Logger::info("===============================");
        last_metrics = now;
    }
```

---

## 3. 테스트 시나리오

### 3.1 자동 재연결 테스트

#### 시나리오 1: ElastiCache 재시작

**목적:** 자동 재연결이 정상 동작하는지 확인

**절차:**

1. **엔진 시작**
   ```bash
   ssh server "cd ~/Supeprnoba-Core/wrapper && ./run_engine.sh"
   ```

2. **정상 상태 확인**
   ```bash
   # 로그 확인
   ssh server "tail -f ~/engine.log | grep Redis"

   # 예상 출력:
   # [INFO] Redis connected to: master.xxx.com : 6379
   # [INFO] Redis (snapshot) connected with auto-reconnect enabled
   # [INFO] Background health check enabled for: master.xxx.com
   ```

3. **ElastiCache 재시작**
   ```bash
   aws elasticache reboot-cache-cluster \
     --cache-cluster-id supernoba-orderbook-backup-001 \
     --cache-node-ids-to-reboot 0001 \
     --region ap-northeast-2
   ```

4. **로그 모니터링**
   ```bash
   ssh server "tail -f ~/engine.log | grep -E '(Redis|reconnect|health)'"

   # 예상 출력:
   # [WARN] Redis health check failed - connection appears dead: Connection refused
   # [WARN] Redis connection lost - marking disconnected
   # [INFO] Redis reconnect attempt 1 / 10 after 0 ms backoff
   # [WARN] Redis reconnect failed, attempt 1
   # [INFO] Redis reconnect attempt 2 / 10 after 100 ms backoff
   # [WARN] Redis reconnect failed, attempt 2
   # ...
   # [INFO] Redis reconnect attempt 5 / 10 after 800 ms backoff
   # [INFO] Redis reconnected successfully after 5 attempts
   # [INFO] Background reconnect restored connection for: master.xxx.com
   ```

5. **메트릭 확인**
   ```bash
   # 30초 후 메트릭 출력 대기
   # 예상 출력:
   # [INFO] === Redis (Snapshot) Metrics ===
   # [INFO] Reconnects: 1
   # [INFO] Health check failures: 5
   # [INFO] Current state: CONNECTED
   # [INFO] Total downtime: 4500 ms
   ```

6. **기능 검증**
   ```bash
   # Redis에 데이터 저장 확인
   redis-cli -h master.xxx.com KEYS "snapshot:*"
   ```

**성공 기준:**
- ✅ 5회 이내 재연결 성공
- ✅ Downtime 5초 이내
- ✅ 스냅샷 저장 재개

#### 시나리오 2: 네트워크 분리

**목적:** Circuit Breaker 동작 확인

**절차:**

1. **보안 그룹 수정 (Redis 차단)**
   ```bash
   # EC2 → ElastiCache 트래픽 차단
   aws ec2 revoke-security-group-ingress \
     --group-id sg-xxxxx \
     --protocol tcp \
     --port 6379 \
     --source-group sg-yyyyy
   ```

2. **로그 모니터링**
   ```bash
   # 예상 출력:
   # [INFO] Redis reconnect attempt 1 / 10 after 0 ms backoff
   # [WARN] Redis reconnect failed, attempt 1
   # ...
   # [INFO] Redis reconnect attempt 10 / 10 after 25600 ms backoff
   # [WARN] Redis reconnect failed, attempt 10
   # [WARN] Redis reconnect attempts exceeded - opening circuit breaker for 60000 ms
   ```

3. **60초 대기**
   ```bash
   # 60초간 재연결 시도 없음을 확인
   sleep 60
   ```

4. **Circuit 자동 재시작 확인**
   ```bash
   # 예상 출력:
   # [INFO] Redis circuit breaker closed - attempting reconnect
   # [INFO] Redis reconnect attempt 1 / 10 after 0 ms backoff
   # [WARN] Redis reconnect failed, attempt 1
   ```

5. **보안 그룹 복원**
   ```bash
   aws ec2 authorize-security-group-ingress \
     --group-id sg-xxxxx \
     --protocol tcp \
     --port 6379 \
     --source-group sg-yyyyy
   ```

6. **재연결 확인**
   ```bash
   # 예상 출력:
   # [INFO] Redis reconnected successfully after 2 attempts
   ```

**성공 기준:**
- ✅ 10회 실패 후 Circuit OPEN
- ✅ 60초간 재시도 중단
- ✅ 60초 후 자동 재시작
- ✅ 네트워크 복구 후 즉시 재연결

### 3.2 Background Health Check 테스트

**목적:** Idle 상태에서도 장애 감지

**절차:**

1. **엔진 시작 (거래 없음)**
   ```bash
   ssh server "cd ~/Supeprnoba-Core/wrapper && ./run_engine.sh"
   ```

2. **60초간 idle**
   ```bash
   # 거래 없음 - Redis 명령 실행 없음
   sleep 60
   ```

3. **ElastiCache 재시작**
   ```bash
   aws elasticache reboot-cache-cluster \
     --cache-cluster-id supernoba-orderbook-backup-001
   ```

4. **즉시 감지 확인** (2초 이내)
   ```bash
   ssh server "tail -f ~/engine.log | grep health"

   # 예상 출력 (2초 이내):
   # [WARN] Background health check failed for: master.xxx.com
   # [INFO] Background reconnect attempt...
   ```

**성공 기준:**
- ✅ 명령 실행 없이도 장애 감지
- ✅ 평균 감지 시간: 1-2초 (헬스 체크 간격의 절반)

### 3.3 성능 테스트

**목적:** 스레드 안전성 및 성능 오버헤드 확인

**절차:**

1. **부하 생성**
   ```bash
   # 초당 1000건 주문 발생
   # (프론트엔드 또는 테스트 스크립트 사용)
   ```

2. **메트릭 수집 (5분간)**
   ```bash
   ssh server "tail -f ~/engine.log | grep 'Redis.*Metrics'"
   ```

3. **성능 지표 분석**
   ```
   Total commands: 30,000 (5분간)
   Failed commands: 0
   평균 처리량: 100 commands/sec
   ```

**성공 기준:**
- ✅ Mutex 대기 시간 < 1ms
- ✅ Failed commands = 0
- ✅ CPU 사용률 증가 < 5%

---

## 4. 배포 절차

### 4.1 개발 환경 배포

#### Step 1: 코드 수정

```bash
# 로컬 Windows 환경
cd C:\develop\Supeprnoba-Core\wrapper

# 파일 수정
# - include/redis_client.h
# - src/redis_client.cpp
# - src/main.cpp
```

#### Step 2: Git 커밋

```bash
git add include/redis_client.h src/redis_client.cpp src/main.cpp
git commit -m "feat: implement Redis auto-reconnect and background health check

- Enable auto-reconnect with exponential backoff (100ms ~ 30s)
- Add background health check thread (2s interval)
- Add metrics collection (commands, failures, reconnects, downtime)
- Add thread safety with mutex for context_ access
- Circuit breaker pattern for resilience

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"

git push origin develop
```

#### Step 3: EC2 배포 (개발 환경)

```bash
# SSH로 EC2 접속
ssh server

# 코드 업데이트
cd ~/Supeprnoba-Core/wrapper
git pull origin develop

# 빌드
cmake -B build -S . \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE=~/vcpkg/scripts/buildsystems/vcpkg.cmake

cmake --build build -j$(nproc)

# 기존 엔진 중지
pkill -f matching_engine

# DEV 모드로 시작 (캐시 초기화, DynamoDB 로드 비활성화)
./run_engine.sh --dev --debug
```

#### Step 4: 로그 모니터링

```bash
# 별도 터미널에서
ssh server "tail -f ~/engine.log | grep -E '(Redis|reconnect|health|Metrics)'"
```

#### Step 5: 기능 검증

```bash
# 1. 정상 시작 확인
# [INFO] Redis (snapshot) connected with auto-reconnect enabled
# [INFO] Background health check enabled for: master.xxx.com

# 2. 헬스 체크 동작 확인 (2초마다)
# (로그 없음 = 정상)

# 3. 메트릭 확인 (30초 후)
# [INFO] === Redis (Snapshot) Metrics ===
# [INFO] Total commands: 15
# [INFO] Failed commands: 0
# [INFO] Current state: CONNECTED
```

### 4.2 프로덕션 배포

#### Pre-deployment Checklist

- [ ] 개발 환경에서 24시간 이상 안정성 확인
- [ ] ElastiCache 재시작 테스트 완료
- [ ] 네트워크 분리 테스트 완료
- [ ] 성능 저하 없음 확인 (< 5% CPU 증가)
- [ ] 백업 생성
  - [ ] RDS 스냅샷
  - [ ] ElastiCache 백업
  - [ ] EC2 AMI

#### Step 1: Maintenance Window 공지

```
예정 유지보수 시간: 2026-01-18 03:00-03:30 KST
영향: 실시간 거래 일시 중단 (최대 5분)
목적: Redis 장애 대응 로직 개선
```

#### Step 2: 배포 (Blue-Green)

```bash
# === Green 환경 준비 ===

# 1. 새 EC2 인스턴스 시작 (Green)
aws ec2 run-instances \
  --image-id ami-xxxxx \
  --instance-type t3.medium \
  --key-name stock-keypair \
  --security-group-ids sg-xxxxx \
  --subnet-id subnet-xxxxx \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=stock-matching-green}]'

# 2. Green에 코드 배포
ssh stock-matching-green "cd ~/Supeprnoba-Core/wrapper && \
                           git pull origin main && \
                           cmake -B build -S . -DCMAKE_BUILD_TYPE=Release && \
                           cmake --build build -j$(nproc)"

# 3. Green 시작
ssh stock-matching-green "cd ~/Supeprnoba-Core/wrapper && \
                           nohup ./run_engine.sh > ~/engine.log 2>&1 &"

# 4. Green 정상 동작 확인 (5분)
ssh stock-matching-green "tail -f ~/engine.log"

# === Blue → Green 전환 ===

# 5. Blue 종료
ssh stock-matching-blue "pkill -f matching_engine"

# 6. Route53/Load Balancer 업데이트 (해당 시)
# (현재는 직접 연결이므로 생략)

# 7. Green 모니터링 (30분)
watch -n 5 'ssh stock-matching-green "ps aux | grep matching_engine"'

# === Rollback Plan (필요 시) ===

# 문제 발생 시 즉시 Blue로 복귀
ssh stock-matching-blue "cd ~/Supeprnoba-Core/wrapper && \
                          nohup ./run_engine.sh > ~/engine.log 2>&1 &"
```

#### Step 3: Post-deployment Verification

```bash
# 1. 메트릭 확인 (CloudWatch)
aws cloudwatch get-metric-statistics \
  --namespace Custom/MatchingEngine \
  --metric-name RedisReconnects \
  --dimensions Name=Host,Value=stock-matching-green \
  --start-time 2026-01-18T03:00:00Z \
  --end-time 2026-01-18T04:00:00Z \
  --period 300 \
  --statistics Sum

# 2. 로그 분석
ssh stock-matching-green "grep -c ERROR ~/engine.log"

# 3. 거래 정상 처리 확인
# (프론트엔드에서 주문 테스트)

# 4. Redis 연결 상태
redis-cli -h master.xxx.com INFO clients
```

### 4.3 Rollback 절차

**트리거 조건:**
- 메트릭에서 Failed commands > 1%
- CPU 사용률 > 90%
- 응답 시간 > 5초
- 운영자 판단

**Rollback Steps:**

```bash
# 1. Blue 환경 재시작
ssh stock-matching-blue "cd ~/Supeprnoba-Core/wrapper && \
                          git checkout previous-stable-version && \
                          cmake --build build -j$(nproc) && \
                          nohup ./run_engine.sh > ~/engine.log 2>&1 &"

# 2. Green 종료
ssh stock-matching-green "pkill -f matching_engine"

# 3. 정상 복구 확인
ssh stock-matching-blue "tail -f ~/engine.log | grep RUNNING"

# 4. 사후 분석
# - Green 로그 수집
# - 메트릭 분석
# - 원인 파악
```

---

## 부록: 설정 참조

### A.1 권장 설정값

| 파라미터 | 개발 환경 | 프로덕션 환경 | 설명 |
|----------|-----------|---------------|------|
| `auto_reconnect_enabled` | `true` | `true` | 자동 재연결 필수 |
| `max_reconnect_attempts` | `10` | `10` | 너무 많으면 복구 지연 |
| `reconnect_delay_ms` | `100` | `100` | 초기 백오프 |
| `max_reconnect_delay_ms` | `30000` | `30000` | 최대 30초 |
| `circuit_breaker_timeout_ms` | `60000` | `60000` | 1분 후 재시도 |
| `health_check_interval_ms` | `2000` | `2000` | 2초 간격 (평균 감지 1초) |
| Connection Timeout | `1500ms` | `1500ms` | ElastiCache 응답 시간 |

### A.2 모니터링 임계값

| 메트릭 | 경고 | 위험 | 조치 |
|--------|------|------|------|
| Failed Commands | > 1% | > 5% | 로그 확인, ElastiCache 상태 |
| Reconnects (30분) | > 3 | > 10 | 네트워크/ElastiCache 점검 |
| Health Check Failures | > 10 | > 50 | Circuit Breaker 동작 확인 |
| Total Downtime (1시간) | > 60s | > 300s | 장기 장애 - 긴급 대응 |
| Current State | CIRCUIT_OPEN | N/A | 즉시 원인 파악 |

---

**작성:** Backend Architect (Claude Sonnet 4.5)
**날짜:** 2026-01-17
**버전:** 1.0
