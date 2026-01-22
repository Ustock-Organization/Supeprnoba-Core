# Redis Auto-Reconnection Implementation

## Overview

This document describes the automatic reconnection logic implemented in `RedisClient` to handle Redis connection failures gracefully with exponential backoff and circuit breaker pattern.

---

## Problem Statement

### Before Implementation

The original `RedisClient` had the following issues:

1. **No reconnection logic** - Connection attempted once at startup; failures were permanent
2. **Silent degradation** - When Redis failed, operations returned `false` but system continued in degraded state
3. **No health monitoring** - Connection assumed healthy unless operation failed
4. **No backoff** - Would spam Redis during outages if retry was implemented naively

### Failure Scenarios

#### Scenario 1: Redis Restart
- Redis goes down for maintenance (30 seconds)
- Next operation fails silently
- `context_` pointer still valid, `isConnected()` returns true
- All operations fail but system thinks Redis is connected
- **Duration: Until engine restart (potentially days)**

#### Scenario 2: Network Partition
- Brief network blip (5 seconds)
- hiredis times out
- Connection never recovers
- **Impact: Permanent data loss (candles, depth, notifications)**

#### Scenario 3: Redis Overloaded
- Redis CPU at 100%, commands timeout
- No backoff - continues hammering Redis
- **Impact: Makes problem worse**

---

## Solution Architecture

### Design Principles

1. **Fail Fast, Recover Automatically** - Don't hide failures, but recover without human intervention
2. **Exponential Backoff** - Don't hammer a dead service
3. **Circuit Breaker** - Stop trying if clearly down, but periodically retry
4. **Health Monitoring** - Actively check connection health
5. **Graceful Degradation** - System works without Redis, but tries to recover

### Components

```
┌─────────────────────────────────────────────────────────────────┐
│                        RedisClient                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Connection State Machine                     │  │
│  │                                                            │  │
│  │   DISCONNECTED ──attempt──> CONNECTED                     │  │
│  │        │                        │                         │  │
│  │        │                        │ health check fail       │  │
│  │        │                        └──────┐                  │  │
│  │        │                               ▼                  │  │
│  │        │                        DISCONNECTED              │  │
│  │        │                               │                  │  │
│  │        │ max attempts exceeded         │                  │  │
│  │        └─────────────> CIRCUIT_OPEN <──┘                  │  │
│  │                               │                           │  │
│  │                               │ timeout (60s)             │  │
│  │                               └──> DISCONNECTED           │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Exponential Backoff                          │  │
│  │                                                            │  │
│  │  Attempt 1:   0ms (immediate)                             │  │
│  │  Attempt 2: 100ms                                         │  │
│  │  Attempt 3: 200ms                                         │  │
│  │  Attempt 4: 400ms                                         │  │
│  │  Attempt 5: 800ms                                         │  │
│  │  ...                                                       │  │
│  │  Attempt N: min(100ms * 2^(N-1), 30000ms)                │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Health Check (PING every 5s)                 │  │
│  │                                                            │  │
│  │  • Periodic PING to detect dead connections               │  │
│  │  • Triggered before operations if due                     │  │
│  │  • Marks connection disconnected on failure               │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Details

### State Management

**ConnectionState Enum**
```cpp
enum class ConnectionState {
    CONNECTED,      // Healthy connection
    DISCONNECTED,   // No connection, will retry with backoff
    CIRCUIT_OPEN    // Too many failures, temporarily stop retrying
};
```

### Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `auto_reconnect_enabled_` | `false` | Enable automatic reconnection (opt-in) |
| `max_reconnect_attempts_` | `10` | Max attempts before circuit breaker opens |
| `reconnect_delay_ms_` | `100` | Initial backoff delay |
| `max_reconnect_delay_ms_` | `30000` | Max backoff delay (30 seconds) |
| `circuit_breaker_timeout_ms_` | `60000` | How long circuit stays open (60 seconds) |
| `health_check_interval_ms_` | `5000` | PING interval (5 seconds) |

### Core Methods

#### `ensureConnection()`
Called before every operation. Checks connection health and attempts reconnection if needed.

```cpp
bool RedisClient::ensureConnection() {
    // If connected, check if health check is due
    if (context_ && state_ == ConnectionState::CONNECTED) {
        if (isHealthCheckDue()) {
            if (!performHealthCheck()) {
                // Falls through to reconnect logic below
            } else {
                return true;  // Healthy
            }
        } else {
            return true;  // Skip check, assume healthy
        }
    }

    // If disconnected and auto-reconnect enabled, try reconnect
    if (!context_ && auto_reconnect_enabled_) {
        return attemptReconnect();
    }

    return context_ != nullptr;
}
```

#### `attemptReconnect()`
Implements exponential backoff and circuit breaker logic.

**Backoff Calculation**
```
delay = min(100ms * 2^(attempt-1), 30000ms)

Attempt 1:     0ms (immediate)
Attempt 2:   100ms
Attempt 3:   200ms
Attempt 4:   400ms
Attempt 5:   800ms
Attempt 6:  1600ms
Attempt 7:  3200ms
Attempt 8:  6400ms
Attempt 9: 12800ms
Attempt 10: 25600ms
Attempt 11: 30000ms (capped)
```

**Circuit Breaker Logic**
```
Attempts 1-10: Exponential backoff
After 10 failures: Circuit opens for 60 seconds
After 60 seconds: Circuit closes, reset counter, try again
```

#### `performHealthCheck()`
Sends PING command to verify connection is alive.

```cpp
bool RedisClient::performHealthCheck() {
    auto reply = redisCommand(context_, "PING");

    if (!reply || reply->type != REDIS_REPLY_STATUS ||
        std::string(reply->str) != "PONG") {
        markDisconnected();
        return false;
    }

    return true;
}
```

#### `markDisconnected()`
Safely closes connection and updates state.

```cpp
void RedisClient::markDisconnected() {
    if (state_ == ConnectionState::CONNECTED) {
        Logger::warn("Redis connection lost - marking disconnected");
        state_ = ConnectionState::DISCONNECTED;
    }

    if (context_) {
        redisFree(context_);
        context_ = nullptr;
    }
}
```

### Operation Pattern

All operations now follow this pattern:

```cpp
bool RedisClient::set(const std::string& key, const std::string& value) {
    // 1. Ensure connection (with health check and auto-reconnect)
    if (!ensureConnection()) return false;

    // 2. Execute operation
    auto reply = redisCommand(context_, "SET %s %s", key.c_str(), value.c_str());

    // 3. Handle failure
    if (!reply) {
        Logger::error("Redis SET failed:", context_->errstr);
        markDisconnected();

        // 4. Try one immediate reconnect (for transient failures)
        if (auto_reconnect_enabled_ && attemptReconnect()) {
            reply = redisCommand(context_, "SET %s %s", key.c_str(), value.c_str());
            if (reply) {
                bool success = (reply->type != REDIS_REPLY_ERROR);
                freeReplyObject(reply);
                return success;
            }
        }
        return false;
    }

    // 5. Success
    bool success = (reply->type != REDIS_REPLY_ERROR);
    freeReplyObject(reply);
    return success;
}
```

---

## Configuration

### Environment Variables

Add to `run_engine.sh` or environment:

```bash
export REDIS_AUTO_RECONNECT=true
export REDIS_MAX_RECONNECT_ATTEMPTS=10
export REDIS_RECONNECT_DELAY_MS=100
export REDIS_MAX_RECONNECT_DELAY_MS=30000
export REDIS_HEALTH_CHECK_INTERVAL_MS=5000
export REDIS_CIRCUIT_BREAKER_TIMEOUT_MS=60000
```

### Code Configuration

```cpp
RedisClient redis(redis_host, redis_port);

// Enable auto-reconnect
redis.setAutoReconnect(true);

// Configure backoff (optional - defaults are reasonable)
redis.setMaxReconnectAttempts(10);
redis.setReconnectDelay(100, 30000);  // 100ms to 30s
redis.setHealthCheckInterval(5000);   // 5 seconds

// Initial connection
bool connected = redis.connect();
if (!connected) {
    Logger::warn("Initial Redis connection failed - will auto-reconnect");
}
```

---

## Logging

### Normal Operation

```
[INFO] Redis connected to: valkey.example.com : 6379
[INFO] Redis auto-reconnect: enabled
[INFO] Redis max reconnect attempts set to: 10
[INFO] Redis reconnect delay: 100 ms to 30000 ms
[INFO] Redis health check interval: 5000 ms
```

### Connection Loss Detected

```
[WARN] Redis health check failed - connection appears dead: Connection reset by peer
[WARN] Redis connection lost - marking disconnected
```

### Reconnection Attempts

```
[INFO] Redis reconnect attempt 1 / 10 after 0 ms backoff
[WARN] Redis reconnect failed, attempt 1
[INFO] Redis reconnect attempt 2 / 10 after 100 ms backoff
[WARN] Redis reconnect failed, attempt 2
[INFO] Redis reconnect attempt 3 / 10 after 200 ms backoff
[INFO] Redis reconnected successfully after 3 attempts
```

### Circuit Breaker

```
[WARN] Redis reconnect attempts exceeded - opening circuit breaker for 60000 ms
... (60 seconds later)
[INFO] Redis circuit breaker closed - attempting reconnect
[INFO] Redis reconnect attempt 1 / 10 after 0 ms backoff
[INFO] Redis reconnected successfully after 1 attempts
```

---

## Metrics & Monitoring

### Recommended CloudWatch Metrics

1. **Connection State Changes**
   - Metric: `redis_state_change`
   - Dimensions: `state` (CONNECTED, DISCONNECTED, CIRCUIT_OPEN)
   - Use: Track connection stability

2. **Reconnect Attempts**
   - Metric: `redis_reconnect_attempts`
   - Dimensions: `success` (true/false)
   - Use: Detect Redis instability

3. **Circuit Breaker Events**
   - Metric: `redis_circuit_breaker_opened`
   - Use: Alert on persistent failures

4. **Health Check Failures**
   - Metric: `redis_health_check_failures`
   - Use: Early warning of connection issues

### Recommended Alarms

```yaml
RedisCircuitBreakerAlarm:
  Metric: redis_circuit_breaker_opened
  Threshold: 1
  Period: 5 minutes
  Severity: HIGH
  Description: "Redis circuit breaker opened - persistent connection failures"

RedisReconnectRateAlarm:
  Metric: redis_reconnect_attempts
  Statistic: Sum
  Threshold: 100
  Period: 1 hour
  Severity: MEDIUM
  Description: "High rate of Redis reconnections - investigate stability"

RedisDisconnectedAlarm:
  Metric: redis_state_change
  Dimension: state=DISCONNECTED
  Threshold: 1
  Period: 10 minutes
  Severity: LOW
  Description: "Redis disconnected - auto-reconnect should recover"
```

---

## Testing

### Unit Tests

Test scenarios to implement:

1. **Successful Reconnection**
   - Kill Redis, restart, verify recovery
   - Expected: 1-3 reconnect attempts, then success

2. **Exponential Backoff**
   - Keep Redis down for 30 seconds
   - Verify delays: 0ms, 100ms, 200ms, 400ms, ...

3. **Circuit Breaker**
   - Keep Redis down for 60+ seconds
   - Verify circuit opens after 10 attempts
   - Verify circuit closes after 60 seconds

4. **Health Check**
   - Simulate network partition (iptables DROP)
   - Verify health check detects failure
   - Verify recovery after network restored

5. **Graceful Degradation**
   - Start with Redis down
   - Verify engine runs (without Redis features)
   - Start Redis
   - Verify auto-reconnect and recovery

### Integration Tests

```bash
# Test 1: Redis restart
ssh server "redis-cli SHUTDOWN"
# Wait 5 seconds
ssh server "sudo systemctl start redis"
# Check logs for reconnection

# Test 2: Network partition
ssh server "sudo iptables -A OUTPUT -p tcp --dport 6379 -j DROP"
# Wait 30 seconds
ssh server "sudo iptables -F"
# Check logs for reconnection

# Test 3: Redis overload
ssh server "redis-benchmark -c 1000 -n 1000000 -P 100"
# Check logs for timeouts and recovery
```

---

## Deployment Strategy

### Phase 1: Deploy with Auto-Reconnect Disabled (Default)

1. Deploy code with auto-reconnect **disabled by default**
2. Monitor for compilation issues
3. Verify no behavioral change from current system
4. **Duration: 1 week**

### Phase 2: Enable in Staging

1. Enable auto-reconnect in staging environment
2. Test failure scenarios:
   - Redis restart
   - Network partition
   - Redis overload
3. Tune parameters based on observed behavior
4. **Duration: 1 week**

### Phase 3: Enable in Production (Canary)

1. Enable on 1 instance
2. Monitor for 72 hours
3. Compare metrics vs control group
4. **Duration: 3 days**

### Phase 4: Full Rollout

1. Enable on all instances
2. Set up CloudWatch alarms
3. Monitor for 1 week
4. **Duration: 1 week**

### Phase 5: Add Metrics (Optional)

1. Implement CloudWatch custom metrics
2. Create dashboard
3. Set up advanced alarms
4. **Duration: 1 week**

---

## Troubleshooting

### Problem: Too Many Reconnect Attempts

**Symptoms**: Logs flooded with reconnect messages

**Causes**:
- Redis genuinely down for extended period
- Network misconfiguration

**Solutions**:
1. Check Redis health: `redis-cli PING`
2. Check network: `telnet redis-host 6379`
3. Increase backoff delay: `setReconnectDelay(500, 60000)`
4. Increase circuit breaker timeout: `circuit_breaker_timeout_ms_ = 300000` (5 min)

### Problem: Circuit Breaker Opens Too Quickly

**Symptoms**: Circuit opens after brief Redis restart

**Causes**:
- `max_reconnect_attempts_` too low
- Backoff delays too aggressive

**Solutions**:
1. Increase max attempts: `setMaxReconnectAttempts(20)`
2. Increase backoff: `setReconnectDelay(50, 15000)`

### Problem: Connection Not Recovering

**Symptoms**: Stays DISCONNECTED despite Redis being healthy

**Causes**:
- Auto-reconnect not enabled
- Circuit breaker stuck open

**Solutions**:
1. Verify auto-reconnect: `redis.setAutoReconnect(true)`
2. Check logs for circuit breaker messages
3. Manually call `redis.connect()` to reset state

### Problem: Health Checks Too Frequent

**Symptoms**: High CPU from PING commands

**Causes**:
- `health_check_interval_ms_` too low

**Solutions**:
1. Increase interval: `setHealthCheckInterval(10000)` (10s)
2. Disable periodic checks, rely on operation failures

---

## Performance Impact

### Before Auto-Reconnect

- No overhead (no health checks)
- Silent failures on disconnect
- Manual restart required

### After Auto-Reconnect (Enabled)

- **Health Check Overhead**: 1 PING per 5 seconds = 0.2 QPS
- **Reconnect Overhead**: Only during failures
- **Memory**: +80 bytes per RedisClient instance (timestamps, counters)
- **CPU**: Negligible (<0.1%)

### Recommendations

- Enable auto-reconnect for **all production instances**
- Keep health check interval at **5 seconds** (good balance)
- Tune backoff delays based on **observed Redis restart times**

---

## Future Enhancements

### 1. Redis Sentinel Support

Add support for Redis Sentinel for automatic failover:

```cpp
RedisClient(const std::vector<std::string>& sentinel_hosts,
            const std::string& master_name);
```

### 2. Connection Pooling

For high-throughput scenarios:

```cpp
class RedisConnectionPool {
    std::vector<std::unique_ptr<RedisClient>> pool_;
    std::mutex mutex_;
public:
    RedisClient* acquire();
    void release(RedisClient* client);
};
```

### 3. Read Replica Support

Route read operations to replicas:

```cpp
RedisClient primary(primary_host, primary_port);
RedisClient replica(replica_host, replica_port);

// Reads go to replica
auto value = replica.get("key");

// Writes go to primary
primary.set("key", "value");
```

### 4. Pipelining

Batch operations for better performance:

```cpp
class RedisPipeline {
    std::vector<redisCommand> commands_;
public:
    void addCommand(const std::string& cmd);
    std::vector<redisReply*> execute();
};
```

---

## References

- **hiredis documentation**: https://github.com/redis/hiredis
- **Redis connection handling**: https://redis.io/docs/clients/
- **Circuit breaker pattern**: https://martinfowler.com/bliki/CircuitBreaker.html
- **Exponential backoff**: https://en.wikipedia.org/wiki/Exponential_backoff

---

## Changelog

### 2026-01-17 - Initial Implementation
- Added connection state machine (CONNECTED, DISCONNECTED, CIRCUIT_OPEN)
- Implemented exponential backoff (100ms to 30s)
- Added health check with PING (every 5s)
- Added circuit breaker (10 attempts, 60s timeout)
- Updated all operations to use `ensureConnection()`
- Default: Auto-reconnect **disabled** for safety

---

*Last Updated: 2026-01-17*
*Author: Backend Architect (Agent 9)*
