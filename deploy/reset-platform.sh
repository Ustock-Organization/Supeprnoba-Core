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
#   - Valkey 4-Cache:
#     - depth(6379): depth:*, ticker:*, ohlc:*, prev:*
#     - candle(6380): candle:*
#     - backup(6381): snapshot:*, kinesis:checkpoint:*, ranking:*, engine:*, system:*
#     - operating(6382): ws:*, user:*, symbol:*, mm:*, admin:*, order:*, subscribed:*, deleted:*, active:*, blocked:*, conn:*
#

set -e

# 공통 라이브러리 로드 (색상, 로깅 함수)
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

# 경로 설정
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 환경변수 로드
if [ -f "$SCRIPT_DIR/env/common.env" ]; then
    source "$SCRIPT_DIR/env/common.env"
fi

# 기본값 설정 — 4-Cache 아키텍처 (localhost)
AWS_REGION="${AWS_REGION:-ap-northeast-2}"
VALKEY_HOST="${VALKEY_HOST:-127.0.0.1}"

# 4-Cache 포트 매핑
DEPTH_PORT="${DEPTH_CACHE_PORT:-6379}"
CANDLE_PORT="${CANDLE_CACHE_PORT:-6380}"
BACKUP_PORT="${BACKUP_CACHE_PORT:-6381}"
OPERATING_PORT="${OPERATING_CACHE_PORT:-6382}"

# RDS: run-sql.sh가 AWS Secrets Manager에서 자격증명을 자동으로 가져옴
# 테이블 목록은 sql/ops/reset_platform.sql에서 중앙 관리

# DynamoDB 테이블 목록
DYNAMODB_TABLES=("supernoba-orders" "supernoba-holdings" "supernoba-wallets" "supernoba-symbols")

# 4-Cache별 키 패턴
DEPTH_KEY_PATTERNS=("depth:*" "ticker:*" "ohlc:*" "prev:*")
CANDLE_KEY_PATTERNS=("candle:*")
BACKUP_KEY_PATTERNS=("snapshot:*" "kinesis:checkpoint:*" "ranking:*" "engine:*" "system:*")
OPERATING_KEY_PATTERNS=(
    "ws:*" "user:*" "symbol:*" "mm:*" "admin:*" "order:*"
    "subscribed:*" "deleted:*" "active:*" "blocked:*" "conn:*"
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

#===== Valkey 4-Cache 함수 =====

# redis-cli로 키 수 조회 (패턴별)
count_valkey_keys() {
    local port=$1
    local pattern=$2
    redis-cli -h "$VALKEY_HOST" -p "$port" KEYS "$pattern" 2>/dev/null | wc -l
}

# redis-cli로 키 삭제 (패턴별)
delete_valkey_keys() {
    local port=$1
    local pattern=$2
    local keys
    keys=$(redis-cli -h "$VALKEY_HOST" -p "$port" KEYS "$pattern" 2>/dev/null)
    if [ -z "$keys" ]; then
        echo "0"
        return
    fi
    local count=0
    while IFS= read -r key; do
        if [ -n "$key" ]; then
            redis-cli -h "$VALKEY_HOST" -p "$port" DEL "$key" > /dev/null 2>&1
            ((count++))
        fi
    done <<< "$keys"
    echo "$count"
}

# 캐시별 키 현황 출력
show_cache_status() {
    local name=$1
    local port=$2
    shift 2
    local patterns=("$@")

    echo ""
    log_info "$name Cache ($VALKEY_HOST:$port):"
    local dbsize=$(redis-cli -h "$VALKEY_HOST" -p "$port" DBSIZE 2>/dev/null | awk '{print $NF}')
    log_info "  DBSIZE: ${dbsize:-0}"

    for pattern in "${patterns[@]}"; do
        local count=$(count_valkey_keys "$port" "$pattern")
        if [ "$count" != "0" ]; then
            log_info "  $pattern: $count keys"
        fi
    done
}

# 캐시별 키 삭제
delete_cache_keys() {
    local name=$1
    local port=$2
    shift 2
    local patterns=("$@")

    log_info "Deleting $name Cache keys..."
    for pattern in "${patterns[@]}"; do
        local deleted=$(delete_valkey_keys "$port" "$pattern")
        if [ "$deleted" != "0" ]; then
            log_success "  Deleted $deleted keys matching $pattern"
        fi
    done
}

# Valkey 4-Cache 초기화
reset_valkey() {
    echo ""
    echo -e "${CYAN}=== Valkey 4-Cache Reset ===${NC}"

    # 4개 캐시별 현황 표시
    show_cache_status "Depth"     "$DEPTH_PORT"     "${DEPTH_KEY_PATTERNS[@]}"
    show_cache_status "Candle"    "$CANDLE_PORT"    "${CANDLE_KEY_PATTERNS[@]}"
    show_cache_status "Backup"    "$BACKUP_PORT"    "${BACKUP_KEY_PATTERNS[@]}"
    show_cache_status "Operating" "$OPERATING_PORT" "${OPERATING_KEY_PATTERNS[@]}"

    if $DRY_RUN; then
        echo ""
        log_info "[DRY-RUN] Would delete all matching keys across 4 caches"
        return 0
    fi

    if $CONFIRMED; then
        echo ""
        log_info "Deleting Valkey keys across 4 caches..."

        delete_cache_keys "Depth"     "$DEPTH_PORT"     "${DEPTH_KEY_PATTERNS[@]}"
        delete_cache_keys "Candle"    "$CANDLE_PORT"    "${CANDLE_KEY_PATTERNS[@]}"
        delete_cache_keys "Backup"    "$BACKUP_PORT"    "${BACKUP_KEY_PATTERNS[@]}"
        delete_cache_keys "Operating" "$OPERATING_PORT" "${OPERATING_KEY_PATTERNS[@]}"

        log_success "All Valkey keys deleted across 4 caches"
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
    echo "4-Cache Ports:"
    echo "  Depth:     $DEPTH_PORT     (depth, ticker, ohlc, prev)"
    echo "  Candle:    $CANDLE_PORT    (candle)"
    echo "  Backup:    $BACKUP_PORT    (snapshot, checkpoint, ranking)"
    echo "  Operating: $OPERATING_PORT (ws, user, symbol, mm, admin)"
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
    echo "  Valkey Host: $VALKEY_HOST"
    echo "  Ports: depth=$DEPTH_PORT candle=$CANDLE_PORT backup=$BACKUP_PORT operating=$OPERATING_PORT"
    echo "============================================"
    echo ""

    # 경고 메시지
    if $CONFIRMED && ! $DRY_RUN; then
        echo -e "${RED}WARNING: This will DELETE ALL DATA!${NC}"
        echo ""
        echo "The following will be cleared:"
        echo "  - DynamoDB: orders, holdings, wallets, symbols"
        echo "  - PostgreSQL: trade_history, candle_history"
        echo "  - Valkey 4-Cache: depth, candle, backup, operating keys"
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

    # Valkey 4-Cache 초기화
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
