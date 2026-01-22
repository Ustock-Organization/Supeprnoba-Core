# Redis Auto-Reconnection - Migration Guide

**Target Audience**: DevOps, SRE, Backend Developers
**Estimated Time**: 2-3 weeks (phased rollout)

---

## Overview

This guide covers migrating from the current single-attempt Redis connection to automatic reconnection with exponential backoff.

**Key Point**: Auto-reconnect is **disabled by default**. Existing behavior unchanged unless explicitly enabled.

---

## Pre-Migration Checklist

### 1. Code Review
- [ ] Review changes in `redis_client.h` and `redis_client.cpp`
- [ ] Understand connection state machine (CONNECTED, DISCONNECTED, CIRCUIT_OPEN)
- [ ] Review exponential backoff algorithm
- [ ] Read full documentation in `redis-reconnection.md`

### 2. Infrastructure Check
- [ ] Verify Redis/Valkey version (requires 3.0+)
- [ ] Check network latency to Redis (<10ms recommended)
- [ ] Verify Redis monitoring is in place
- [ ] Confirm log aggregation is working

### 3. Staging Environment
- [ ] Staging has same Redis setup as production
- [ ] Can test Redis restart without impacting users
- [ ] Can simulate network partition (iptables rules)
- [ ] Can monitor logs in real-time

---

## Migration Phases

### Phase 1: Deploy Code (Week 1)
**Goal**: Deploy changes with auto-reconnect disabled, verify no regressions

#### 1.1: Build and Test Locally
```bash
cd C:\develop\Supeprnoba-Core\wrapper

# Build
cmake -B build -S . -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE=~/vcpkg/scripts/buildsystems/vcpkg.cmake
cmake --build build -j$(nproc)

# Run unit tests (if available)
./build/tests/redis_client_test

# Verify binary
ls -lh build/matching_engine
```

#### 1.2: Deploy to Staging (Auto-Reconnect DISABLED)
```bash
# SSH to staging
ssh server

# Backup current binary
cd ~/Supeprnoba-Core/wrapper
cp build/matching_engine build/matching_engine.backup.$(date +%Y%m%d)

# Pull latest code
git pull origin develop

# Rebuild
cmake --build build -j$(nproc)

# Verify auto-reconnect is disabled by default
grep "auto_reconnect_enabled_ = false" src/redis_client.cpp

# Restart engine
pkill -f matching_engine
nohup ./run_engine.sh > ~/engine.log 2>&1 &

# Monitor logs
tail -f ~/engine.log | grep -i redis
```

#### 1.3: Verify No Behavioral Change
```bash
# Check Redis connection
redis-cli PING

# Monitor logs for 24 hours
tail -f ~/engine.log | grep -E "(ERROR|WARN|Redis)"

# Verify candles are updating
redis-cli HGETALL "candle:1m:AAPL"

# Verify depth is caching
redis-cli GET "depth:AAPL"

# Check for errors
grep -i "error" ~/engine.log | tail -20
```

#### 1.4: Rollback Plan
If issues arise:
```bash
# Stop engine
pkill -f matching_engine

# Restore backup
cp build/matching_engine.backup.YYYYMMDD build/matching_engine

# Restart
nohup ./run_engine.sh > ~/engine.log 2>&1 &
```

#### Success Criteria
- [ ] Engine starts without errors
- [ ] Redis operations work as before
- [ ] No new warnings in logs
- [ ] Candles update normally
- [ ] Depth cache works
- [ ] No performance degradation

---

### Phase 2: Enable in Staging (Week 2)
**Goal**: Test auto-reconnect in staging, validate failure scenarios

#### 2.1: Configure Auto-Reconnect

Edit `run_engine.sh`:
```bash
# Add to run_engine.sh
export REDIS_AUTO_RECONNECT=true
export REDIS_MAX_RECONNECT_ATTEMPTS=10
export REDIS_RECONNECT_DELAY_MS=100
export REDIS_MAX_RECONNECT_DELAY_MS=30000
export REDIS_HEALTH_CHECK_INTERVAL_MS=5000

# Or modify code in main.cpp
redis.setAutoReconnect(true);
redis.setMaxReconnectAttempts(10);
redis.setReconnectDelay(100, 30000);
redis.setHealthCheckInterval(5000);
```

Restart engine:
```bash
pkill -f matching_engine
nohup ./run_engine.sh > ~/engine.log 2>&1 &

# Verify auto-reconnect enabled
tail -f ~/engine.log | grep "auto-reconnect"
# Should see: "Redis auto-reconnect: enabled"
```

#### 2.2: Test Scenario 1 - Redis Restart

**Test**: Kill Redis, verify reconnection
```bash
# Monitor logs in separate terminal
tail -f ~/engine.log | grep -i redis

# Kill Redis
redis-cli SHUTDOWN

# Expected log output:
# [WARN] Redis health check failed - connection appears dead
# [WARN] Redis connection lost - marking disconnected
# [INFO] Redis reconnect attempt 1 / 10 after 0 ms backoff
# [WARN] Redis reconnect failed, attempt 1
# [INFO] Redis reconnect attempt 2 / 10 after 100 ms backoff
# ...

# Start Redis (in another terminal)
sudo systemctl start redis

# Expected log output:
# [INFO] Redis reconnect attempt N / 10 after XXX ms backoff
# [INFO] Redis reconnected successfully after N attempts

# Verify reconnection time
# Should reconnect within 5-10 seconds
```

**Verification**:
```bash
# Check Redis is connected
redis-cli PING

# Verify candles resumed
redis-cli HGETALL "candle:1m:AAPL"

# Check depth cache
redis-cli GET "depth:AAPL"

# Verify no data corruption
# Compare pre-shutdown and post-reconnect data
```

#### 2.3: Test Scenario 2 - Network Partition

**Test**: Simulate network failure, verify recovery
```bash
# Monitor logs
tail -f ~/engine.log | grep -i redis

# Block Redis traffic (requires sudo)
sudo iptables -A OUTPUT -p tcp --dport 6379 -j DROP

# Expected log output:
# [WARN] Redis SET failed: Connection timed out
# [WARN] Redis connection lost - marking disconnected
# [INFO] Redis reconnect attempt 1 / 10 after 0 ms backoff
# [WARN] Redis reconnect failed, attempt 1
# ...

# Wait 30 seconds (observe exponential backoff)

# Restore network
sudo iptables -F

# Expected log output:
# [INFO] Redis reconnect attempt N / 10 after XXX ms backoff
# [INFO] Redis reconnected successfully after N attempts

# Should reconnect within 5 seconds of network restoration
```

#### 2.4: Test Scenario 3 - Circuit Breaker

**Test**: Keep Redis down for extended period
```bash
# Monitor logs
tail -f ~/engine.log | grep -i redis

# Keep Redis down
redis-cli SHUTDOWN

# Wait 60 seconds - observe reconnect attempts

# Expected log output:
# [INFO] Redis reconnect attempt 1 / 10 after 0 ms backoff
# [WARN] Redis reconnect failed, attempt 1
# [INFO] Redis reconnect attempt 2 / 10 after 100 ms backoff
# [WARN] Redis reconnect failed, attempt 2
# ...
# [INFO] Redis reconnect attempt 10 / 10 after 25600 ms backoff
# [WARN] Redis reconnect failed, attempt 10
# [WARN] Redis reconnect attempts exceeded - opening circuit breaker for 60000 ms

# Wait 60 seconds

# Expected log output:
# [INFO] Redis circuit breaker closed - attempting reconnect
# [INFO] Redis reconnect attempt 1 / 10 after 0 ms backoff
# [WARN] Redis reconnect failed, attempt 1
# ...

# Start Redis
sudo systemctl start redis

# Should reconnect immediately
```

#### 2.5: Test Scenario 4 - Graceful Degradation

**Test**: Start engine with Redis down
```bash
# Stop Redis
redis-cli SHUTDOWN

# Start engine
pkill -f matching_engine
nohup ./run_engine.sh > ~/engine.log 2>&1 &

# Expected log output:
# [ERROR] Redis connection failed: Connection refused
# [WARN] Initial Redis connection failed - will auto-reconnect when available
# [INFO] Redis (snapshot) connection failed - continuing without cache
# ... (engine continues starting)

# Verify engine is running
ps aux | grep matching_engine

# Verify orders work (Redis not required for core functionality)
# Send test order via API
curl -X POST http://localhost:8080/order -d '{"symbol":"AAPL","side":"BUY","price":150,"qty":10}'

# Start Redis
sudo systemctl start redis

# Expected log output (within 5-10 seconds):
# [INFO] Redis reconnect attempt 1 / 10 after 0 ms backoff
# [INFO] Redis reconnected successfully after 1 attempts

# Verify Redis features restored
redis-cli HGETALL "candle:1m:AAPL"
```

#### Success Criteria
- [ ] Reconnects after Redis restart (<10s)
- [ ] Recovers from network partition (<5s after restore)
- [ ] Circuit breaker opens after 10 failures
- [ ] Circuit breaker closes after 60s timeout
- [ ] Engine starts with Redis down, reconnects when available
- [ ] No data corruption during reconnects
- [ ] Candles resume after reconnection
- [ ] Depth cache resumes after reconnection

---

### Phase 3: Canary in Production (Week 2-3)
**Goal**: Validate in production with minimal risk

#### 3.1: Enable on Single Instance
```bash
# SSH to ONE production instance
ssh server

# Backup current config
cp run_engine.sh run_engine.sh.backup

# Enable auto-reconnect
vim run_engine.sh
# Add: export REDIS_AUTO_RECONNECT=true

# Restart engine
pkill -f matching_engine
nohup ./run_engine.sh > ~/engine.log 2>&1 &

# Verify enabled
tail -f ~/engine.log | grep "auto-reconnect"
```

#### 3.2: Monitor for 72 Hours
```bash
# Check logs every 6 hours
ssh server "tail -100 ~/engine.log | grep -i redis"

# Monitor reconnection events
ssh server "grep -c 'reconnect attempt' ~/engine.log"

# Check for circuit breaker events
ssh server "grep 'circuit breaker' ~/engine.log"

# Compare metrics with control group
# - Latency (p50, p95, p99)
# - Error rate
# - Throughput
# - Redis operations per second
```

#### 3.3: Metrics to Compare

| Metric | Canary Instance | Control Group | Acceptable Variance |
|--------|-----------------|---------------|---------------------|
| Order latency (p50) | | | <5% |
| Order latency (p95) | | | <10% |
| Error rate | | | <1% |
| Redis ops/sec | | | ±0.2 QPS |
| CPU usage | | | <2% |
| Memory usage | | | <1% |

#### Success Criteria
- [ ] No increase in error rate
- [ ] Latency within acceptable variance
- [ ] CPU/memory usage stable
- [ ] No crashes or hangs
- [ ] Reconnection works as expected (if Redis issue occurs)

---

### Phase 4: Full Production Rollout (Week 3)
**Goal**: Enable auto-reconnect on all instances

#### 4.1: Gradual Rollout
```bash
# Day 1: Enable on 25% of instances
# Day 2: Enable on 50% of instances
# Day 3: Enable on 75% of instances
# Day 4: Enable on 100% of instances

# For each batch:
for instance in server1 server2 server3; do
  ssh $instance "cd ~/Supeprnoba-Core/wrapper && \
    echo 'export REDIS_AUTO_RECONNECT=true' >> run_engine.sh && \
    pkill -f matching_engine && \
    nohup ./run_engine.sh > ~/engine.log 2>&1 &"
done

# Wait 1 hour between batches
sleep 3600
```

#### 4.2: Configure CloudWatch Alarms (Optional)

Create alarms for:
```yaml
RedisCircuitBreakerAlarm:
  Metric: redis_circuit_breaker_opened
  Threshold: 1
  Period: 5 minutes
  Action: Page on-call

RedisReconnectRateAlarm:
  Metric: redis_reconnect_attempts
  Threshold: 100/hour
  Period: 1 hour
  Action: Notify ops team

RedisDisconnectedAlarm:
  Metric: redis_state_change
  Dimension: state=DISCONNECTED
  Threshold: 1
  Period: 10 minutes
  Action: Log to Slack
```

#### 4.3: Final Verification
```bash
# Verify all instances have auto-reconnect enabled
for instance in server1 server2 server3 server4; do
  ssh $instance "grep 'auto-reconnect: enabled' ~/engine.log | tail -1"
done

# Check for any reconnection events
for instance in server1 server2 server3 server4; do
  echo "=== $instance ==="
  ssh $instance "grep -c 'reconnect attempt' ~/engine.log"
done

# Monitor for 1 week
# Check logs daily for any issues
```

#### Success Criteria
- [ ] All instances have auto-reconnect enabled
- [ ] No increase in errors or latency
- [ ] CloudWatch alarms configured
- [ ] Team trained on new behavior
- [ ] Documentation updated

---

## Post-Migration Monitoring

### Week 1 After Migration
- [ ] Daily log review for reconnection events
- [ ] Check CloudWatch metrics for anomalies
- [ ] Verify no user complaints about stale data
- [ ] Review candle data continuity

### Month 1 After Migration
- [ ] Weekly review of reconnection frequency
- [ ] Tune backoff parameters if needed
- [ ] Document any Redis outages and recovery times
- [ ] Update runbooks

---

## Rollback Procedure

If issues arise at any phase:

### Emergency Rollback (Immediate)
```bash
# Disable auto-reconnect
ssh server "export REDIS_AUTO_RECONNECT=false && \
  pkill -f matching_engine && \
  nohup ./run_engine.sh > ~/engine.log 2>&1 &"
```

### Full Rollback (Within 1 Hour)
```bash
# Restore backup binary
ssh server "cd ~/Supeprnoba-Core/wrapper && \
  cp build/matching_engine.backup.YYYYMMDD build/matching_engine && \
  pkill -f matching_engine && \
  nohup ./run_engine.sh > ~/engine.log 2>&1 &"
```

### Code Rollback (Within 4 Hours)
```bash
# Revert Git commit
git revert <commit-hash>
git push origin develop

# Redeploy via CI/CD or manual
```

---

## Troubleshooting

### Issue: High Reconnection Rate
**Symptoms**: Logs show frequent reconnect attempts

**Diagnosis**:
```bash
# Check Redis health
redis-cli PING
redis-cli INFO stats

# Check network latency
ping -c 10 <redis-host>

# Check for network issues
traceroute <redis-host>

# Check Redis logs
sudo tail -f /var/log/redis/redis.log
```

**Solutions**:
1. Investigate Redis health (CPU, memory, connections)
2. Check for network instability
3. Increase health check interval: `setHealthCheckInterval(10000)` (10s)
4. Increase backoff delays: `setReconnectDelay(500, 60000)` (500ms to 60s)

### Issue: Circuit Breaker Opens Frequently
**Symptoms**: Logs show "circuit breaker opened" multiple times per day

**Diagnosis**:
```bash
# Count circuit breaker events
grep -c "circuit breaker opened" ~/engine.log

# Check Redis uptime
redis-cli INFO server | grep uptime_in_seconds

# Check for Redis restarts
sudo journalctl -u redis | grep -i restart
```

**Solutions**:
1. Investigate Redis stability (OOM, crashes, maintenance windows)
2. Increase max reconnect attempts: `setMaxReconnectAttempts(20)`
3. Increase circuit breaker timeout: `circuit_breaker_timeout_ms_ = 300000` (5 min)

### Issue: Connection Not Recovering
**Symptoms**: Stays DISCONNECTED despite Redis being healthy

**Diagnosis**:
```bash
# Check Redis is accessible
redis-cli -h <redis-host> -p 6379 PING

# Check engine logs
grep "reconnect attempt" ~/engine.log | tail -20

# Check for circuit breaker state
grep "circuit breaker" ~/engine.log | tail -10
```

**Solutions**:
1. Verify auto-reconnect is enabled: `grep "auto-reconnect: enabled" ~/engine.log`
2. Check if circuit breaker is stuck open
3. Manually restart engine to reset state
4. Verify network connectivity from engine to Redis

---

## Configuration Tuning

### Conservative (Default)
**Use case**: Stable Redis, rare outages
```cpp
redis.setMaxReconnectAttempts(10);
redis.setReconnectDelay(100, 30000);  // 100ms to 30s
redis.setHealthCheckInterval(5000);   // 5s
```

### Aggressive
**Use case**: Unstable Redis, frequent brief outages
```cpp
redis.setMaxReconnectAttempts(20);
redis.setReconnectDelay(50, 15000);   // 50ms to 15s
redis.setHealthCheckInterval(3000);   // 3s
```

### Relaxed
**Use case**: Stable Redis, long maintenance windows acceptable
```cpp
redis.setMaxReconnectAttempts(5);
redis.setReconnectDelay(500, 60000);  // 500ms to 60s
redis.setHealthCheckInterval(10000);  // 10s
```

---

## Training Materials

### For Operations Team
- [ ] Review `redis-reconnection.md` (full documentation)
- [ ] Run through test scenarios in staging
- [ ] Practice troubleshooting procedures
- [ ] Understand rollback procedures

### For Development Team
- [ ] Review `redis-reconnection-quickstart.md`
- [ ] Understand API changes (none for basic usage)
- [ ] Know how to configure auto-reconnect
- [ ] Understand log messages

### For SRE Team
- [ ] Set up CloudWatch alarms
- [ ] Create runbooks for common issues
- [ ] Prepare dashboards for monitoring
- [ ] Define escalation procedures

---

## Success Metrics

### Technical Metrics
- Redis connection uptime: >99.9%
- Mean time to recovery (MTTR) from Redis outage: <10 seconds
- Circuit breaker events: <1 per week
- Reconnection success rate: >95%

### Business Metrics
- User complaints about stale data: 0
- Incidents requiring manual intervention: 0
- Downtime due to Redis failures: 0

---

## Timeline Summary

| Week | Phase | Activities | Risk |
|------|-------|------------|------|
| 1 | Deploy Code | Build, deploy to staging (disabled), verify | LOW |
| 2 | Enable Staging | Test failure scenarios, tune parameters | LOW |
| 2-3 | Canary | Enable on 1 production instance, monitor 72h | MEDIUM |
| 3 | Full Rollout | Gradual rollout to all instances | MEDIUM |
| 4+ | Monitor | Long-term monitoring, tune as needed | LOW |

**Total Duration**: 3-4 weeks
**Effort**: ~20-30 hours (development + testing + rollout)

---

## Approval Checklist

Before starting migration:
- [ ] Code review approved by 2+ developers
- [ ] Testing plan reviewed by QA
- [ ] Deployment plan approved by operations
- [ ] Rollback plan documented and understood
- [ ] Stakeholders notified of migration schedule
- [ ] Maintenance window scheduled (if needed)

---

## Contact

**Questions or Issues**:
- Technical: Backend team (#backend-dev Slack)
- Operations: SRE team (#sre Slack)
- Urgent: Page on-call engineer

**Documentation**:
- Full Guide: `C:\develop\Supeprnoba-Core\wrapper\docs\redis-reconnection.md`
- Quick Start: `C:\develop\Supeprnoba-Core\wrapper\docs\redis-reconnection-quickstart.md`
- Analysis: `C:\develop\Supeprnoba-Core\wrapper\docs\agent-9-redis-analysis-summary.md`

---

**Migration Guide Complete**
*Good luck with the rollout!*
