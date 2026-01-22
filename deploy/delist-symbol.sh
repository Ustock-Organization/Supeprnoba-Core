#!/bin/bash
# ============================================================================
# 상장폐지 통합 스크립트
# 사용법: ./delist-symbol.sh <SYMBOL>
#
# 올바른 삭제 순서:
# 1. Snapshot 삭제 (복원 방지)
# 2. 엔진 재시작 (메모리 OrderBook 제거)
# 3. Valkey 캐시 삭제
# 4. RDS 데이터 삭제
# 5. DynamoDB 데이터 삭제
# ============================================================================

set -e

SYMBOL="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 환경 변수 로드
source "$SCRIPT_DIR/env/common.env" 2>/dev/null || true

# Valkey 호스트 (기본값)
BACKUP_CACHE_HOST="${BACKUP_CACHE_HOST:-master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com}"
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

# 사용법
if [ -z "$SYMBOL" ]; then
    echo "Usage: $0 <SYMBOL>"
    echo "Example: $0 TEST001"
    exit 1
fi

echo ""
echo "=============================================="
echo "  Delisting: $SYMBOL"
echo "=============================================="
echo ""

# 확인
read -p "Are you sure you want to delist $SYMBOL? (y/N): " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    log_warn "Aborted by user"
    exit 0
fi

# 1. Snapshot 삭제 (복원 방지) - 가장 먼저!
log_info "[1/5] Deleting Valkey snapshot (prevents restore on engine restart)..."
redis-cli -h "$BACKUP_CACHE_HOST" --tls \
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

# 3. Valkey 캐시 삭제
log_info "[3/5] Deleting Valkey cache..."
redis-cli -h "$BACKUP_CACHE_HOST" --tls << EOF
DEL ticker:$SYMBOL
DEL depth:$SYMBOL
DEL ohlc:$SYMBOL
DEL symbol:$SYMBOL:listingPrice
DEL symbol:$SYMBOL:main
DEL symbol:$SYMBOL:subscribers
DEL symbol:$SYMBOL:sub
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
DEL mm:config:$SYMBOL
DEL mm:price:$SYMBOL
DEL mm:orderCount:$SYMBOL
DEL mm:started_at:$SYMBOL
DEL prev:$SYMBOL
DEL ranking:$SYMBOL
SREM active:symbols $SYMBOL
SREM subscribed:symbols $SYMBOL
SREM mm:running:symbols $SYMBOL
SADD deleted:symbols $SYMBOL
EOF

log_success "Valkey cache deleted"

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

# 삭제 확인
log_info "Verifying deletion..."
remaining=$(redis-cli -h "$BACKUP_CACHE_HOST" --tls KEYS "*$SYMBOL*" 2>/dev/null | grep -v "deleted:symbols" || true)
if [ -n "$remaining" ]; then
    log_warn "Some keys still exist:"
    echo "$remaining"
else
    log_success "All Valkey keys deleted (except deleted:symbols)"
fi
