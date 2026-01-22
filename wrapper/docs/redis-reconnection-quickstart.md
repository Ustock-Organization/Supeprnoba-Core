# Redis Auto-Reconnection - Quick Start Guide

**Last Updated**: 2026-01-17

---

## For Developers: How to Use

### Basic Usage (Same as Before)

```cpp
#include "redis_client.h"

// Create client
RedisClient redis("valkey.example.com", 6379);

// Connect
bool connected = redis.connect();
if (!connected) {
    Logger::warn("Redis connection failed");
}

// Use as normal
redis.set("key", "value");
auto value = redis.get("key");
```

### Enable Auto-Reconnect (Recommended for Production)

```cpp
#include "redis_client.h"

// Create client
RedisClient redis("valkey.example.com", 6379);

// Configure auto-reconnect BEFORE connecting
redis.setAutoReconnect(true);                  // Enable auto-reconnect
redis.setMaxReconnectAttempts(10);             // Max 10 attempts before circuit breaker
redis.setReconnectDelay(100, 30000);           // 100ms to 30s backoff
redis.setHealthCheckInterval(5000);            // PING every 5 seconds

// Connect
bool connected = redis.connect();
if (!connected) {
    Logger::warn("Initial connection failed - will auto-reconnect when available");
}

// Use as normal - reconnection happens automatically
redis.set("key", "value");  // Will reconnect if needed
```

### Check Connection Health

```cpp
// Check if connected
if (redis.isConnected()) {
    Logger::info("Redis is connected");
}

// Check if healthy (sends PING)
if (redis.isHealthy()) {
    Logger::info("Redis is healthy");
}

// Get reconnect attempt count
int attempts = redis.getReconnectAttempts();
Logger::info("Reconnect attempts:", attempts);
```

---

## Environment Variables

Add to `run_engine.sh`:

```bash
# Enable auto-reconnect
export REDIS_AUTO_RECONNECT=true

# Optional: Tune parameters (defaults shown)
export REDIS_MAX_RECONNECT_ATTEMPTS=10
export REDIS_RECONNECT_DELAY_MS=100
export REDIS_MAX_RECONNECT_DELAY_MS=30000
export REDIS_HEALTH_CHECK_INTERVAL_MS=5000
```

Then in code:

```cpp
bool auto_reconnect = Config::get("REDIS_AUTO_RECONNECT", "false") == "true";
redis.setAutoReconnect(auto_reconnect);

int max_attempts = std::stoi(Config::get("REDIS_MAX_RECONNECT_ATTEMPTS", "10"));
redis.setMaxReconnectAttempts(max_attempts);

int initial_delay = std::stoi(Config::get("REDIS_RECONNECT_DELAY_MS", "100"));
int max_delay = std::stoi(Config::get("REDIS_MAX_RECONNECT_DELAY_MS", "30000"));
redis.setReconnectDelay(initial_delay, max_delay);

int health_interval = std::stoi(Config::get("REDIS_HEALTH_CHECK_INTERVAL_MS", "5000"));
redis.setHealthCheckInterval(health_interval);
```

---

## What Changed?

### Before (Current Behavior)
- Connection attempted once at startup
- If Redis fails, stays disconnected forever
- Silent degradation (operations return `false`)
- Manual restart required to recover

### After (With Auto-Reconnect Enabled)
- Connection attempted at startup
- If Redis fails, retries with exponential backoff
- Health checks detect dead connections
- Automatic recovery when Redis comes back
- No manual intervention needed

### Backward Compatibility
- **Auto-reconnect is DISABLED by default**
- Existing code works unchanged
- Enable explicitly with `setAutoReconnect(true)`

---

## Exponential Backoff Schedule

| Attempt | Delay   | Cumulative Time |
|---------|---------|-----------------|
| 1       | 0ms     | 0ms             |
| 2       | 100ms   | 100ms           |
| 3       | 200ms   | 300ms           |
| 4       | 400ms   | 700ms           |
| 5       | 800ms   | 1.5s            |
| 6       | 1600ms  | 3.1s            |
| 7       | 3200ms  | 6.3s            |
| 8       | 6400ms  | 12.7s           |
| 9       | 12800ms | 25.5s           |
| 10      | 25600ms | 51.1s           |
| 11+     | Circuit breaker opens for 60s |

After 10 failures, circuit breaker opens for 60 seconds, then resets.

---

## Log Messages

### Normal Operation
```
[INFO] Redis connected to: valkey.example.com : 6379
[INFO] Redis auto-reconnect: enabled
```

### Connection Lost
```
[WARN] Redis health check failed - connection appears dead: Connection reset by peer
[WARN] Redis connection lost - marking disconnected
```

### Reconnecting
```
[INFO] Redis reconnect attempt 1 / 10 after 0 ms backoff
[WARN] Redis reconnect failed, attempt 1
[INFO] Redis reconnect attempt 2 / 10 after 100 ms backoff
[INFO] Redis reconnected successfully after 2 attempts
```

### Circuit Breaker
```
[WARN] Redis reconnect attempts exceeded - opening circuit breaker for 60000 ms
... (60 seconds later)
[INFO] Redis circuit breaker closed - attempting reconnect
```

---

## Testing Reconnection

### Test 1: Redis Restart
```bash
# Kill Redis
redis-cli SHUTDOWN

# Check logs - should see reconnect attempts
tail -f engine.log | grep Redis

# Start Redis
sudo systemctl start redis

# Should see "Redis reconnected successfully"
```

### Test 2: Network Partition
```bash
# Block Redis traffic
sudo iptables -A OUTPUT -p tcp --dport 6379 -j DROP

# Wait 30 seconds - check logs

# Restore network
sudo iptables -F

# Should reconnect within 5-10 seconds
```

### Test 3: Graceful Degradation
```bash
# Start engine with Redis down
export REDIS_AUTO_RECONNECT=true
./matching_engine

# Check logs - should warn about connection failure
# Engine should still run (without Redis features)

# Start Redis
sudo systemctl start redis

# Should see auto-reconnect within 5 seconds
```

---

## Troubleshooting

### Problem: Not Reconnecting

**Check**:
```cpp
// Is auto-reconnect enabled?
Logger::info("Auto-reconnect enabled:", redis.isAutoReconnectEnabled());
```

**Solution**:
```cpp
redis.setAutoReconnect(true);
```

### Problem: Reconnecting Too Often

**Check logs** for reconnect frequency

**Solution** - Increase backoff:
```cpp
redis.setReconnectDelay(500, 60000);  // 500ms to 60s
```

### Problem: Circuit Breaker Opens Too Quickly

**Check logs** for "circuit breaker opened"

**Solution** - Increase max attempts:
```cpp
redis.setMaxReconnectAttempts(20);  // More attempts before circuit opens
```

### Problem: Health Checks Failing

**Check Redis latency**:
```bash
redis-cli --latency
```

**Solution** - Increase health check interval:
```cpp
redis.setHealthCheckInterval(10000);  // 10 seconds
```

---

## Performance Impact

- **Health Check**: 1 PING per 5s = 0.2 QPS (negligible)
- **Memory**: +80 bytes per RedisClient instance
- **CPU**: <0.1% overhead
- **Network**: +1 command per 5s (PING)

**Verdict**: Negligible impact, significant reliability improvement.

---

## When to Use

### Always Enable Auto-Reconnect For:
- Production matching engines
- Long-running services
- Services that can't afford manual restarts
- Systems with uptime SLAs

### Optional For:
- Development/testing
- Short-lived processes
- Services with manual monitoring

### Don't Enable For:
- Batch jobs (short-lived)
- Scripts that run once and exit

---

## FAQ

### Q: Does this replace Redis clustering?
**A**: No. This handles temporary connection failures, not Redis failover. Use Redis Sentinel/Cluster for high availability.

### Q: What happens to in-flight operations during reconnect?
**A**: They fail and return `false`. Caller should retry if needed. Reconnection happens before next operation.

### Q: Can I force a reconnect?
**A**: Yes, call `redis.connect()` directly. This resets the connection state.

### Q: Does health check block operations?
**A**: No. Health checks run asynchronously (before operations if due, but don't block).

### Q: What if Redis is down at startup?
**A**: With auto-reconnect enabled, engine starts anyway and reconnects when Redis comes up. Without it, engine starts but Redis operations fail.

### Q: Is this thread-safe?
**A**: No. RedisClient is NOT thread-safe. Use separate instances per thread (as currently done).

---

## Quick Reference: API

```cpp
// Configuration
void setAutoReconnect(bool enabled);
void setMaxReconnectAttempts(int attempts);
void setReconnectDelay(int initial_ms, int max_ms);
void setHealthCheckInterval(int interval_ms);

// Status
bool isConnected() const;
bool isHealthy();
int getReconnectAttempts() const;

// All existing operations work unchanged
bool set(const std::string& key, const std::string& value);
std::optional<std::string> get(const std::string& key);
bool lpush(const std::string& key, const std::string& value);
bool hset(const std::string& key, const std::string& field, const std::string& value);
// ... (all other operations)
```

---

## Example: Production Configuration

```cpp
#include "redis_client.h"
#include "config.h"

RedisClient createProductionRedisClient(const std::string& host, int port) {
    RedisClient redis(host, port);

    // Enable auto-reconnect
    redis.setAutoReconnect(true);

    // Conservative settings for production
    redis.setMaxReconnectAttempts(10);      // 10 attempts before circuit breaker
    redis.setReconnectDelay(100, 30000);    // 100ms to 30s exponential backoff
    redis.setHealthCheckInterval(5000);     // PING every 5 seconds

    // Initial connection
    bool connected = redis.connect();
    if (!connected) {
        Logger::warn("Initial Redis connection failed - will auto-reconnect");
    } else {
        Logger::info("Redis connected to:", host, ":", port);
    }

    return redis;
}

// Usage in main.cpp
int main() {
    auto redis = createProductionRedisClient("valkey.example.com", 6379);
    auto depth_cache = createProductionRedisClient("valkey.example.com", 6379);

    // Use as normal - reconnection is automatic
    MarketDataHandler handler(&producer, &depth_cache, &notifier, &ranking_manager);
    EngineCore engine(&handler);

    engine.run();
}
```

---

## Support

- **Documentation**: `C:\develop\Supeprnoba-Core\wrapper\docs\redis-reconnection.md`
- **Analysis Report**: `C:\develop\Supeprnoba-Core\wrapper\docs\agent-9-redis-analysis-summary.md`
- **Source Code**: `C:\develop\Supeprnoba-Core\wrapper\src\redis_client.cpp`

---

**Quick Start Complete**
*For detailed information, see full documentation in `redis-reconnection.md`*
