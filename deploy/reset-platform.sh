#!/bin/bash
#
# Supernoba Platform Reset Script
#
# 플랫폼 전체 데이터를 초기화합니다.
# 주의: 모든 데이터가 삭제됩니다!
#
# 사용법:
#   ./reset-platform.sh --dry-run     # 삭제 대상 확인만 (실제 삭제 안함)
#   ./reset-platform.sh --confirm     # 실제 삭제 실행
#
# 초기화 대상:
#   - DynamoDB: supernoba-orders, supernoba-holdings, supernoba-wallets, supernoba-symbols
#   - PostgreSQL: trade_history, candle_history
#   - Valkey: depth:*, candle:*, ticker:*, mm:*, subscribed:symbols, snapshot:*, orderbook:*, ranking:*, backup:* 등
#

set -e

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 경로 설정
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 환경변수 로드
if [ -f "$SCRIPT_DIR/env/common.env" ]; then
    source "$SCRIPT_DIR/env/common.env"
fi

# 기본값 설정
AWS_REGION="${AWS_REGION:-ap-northeast-2}"
BACKUP_CACHE_HOST="${BACKUP_CACHE_HOST:-master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com}"
BACKUP_CACHE_PORT="${BACKUP_CACHE_PORT:-6379}"
DEPTH_CACHE_HOST="${DEPTH_CACHE_HOST:-supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com}"
DEPTH_CACHE_PORT="${DEPTH_CACHE_PORT:-6379}"

# RDS: run-sql.sh가 AWS Secrets Manager에서 자격증명을 자동으로 가져옴
# 테이블 목록은 sql/ops/reset_platform.sql에서 중앙 관리

# DynamoDB 테이블 목록
DYNAMODB_TABLES=("supernoba-orders" "supernoba-holdings" "supernoba-wallets" "supernoba-symbols")

# Valkey 키 패턴
VALKEY_KEY_PATTERNS=(
    "depth:*"
    "candle:*"
    "ticker:*"
    "mm:*"
    "prev:*"
    "user:*"
    "ws:*"
    "symbol:*"
    "active:symbols"
    "subscribed:symbols"
    "deleted:symbols"
    # 백업 관련 키
    "snapshot:*"
    "orderbook:*"
    "ranking:*"
    "backup:*"
)

# 모드 설정
DRY_RUN=false
CONFIRMED=false

#===== DynamoDB 함수 =====

# DynamoDB 테이블 아이템 수 조회
count_dynamodb_items() {
    local table=$1
    local count=$(aws dynamodb scan \
        --table-name "$table" \
        --select COUNT \
        --region "$AWS_REGION" \
        --query 'Count' \
        --output text 2>/dev/null || echo "0")
    echo "$count"
}

# DynamoDB 테이블 전체 삭제
reset_dynamodb_table() {
    local table=$1

    log_info "Resetting DynamoDB table: $table"

    # 테이블 키 스키마 확인
    local key_schema=$(aws dynamodb describe-table \
        --table-name "$table" \
        --region "$AWS_REGION" \
        --query 'Table.KeySchema' \
        --output json 2>/dev/null)

    if [ -z "$key_schema" ]; then
        log_error "Failed to get key schema for $table"
        return 1
    fi

    # 파티션 키와 정렬 키 추출
    local pk=$(echo "$key_schema" | jq -r '.[] | select(.KeyType=="HASH") | .AttributeName')
    local sk=$(echo "$key_schema" | jq -r '.[] | select(.KeyType=="RANGE") | .AttributeName // empty')

    # 모든 아이템 스캔 및 삭제
    local items
    items=$(aws dynamodb scan \
        --table-name "$table" \
        --region "$AWS_REGION" \
        --projection-expression "$pk$([ -n "$sk" ] && echo ", $sk")" \
        --output json 2>/dev/null)

    local count=$(echo "$items" | jq '.Count')

    if [ "$count" -eq 0 ]; then
        log_info "  Table is already empty"
        return 0
    fi

    log_info "  Found $count items to delete"

    if $DRY_RUN; then
        log_info "  [DRY-RUN] Would delete $count items"
        return 0
    fi

    # 배치 삭제 (25개씩)
    echo "$items" | jq -c '.Items[]' | while read -r item; do
        local key_json
        if [ -n "$sk" ]; then
            key_json=$(echo "$item" | jq "{\"$pk\": .$pk, \"$sk\": .$sk}")
        else
            key_json=$(echo "$item" | jq "{\"$pk\": .$pk}")
        fi

        aws dynamodb delete-item \
            --table-name "$table" \
            --key "$key_json" \
            --region "$AWS_REGION" 2>/dev/null || true
    done

    log_success "  Deleted $count items from $table"
}

# 모든 DynamoDB 테이블 초기화
reset_all_dynamodb() {
    echo ""
    echo -e "${CYAN}=== DynamoDB Reset ===${NC}"

    for table in "${DYNAMODB_TABLES[@]}"; do
        local count=$(count_dynamodb_items "$table")
        log_info "$table: $count items"

        if ! $DRY_RUN && $CONFIRMED; then
            reset_dynamodb_table "$table"
        fi
    done
}

#===== PostgreSQL 함수 =====

# PostgreSQL 초기화 (run-sql.sh 사용)
# 자격증명은 run-sql.sh가 AWS Secrets Manager에서 자동으로 가져옴
# 테이블 목록은 sql/ops/reset_platform.sql에서 중앙 관리
reset_postgresql() {
    echo ""
    echo -e "${CYAN}=== PostgreSQL Reset ===${NC}"

    # run-sql.sh 존재 확인
    if [ ! -x "$SCRIPT_DIR/run-sql.sh" ]; then
        log_error "run-sql.sh not found or not executable"
        return 1
    fi

    # reset_platform.sql 존재 확인
    if [ ! -f "$SCRIPT_DIR/sql/ops/reset_platform.sql" ]; then
        log_error "sql/ops/reset_platform.sql not found"
        return 1
    fi

    if $DRY_RUN; then
        log_info "[DRY-RUN] Would execute: run-sql.sh ops/reset_platform.sql"
        log_info "Tables to truncate: market_maker_configs, trade_history, candle_history,"
        log_info "                    daily_ohlc_summary, symbol_prev_close, active_symbols,"
        log_info "                    daily_close_job_log"
        return 0
    fi

    if $CONFIRMED; then
        log_info "Executing SQL reset via run-sql.sh..."
        if "$SCRIPT_DIR/run-sql.sh" ops/reset_platform.sql; then
            log_success "PostgreSQL tables truncated"
        else
            log_error "PostgreSQL reset failed"
            return 1
        fi
    fi
}

#===== Valkey 함수 =====

# Valkey 키 수 조회
count_valkey_keys() {
    local host=$1
    local port=$2
    local pattern=$3

    # Node.js 스크립트로 TLS 연결
    node --input-type=module -e "
import Redis from 'ioredis';
const redis = new Redis({
    host: '$host',
    port: $port,
    tls: {},
    connectTimeout: 5000
});
redis.keys('$pattern').then(keys => {
    console.log(keys.length);
    redis.quit();
}).catch(e => {
    console.log('0');
    redis.quit();
});
" 2>/dev/null || echo "0"
}

# Valkey 키 삭제
delete_valkey_keys() {
    local host=$1
    local port=$2
    local pattern=$3

    # Node.js 스크립트로 TLS 연결 및 삭제
    node --input-type=module -e "
import Redis from 'ioredis';
const redis = new Redis({
    host: '$host',
    port: $port,
    tls: {},
    connectTimeout: 5000
});

async function deleteKeys() {
    const keys = await redis.keys('$pattern');
    if (keys.length === 0) {
        console.log('0');
        return;
    }

    // Pipeline으로 배치 삭제
    const pipeline = redis.pipeline();
    for (const key of keys) {
        pipeline.del(key);
    }
    await pipeline.exec();
    console.log(keys.length);
}

deleteKeys().then(() => redis.quit()).catch(e => {
    console.error(e.message);
    redis.quit();
});
" 2>/dev/null || echo "0"
}

# Valkey 초기화
reset_valkey() {
    echo ""
    echo -e "${CYAN}=== Valkey Reset ===${NC}"

    echo ""
    log_info "Backup Cache ($BACKUP_CACHE_HOST):"
    for pattern in "${VALKEY_KEY_PATTERNS[@]}"; do
        local count=$(count_valkey_keys "$BACKUP_CACHE_HOST" "$BACKUP_CACHE_PORT" "$pattern")
        if [ "$count" != "0" ]; then
            log_info "  $pattern: $count keys"
        fi
    done

    echo ""
    log_info "Depth Cache ($DEPTH_CACHE_HOST):"
    local depth_count=$(count_valkey_keys "$DEPTH_CACHE_HOST" "$DEPTH_CACHE_PORT" "depth:*")
    log_info "  depth:*: $depth_count keys"

    if $DRY_RUN; then
        log_info "[DRY-RUN] Would delete all matching keys"
        return 0
    fi

    if $CONFIRMED; then
        log_info "Deleting Valkey keys..."

        # Backup Cache 키 삭제
        for pattern in "${VALKEY_KEY_PATTERNS[@]}"; do
            local deleted=$(delete_valkey_keys "$BACKUP_CACHE_HOST" "$BACKUP_CACHE_PORT" "$pattern")
            if [ "$deleted" != "0" ]; then
                log_success "  Deleted $deleted keys matching $pattern"
            fi
        done

        # Depth Cache 키 삭제
        local deleted=$(delete_valkey_keys "$DEPTH_CACHE_HOST" "$DEPTH_CACHE_PORT" "depth:*")
        if [ "$deleted" != "0" ]; then
            log_success "  Deleted $deleted keys from Depth Cache"
        fi

        log_success "Valkey keys deleted"
    fi
}

#===== 서비스 종료 =====

stop_all_services() {
    echo ""
    echo -e "${CYAN}=== Stopping Services ===${NC}"

    if $DRY_RUN; then
        log_info "[DRY-RUN] Would stop all services"
        return 0
    fi

    log_info "Stopping all Supernoba services..."

    # supernoba-ctl.sh가 있으면 사용
    if [ -f "$SCRIPT_DIR/supernoba-ctl.sh" ]; then
        bash "$SCRIPT_DIR/supernoba-ctl.sh" stop all 2>/dev/null || true
    fi

    # 추가로 프로세스 강제 종료
    pkill -9 -f 'matching_engine' 2>/dev/null || true
    pkill -9 -f 'node.*index\.mjs' 2>/dev/null || true
    pkill -9 -f 'candle_aggregator' 2>/dev/null || true
    pkill -9 -f 'stock-processor' 2>/dev/null || true

    log_success "All services stopped"
}

#===== 메인 =====

show_help() {
    echo "Supernoba Platform Reset Script"
    echo ""
    echo "Usage: $0 [options]"
    echo ""
    echo "Options:"
    echo "  --dry-run     Show what would be deleted without actually deleting"
    echo "  --confirm     Actually perform the reset (requires confirmation)"
    echo "  --help        Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 --dry-run   # Preview what will be deleted"
    echo "  $0 --confirm   # Perform the reset"
    echo ""
}

main() {
    # 인자 파싱
    while [[ $# -gt 0 ]]; do
        case $1 in
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --confirm)
                CONFIRMED=true
                shift
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done

    # 인자 없으면 도움말
    if ! $DRY_RUN && ! $CONFIRMED; then
        show_help
        exit 0
    fi

    echo "============================================"
    echo "  Supernoba Platform Reset"
    if $DRY_RUN; then
        echo "  Mode: DRY-RUN (no changes will be made)"
    else
        echo "  Mode: LIVE (data WILL be deleted!)"
    fi
    echo "============================================"
    echo ""

    # 경고 메시지
    if $CONFIRMED && ! $DRY_RUN; then
        echo -e "${RED}⚠️  WARNING: This will DELETE ALL DATA!${NC}"
        echo ""
        echo "The following will be cleared:"
        echo "  - DynamoDB: orders, holdings, wallets, symbols"
        echo "  - PostgreSQL: trade_history, candle_history"
        echo "  - Valkey: depth, candle, ticker, mm, snapshot, orderbook, ranking, backup keys"
        echo ""
        read -p "Type 'DELETE ALL' to confirm: " confirm
        if [ "$confirm" != "DELETE ALL" ]; then
            log_info "Aborted."
            exit 0
        fi
        echo ""
    fi

    # 서비스 중지
    if $CONFIRMED; then
        stop_all_services
    fi

    # DynamoDB 초기화
    reset_all_dynamodb

    # PostgreSQL 초기화
    reset_postgresql

    # Valkey 초기화
    reset_valkey

    echo ""
    echo "============================================"
    if $DRY_RUN; then
        echo "  Dry-run complete. No changes were made."
    else
        echo "  Platform Reset Complete!"
    fi
    echo "============================================"
}

main "$@"
