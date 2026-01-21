# Agent 14: Redis Failover - 운영 Quick Reference

**대상:** 운영팀, DevOps 엔지니어
**목적:** 장애 대응 빠른 참조
**업데이트:** 2026-01-17

---

## 긴급 대응 플로우차트

```
Redis 장애 감지
    │
    ├─→ 자동 재연결 시도 중?
    │   ├─ Yes → 2-5분 대기 → 복구 확인
    │   └─ No  → 수동 엔진 재시작
    │
    ├─→ Circuit Breaker Open?
    │   ├─ Yes → 60초 대기 → 네트워크 확인
    │   └─ No  → ElastiCache 상태 확인
    │
    └─→ 복구 실패?
        └─ Yes → Escalate (Senior Engineer)
```

---

## 1분 체크리스트

### 장애 감지 시

```bash
# 1. 로그 확인 (최근 50줄)
ssh server "tail -50 ~/engine.log | grep -E 'Redis|ERROR|WARN'"

# 2. 프로세스 확인
ssh server "ps aux | grep matching_engine"

# 3. Redis 연결 테스트
redis-cli -h master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com PING

# 4. ElastiCache 상태
aws elasticache describe-cache-clusters \
  --cache-cluster-id supernoba-orderbook-backup-001 \
  --query 'CacheClusters[0].CacheClusterStatus'
```

**정상 출력:**
```
# 로그: [INFO] Redis connected
# 프로세스: matching_engine (running)
# PING: PONG
# ElastiCache: available
```

**비정상 출력:**
```
# 로그: [ERROR] Redis connection failed
# 프로세스: (no matching_engine)
# PING: Connection refused
# ElastiCache: rebooting
```

---

## 자주 보는 로그 패턴

### 정상 패턴

```
[INFO] Redis connected to: master.xxx.com : 6379
[INFO] Redis (snapshot) connected with auto-reconnect enabled
[INFO] Background health check enabled for: master.xxx.com
[INFO] === Matching Engine Metrics ===
[INFO] Orders received: 1234
```

### 일시적 장애 (자동 복구 중)

```
[WARN] Redis health check failed - connection appears dead: Connection refused
[WARN] Redis connection lost - marking disconnected
[INFO] Redis reconnect attempt 1 / 10 after 0 ms backoff
[WARN] Redis reconnect failed, attempt 1
[INFO] Redis reconnect attempt 2 / 10 after 100 ms backoff
[INFO] Redis reconnected successfully after 3 attempts
[INFO] Background reconnect restored connection for: master.xxx.com
```

**조치:** 관찰만 (자동 복구 대기)

### Circuit Breaker 열림 (심각)

```
[WARN] Redis reconnect attempts exceeded - opening circuit breaker for 60000 ms
```

**조치:** 네트워크 또는 ElastiCache 상태 확인

### 완전 장애 (긴급)

```
[ERROR] Redis connection failed: can't allocate context
[WARN] Redis (snapshot) connection failed - continuing without cache
[INFO] Loading ACCEPTED orders from DynamoDB...
```

**조치:** ElastiCache 재시작 또는 엔진 재시작

---

## 자주 쓰는 명령어

### 엔진 상태 확인

```bash
# 프로세스 확인
ssh server "ps aux | grep matching_engine"

# 최근 로그 (100줄)
ssh server "tail -100 ~/engine.log"

# 실시간 로그 모니터링
ssh server "tail -f ~/engine.log | grep -E 'Redis|ERROR|WARN'"

# Redis 관련 로그만
ssh server "grep Redis ~/engine.log | tail -50"
```

### 엔진 재시작

```bash
# 안전한 재시작 (정상 종료)
ssh server "pkill -SIGTERM matching_engine && \
            cd ~/Supeprnoba-Core/wrapper && \
            nohup ./run_engine.sh > ~/engine.log 2>&1 &"

# 강제 재시작 (응답 없을 때)
ssh server "pkill -9 matching_engine && \
            cd ~/Supeprnoba-Core/wrapper && \
            nohup ./run_engine.sh > ~/engine.log 2>&1 &"

# DEV 모드 재시작 (캐시 초기화)
ssh server "pkill -f matching_engine && \
            cd ~/Supeprnoba-Core/wrapper && \
            nohup ./run_engine.sh --dev > ~/engine.log 2>&1 &"
```

### Redis 상태 확인

```bash
# PING 테스트
redis-cli -h master.xxx.com PING

# 연결 수 확인
redis-cli -h master.xxx.com INFO clients | grep connected_clients

# 메모리 사용량
redis-cli -h master.xxx.com INFO memory | grep used_memory_human

# 스냅샷 키 확인
redis-cli -h master.xxx.com KEYS "snapshot:*"

# 특정 스냅샷 조회
redis-cli -h master.xxx.com GET "snapshot:AAPL"
```

### ElastiCache 관리

```bash
# 클러스터 상태 확인
aws elasticache describe-cache-clusters \
  --cache-cluster-id supernoba-orderbook-backup-001 \
  --show-cache-node-info \
  --region ap-northeast-2

# 최근 이벤트 (1시간)
aws elasticache describe-events \
  --source-type cache-cluster \
  --source-identifier supernoba-orderbook-backup-001 \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ) \
  --region ap-northeast-2

# 노드 재시작
aws elasticache reboot-cache-cluster \
  --cache-cluster-id supernoba-orderbook-backup-001 \
  --cache-node-ids-to-reboot 0001 \
  --region ap-northeast-2
```

---

## 장애 시나리오별 대응

### Scenario 1: "Redis connection failed" 로그 반복

**증상:**
```
[ERROR] Redis SET failed: Connection refused
[WARN] Redis reconnect failed, attempt 5
```

**원인 진단:**
```bash
# 1. ElastiCache 상태
aws elasticache describe-cache-clusters \
  --cache-cluster-id supernoba-orderbook-backup-001

# 2. 보안 그룹 확인
aws ec2 describe-security-groups --group-ids sg-xxxxx

# 3. 네트워크 연결
ssh server "telnet master.xxx.com 6379"
```

**조치:**
- ElastiCache 상태가 "rebooting" → 대기 (2-3분)
- 보안 그룹 차단 → 규칙 추가
- 네트워크 불통 → VPC 라우팅 확인

### Scenario 2: "Circuit breaker opened"

**증상:**
```
[WARN] Redis reconnect attempts exceeded - opening circuit breaker for 60000 ms
```

**조치:**
1. **60초 대기** (자동 재시도)
2. 네트워크 확인
   ```bash
   ssh server "ping -c 5 master.xxx.com"
   ```
3. 즉시 복구 필요 시 엔진 재시작
   ```bash
   ssh server "pkill -f matching_engine && \
               cd ~/Supeprnoba-Core/wrapper && \
               ./run_engine.sh"
   ```

### Scenario 3: 엔진 시작 실패

**증상:**
```
[ERROR] Redis connection failed: can't allocate context
[INFO] Loading ACCEPTED orders from DynamoDB...
(엔진이 시작은 되지만 Redis 없음)
```

**조치:**
1. **그대로 실행** (DynamoDB로 동작)
2. Redis 복구 후 재시작
   ```bash
   # Redis 복구 확인
   redis-cli -h master.xxx.com PING

   # 엔진 재시작 (스냅샷 로드)
   ssh server "pkill -f matching_engine && \
               cd ~/Supeprnoba-Core/wrapper && \
               ./run_engine.sh"
   ```

### Scenario 4: 성능 저하 (느린 응답)

**증상:**
- 주문 처리 5초 이상
- 로그에 "Redis" 관련 지연 없음

**진단:**
```bash
# Redis Slow Log
redis-cli -h master.xxx.com SLOWLOG GET 10

# ElastiCache CPU
aws cloudwatch get-metric-statistics \
  --namespace AWS/ElastiCache \
  --metric-name CPUUtilization \
  --dimensions Name=CacheClusterId,Value=supernoba-orderbook-backup-001 \
  --start-time $(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 60 \
  --statistics Average
```

**조치:**
- Slow Log에 KEYS 명령 → 코드 수정 (SCAN 사용)
- CPU > 80% → ElastiCache 인스턴스 업그레이드

---

## 메트릭 해석

### 정상 범위

| 메트릭 | 정상 범위 | 단위 |
|--------|-----------|------|
| Total commands | 10-1000 | /30s |
| Failed commands | 0-1 | /30s |
| Reconnects | 0 | /30min |
| Health check failures | 0-1 | /30s |
| Current state | CONNECTED | - |
| Uptime | > 3600s | seconds |
| Total downtime | < 60s | seconds/hour |

### 경고 임계값

| 메트릭 | 경고 | 조치 |
|--------|------|------|
| Failed commands | > 1% | 로그 확인 |
| Reconnects | > 3 | ElastiCache 확인 |
| Health check failures | > 10 | 네트워크 확인 |
| Current state | CIRCUIT_OPEN | 즉시 조사 |
| Total downtime | > 300s | 긴급 대응 |

### 예시 출력 (정상)

```
[INFO] === Redis (Snapshot) Metrics ===
[INFO] Total commands: 150
[INFO] Failed commands: 0
[INFO] Reconnects: 0
[INFO] Health check failures: 0
[INFO] Current state: CONNECTED
[INFO] Uptime: 86400000 ms (24시간)
[INFO] Total downtime: 0 ms
```

### 예시 출력 (비정상)

```
[INFO] === Redis (Snapshot) Metrics ===
[INFO] Total commands: 150
[INFO] Failed commands: 45           ← 30% 실패!
[INFO] Reconnects: 12                ← 12회 재연결!
[INFO] Health check failures: 50     ← 헬스 체크 실패 과다
[INFO] Current state: CIRCUIT_OPEN   ← Circuit 열림!
[INFO] Uptime: 86400000 ms
[INFO] Total downtime: 3600000 ms    ← 1시간 다운타임!
```

**조치:** 즉시 ElastiCache 상태 확인 및 Senior Engineer 연락

---

## Escalation 기준

### Level 1: 운영팀 대응 (자동 복구 대기)

**조건:**
- ✅ Reconnect 시도 중 (< 5회)
- ✅ Circuit Breaker 닫힘
- ✅ Failed commands < 1%

**대응:** 5분간 관찰

### Level 2: 운영팀 대응 (수동 개입)

**조건:**
- ⚠️ Reconnect 실패 (> 5회)
- ⚠️ Circuit Breaker 열림
- ⚠️ Failed commands > 5%

**대응:**
1. 엔진 재시작
2. ElastiCache 상태 확인
3. 30분 모니터링

### Level 3: Senior Engineer Escalation

**조건:**
- 🚨 엔진 재시작 실패
- 🚨 ElastiCache 장기 장애 (> 10분)
- 🚨 데이터 손실 의심

**대응:**
1. Incident 생성
2. Senior Engineer 호출
3. 백업 복구 준비

---

## 연락처

| 역할 | 담당자 | 연락처 | 대응 시간 |
|------|--------|--------|-----------|
| Primary On-call | DevOps Team | #devops-alerts | 24/7 |
| Senior Engineer | Backend Team | #backend-urgent | 업무 시간 |
| Emergency | CTO | emergency@supernoba.com | 긴급 시 |

---

## 체크리스트 (출력용)

### 일일 체크 (오전 9시)

- [ ] 엔진 프로세스 실행 중
- [ ] Redis 연결 상태 CONNECTED
- [ ] 최근 1시간 ERROR 로그 없음
- [ ] ElastiCache CPU < 70%
- [ ] DynamoDB 처리량 정상

### 장애 대응 체크

- [ ] 로그 확인 (증상 파악)
- [ ] Redis PING 테스트
- [ ] ElastiCache 상태 확인
- [ ] 자동 복구 대기 (5분)
- [ ] 필요 시 엔진 재시작
- [ ] 복구 확인 (메트릭)
- [ ] Incident 기록

---

**준비 문서:**
- 📄 `agent-14-redis-failover-analysis.md` - 기술 상세
- 📄 `agent-14-implementation-guide.md` - 구현 가이드
- 📄 `agent-14-executive-summary.md` - 경영진 요약
- 📄 본 문서 - 운영 Quick Reference

**마지막 업데이트:** 2026-01-17
**담당:** DevOps Team
