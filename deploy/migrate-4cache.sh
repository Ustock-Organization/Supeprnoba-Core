#!/bin/bash
# migrate-4cache.sh — EC2에서 실행
# Redis MIGRATE 명령으로 키를 안전하게 이동 (바이너리 안전)
# 전제: 모든 서비스 정지 상태

SRC=6379

migrate_keys() {
    local pattern=$1
    local dst_port=$2
    local label=$3

    # 키 목록 가져오기
    local keys
    keys=$(redis-cli -p $SRC KEYS "$pattern" 2>/dev/null)
    if [ -z "$keys" ]; then
        echo "  [$label] No keys matching $pattern"
        return 0
    fi

    local count=0
    local fail=0
    for key in $keys; do
        # MIGRATE: 바이너리 안전, 자체적으로 직렬화/역직렬화 처리
        if redis-cli -p $SRC MIGRATE 127.0.0.1 "$dst_port" "$key" 0 5000 COPY REPLACE > /dev/null 2>&1; then
            ((count++)) || true
        else
            ((fail++)) || true
        fi
    done
    echo "  [$label] Migrated $count keys ($pattern) → port $dst_port (failed: $fail)"
    return 0
}

echo "=== 4-Cache Data Migration ==="
echo "Source: port $SRC (all data)"
echo ""

# candle-cache → 6380
migrate_keys "candle:*" 6380 "candle-cache"

# backup-cache → 6381
migrate_keys "snapshot:*" 6381 "backup-cache"
migrate_keys "kinesis:checkpoint:*" 6381 "backup-cache"
migrate_keys "ranking:*" 6381 "backup-cache"
migrate_keys "rankings:*" 6381 "backup-cache"
migrate_keys "engine:*" 6381 "backup-cache"
migrate_keys "system:*" 6381 "backup-cache"

# operating-cache → 6382
migrate_keys "ws:*" 6382 "operating-cache"
migrate_keys "user:*" 6382 "operating-cache"
migrate_keys "conn:*" 6382 "operating-cache"
migrate_keys "symbol:*" 6382 "operating-cache"
migrate_keys "subscribed:*" 6382 "operating-cache"
migrate_keys "active:*" 6382 "operating-cache"
migrate_keys "blocked:*" 6382 "operating-cache"
migrate_keys "deleted:*" 6382 "operating-cache"
migrate_keys "mm:*" 6382 "operating-cache"
migrate_keys "admin:*" 6382 "operating-cache"
migrate_keys "order:*" 6382 "operating-cache"

# depth-cache — 6379에 그대로 유지 (depth:*, ticker:*, ohlc:*, prev:*)
echo "  [depth-cache] depth:*, ticker:*, ohlc:*, prev:* stay on port 6379"

# 마이그레이션 완료 후 6379에서 이동된 키 삭제
echo ""
echo "=== Cleaning migrated keys from port 6379 ==="
cleaned=0
for pattern in "candle:*" "snapshot:*" "kinesis:checkpoint:*" "ranking:*" "rankings:*" \
               "engine:*" "system:*" "ws:*" "user:*" "conn:*" "symbol:*" \
               "subscribed:*" "active:*" "blocked:*" "deleted:*" "mm:*" "admin:*" "order:*"; do
    keys=$(redis-cli -p $SRC KEYS "$pattern" 2>/dev/null)
    if [ -n "$keys" ]; then
        for key in $keys; do
            redis-cli -p $SRC DEL "$key" > /dev/null 2>&1 || true
            ((cleaned++)) || true
        done
    fi
done
echo "  Cleaned $cleaned keys from port 6379"

echo ""
echo "=== Verification ==="
for port in 6379 6380 6381 6382; do
    echo "  Port $port: $(redis-cli -p $port DBSIZE 2>/dev/null)"
done

echo "=== Migration Complete ==="
