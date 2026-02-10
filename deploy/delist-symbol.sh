#!/bin/bash
# ============================================================================
# 상장폐지 통합 스크립트
# 사용법: ./delist-symbol.sh <SYMBOL>
#         ./delist-symbol.sh --dry-run <SYMBOL>
#
# 올바른 삭제 순서:
# 1. Snapshot 삭제 (복원 방지)
# 2. 엔진 재시작 (메모리 OrderBook 제거)
# 3. Valkey 4-Cache 키 삭제
# 4. RDS 데이터 삭제
# 5. DynamoDB 데이터 삭제
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 환경 변수 로드
source "$SCRIPT_DIR/env/common.env" 2>/dev/null || true

# 4-Cache 아키텍처 (localhost)
VALKEY_HOST="${VALKEY_HOST:-127.0.0.1}"
DEPTH_PORT="${DEPTH_CACHE_PORT:-6379}"
CANDLE_PORT="${CANDLE_CACHE_PORT:-6380}"
BACKUP_PORT="${BACKUP_CACHE_PORT:-6381}"
OPERATING_PORT="${OPERATING_CACHE_PORT:-6382}"
AWS_REGION="${AWS_REGION:-ap-northeast-2}"

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 인자 파싱
DRY_RUN=false
SYMBOL=""
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        -*) log_error "Unknown option: $arg"; exit 1 ;;
        *) SYMBOL="$arg" ;;
    esac
done

# 사용법
if [ -z "$SYMBOL" ]; then
    echo "Usage: $0 [--dry-run] <SYMBOL>"
    echo "Example: $0 TEST001"
    echo "         $0 --dry-run TEST001"
    exit 1
fi

echo ""
echo "=============================================="
echo "  Delisting: $SYMBOL"
if $DRY_RUN; then
    echo "  Mode: DRY-RUN (no changes will be made)"
fi
echo "  Valkey: $VALKEY_HOST (depth=$DEPTH_PORT candle=$CANDLE_PORT backup=$BACKUP_PORT operating=$OPERATING_PORT)"
echo "=============================================="
echo ""

# dry-run: 4개 포트별 삭제 대상 키 표시
if $DRY_RUN; then
    log_info "[DRY-RUN] Keys to delete:"
    echo ""

    log_info "Depth Cache ($VALKEY_HOST:$DEPTH_PORT):"
    for key in "depth:$SYMBOL" "ticker:$SYMBOL" "ohlc:$SYMBOL" "prev:$SYMBOL"; do
        exists=$(redis-cli -h "$VALKEY_HOST" -p "$DEPTH_PORT" EXISTS "$key" 2>/dev/null)
        if [ "$exists" = "1" ]; then
            echo "  DEL $key"
        fi
    done

    echo ""
    log_info "Candle Cache ($VALKEY_HOST:$CANDLE_PORT):"
    candle_keys=$(redis-cli -h "$VALKEY_HOST" -p "$CANDLE_PORT" KEYS "candle:*:$SYMBOL" 2>/dev/null)
    if [ -n "$candle_keys" ]; then
        while IFS= read -r key; do
            [ -n "$key" ] && echo "  DEL $key"
        done <<< "$candle_keys"
    fi

    echo ""
    log_info "Backup Cache ($VALKEY_HOST:$BACKUP_PORT):"
    for key in "snapshot:$SYMBOL" "snapshot:$SYMBOL:timestamp"; do
        exists=$(redis-cli -h "$VALKEY_HOST" -p "$BACKUP_PORT" EXISTS "$key" 2>/dev/null)
        if [ "$exists" = "1" ]; then
            echo "  DEL $key"
        fi
    done
    echo "  ZREM ranking:marketcap $SYMBOL"
    echo "  ZREM ranking:volume $SYMBOL"
    echo "  ZREM ranking:gainers $SYMBOL"
    echo "  ZREM ranking:losers $SYMBOL"

    echo ""
    log_info "Operating Cache ($VALKEY_HOST:$OPERATING_PORT):"
    sym_keys=$(redis-cli -h "$VALKEY_HOST" -p "$OPERATING_PORT" KEYS "symbol:$SYMBOL:*" 2>/dev/null)
    if [ -n "$sym_keys" ]; then
        while IFS= read -r key; do
            [ -n "$key" ] && echo "  DEL $key"
        done <<< "$sym_keys"
    fi
    for key in "mm:config:$SYMBOL" "mm:price:$SYMBOL" "mm:orderCount:$SYMBOL" "mm:started_at:$SYMBOL"; do
        exists=$(redis-cli -h "$VALKEY_HOST" -p "$OPERATING_PORT" EXISTS "$key" 2>/dev/null)
        if [ "$exists" = "1" ]; then
            echo "  DEL $key"
        fi
    done
    echo "  SREM active:symbols $SYMBOL"
    echo "  SREM subscribed:symbols $SYMBOL"
    echo "  SREM mm:running:symbols $SYMBOL"
    echo "  SADD deleted:symbols $SYMBOL"

    echo ""
    log_info "[DRY-RUN] No changes were made."
    exit 0
fi

# 실행 확인
read -p "Are you sure you want to delist $SYMBOL? (y/N): " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    log_warn "Aborted by user"
    exit 0
fi

# 1. Snapshot 삭제 (복원 방지) - 가장 먼저! — Backup Cache (6381)
log_info "[1/5] Deleting Valkey snapshot (prevents restore on engine restart)..."
redis-cli -h "$VALKEY_HOST" -p "$BACKUP_PORT" \
    DEL "snapshot:$SYMBOL" "snapshot:$SYMBOL:timestamp" 2>/dev/null || {
    log_warn "Failed to delete snapshot (may not exist)"
}

# 2. 엔진 재시작 (메모리 OrderBook 제거)
log_info "[2/5] Restarting engine (removes OrderBook from memory)..."
if [ -x "$SCRIPT_DIR/supernoba-ctl.sh" ]; then
    "$SCRIPT_DIR/supernoba-ctl.sh" restart engine || {
        log_warn "Engine restart skipped (not on engine host or failed)"
    }
else
    log_warn "supernoba-ctl.sh not found, skipping engine restart"
fi

# 3. Valkey 4-Cache 키 삭제
log_info "[3/5] Deleting Valkey 4-Cache keys..."

# 3a. Depth Cache (6379)
log_info "  Depth Cache ($VALKEY_HOST:$DEPTH_PORT)..."
redis-cli -h "$VALKEY_HOST" -p "$DEPTH_PORT" DEL \
    "depth:$SYMBOL" "ticker:$SYMBOL" "ohlc:$SYMBOL" "prev:$SYMBOL" \
    2>/dev/null || true

# 3b. Candle Cache (6380)
log_info "  Candle Cache ($VALKEY_HOST:$CANDLE_PORT)..."
redis-cli -h "$VALKEY_HOST" -p "$CANDLE_PORT" << EOF
DEL candle:1m:$SYMBOL
DEL candle:3m:$SYMBOL
DEL candle:5m:$SYMBOL
DEL candle:15m:$SYMBOL
DEL candle:30m:$SYMBOL
DEL candle:1h:$SYMBOL
DEL candle:4h:$SYMBOL
DEL candle:1d:$SYMBOL
DEL candle:1w:$SYMBOL
DEL candle:closed:1m:$SYMBOL
EOF

# 3c. Backup Cache (6381) — ranking ZREM
log_info "  Backup Cache ($VALKEY_HOST:$BACKUP_PORT)..."
redis-cli -h "$VALKEY_HOST" -p "$BACKUP_PORT" << EOF
DEL ranking:$SYMBOL
ZREM ranking:marketcap $SYMBOL
ZREM ranking:volume $SYMBOL
ZREM ranking:gainers $SYMBOL
ZREM ranking:losers $SYMBOL
EOF

# 3d. Operating Cache (6382)
log_info "  Operating Cache ($VALKEY_HOST:$OPERATING_PORT)..."
redis-cli -h "$VALKEY_HOST" -p "$OPERATING_PORT" << EOF
DEL symbol:$SYMBOL:listingPrice
DEL symbol:$SYMBOL:main
DEL symbol:$SYMBOL:subscribers
DEL symbol:$SYMBOL:sub
DEL mm:config:$SYMBOL
DEL mm:price:$SYMBOL
DEL mm:orderCount:$SYMBOL
DEL mm:started_at:$SYMBOL
SREM active:symbols $SYMBOL
SREM subscribed:symbols $SYMBOL
SREM mm:running:symbols $SYMBOL
SADD deleted:symbols $SYMBOL
EOF

log_success "Valkey 4-Cache keys deleted"

# 4. RDS 삭제
log_info "[4/5] Deleting RDS data..."
"$SCRIPT_DIR/run-sql.sh" ops/delist_symbol.sql "symbol=$SYMBOL" || {
    log_warn "RDS deletion failed (run-sql.sh may not be available)"
}

# 5. DynamoDB 삭제
log_info "[5/5] Deleting DynamoDB data..."

# 종목 메타데이터 삭제
aws dynamodb delete-item \
    --table-name supernoba-symbols \
    --key "{\"symbol\": {\"S\": \"$SYMBOL\"}}" \
    --region "$AWS_REGION" 2>/dev/null || {
    log_warn "supernoba-symbols delete failed (may not exist)"
}

# IPO 주문 삭제
aws dynamodb delete-item \
    --table-name supernoba-ipo-orders \
    --key "{\"symbol\": {\"S\": \"$SYMBOL\"}}" \
    --region "$AWS_REGION" 2>/dev/null || true

# 해당 종목 주문 삭제 (scan 필요)
log_info "Scanning for orders to delete..."
orders=$(aws dynamodb scan \
    --table-name supernoba-orders \
    --filter-expression "symbol = :s" \
    --expression-attribute-values "{\":s\": {\"S\": \"$SYMBOL\"}}" \
    --projection-expression "user_id, order_id" \
    --region "$AWS_REGION" \
    --output json 2>/dev/null | jq -r '.Items[] | "\(.user_id.S) \(.order_id.S)"')

if [ -n "$orders" ]; then
    echo "$orders" | while read -r uid oid; do
        if [ -n "$uid" ] && [ -n "$oid" ]; then
            aws dynamodb delete-item \
                --table-name supernoba-orders \
                --key "{\"user_id\": {\"S\": \"$uid\"}, \"order_id\": {\"S\": \"$oid\"}}" \
                --region "$AWS_REGION" 2>/dev/null
        fi
    done
    log_success "Orders deleted"
else
    log_info "No orders found for $SYMBOL"
fi

# 해당 종목 보유량 삭제
log_info "Scanning for holdings to delete..."
holdings=$(aws dynamodb scan \
    --table-name supernoba-holdings \
    --filter-expression "symbol = :s" \
    --expression-attribute-values "{\":s\": {\"S\": \"$SYMBOL\"}}" \
    --projection-expression "user_id" \
    --region "$AWS_REGION" \
    --output json 2>/dev/null | jq -r '.Items[] | "\(.user_id.S)"')

if [ -n "$holdings" ]; then
    echo "$holdings" | while read -r uid; do
        if [ -n "$uid" ]; then
            aws dynamodb delete-item \
                --table-name supernoba-holdings \
                --key "{\"user_id\": {\"S\": \"$uid\"}, \"symbol\": {\"S\": \"$SYMBOL\"}}" \
                --region "$AWS_REGION" 2>/dev/null
        fi
    done
    log_success "Holdings deleted"
else
    log_info "No holdings found for $SYMBOL"
fi

echo ""
echo "=============================================="
echo "  Delisting complete for: $SYMBOL"
echo "=============================================="
echo ""

# 삭제 확인 — 4개 캐시 모두 검색
log_info "Verifying deletion across 4 caches..."
remaining=""
for port in $DEPTH_PORT $CANDLE_PORT $BACKUP_PORT $OPERATING_PORT; do
    keys=$(redis-cli -h "$VALKEY_HOST" -p "$port" KEYS "*$SYMBOL*" 2>/dev/null | grep -v "deleted:symbols" || true)
    if [ -n "$keys" ]; then
        remaining="${remaining}Port $port:\n${keys}\n"
    fi
done

if [ -n "$remaining" ]; then
    log_warn "Some keys still exist:"
    echo -e "$remaining"
else
    log_success "All Valkey keys deleted across 4 caches (except deleted:symbols)"
fi
