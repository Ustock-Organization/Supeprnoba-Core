#!/bin/bash
# ============================================================================
# SQL 실행 유틸리티
# 사용법: ./run-sql.sh <script.sql> [var=value ...]
# 예: ./run-sql.sh ops/delist_symbol.sql symbol=TEST001
#     ./run-sql.sh schema/001_create_tables.sql
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SQL_DIR="$SCRIPT_DIR/sql"

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# RDS 연결 정보 (Secrets Manager에서 가져옴)
get_rds_credentials() {
    log_info "Getting RDS credentials from Secrets Manager..."

    local secret
    secret=$(aws secretsmanager get-secret-value \
        --secret-id supernoba/db-credentials \
        --query SecretString --output text 2>/dev/null)

    if [ -z "$secret" ]; then
        log_error "Failed to get RDS credentials from Secrets Manager"
        log_info "Falling back to .pgpass if available..."

        if [ -f "$HOME/.pgpass" ]; then
            log_info "Using credentials from .pgpass"
            return 0
        fi

        exit 1
    fi

    export PGHOST=$(echo "$secret" | jq -r '.host')
    export PGPORT=$(echo "$secret" | jq -r '.port')
    export PGDATABASE=$(echo "$secret" | jq -r '.database')
    export PGUSER=$(echo "$secret" | jq -r '.username')
    export PGPASSWORD=$(echo "$secret" | jq -r '.password')
    export PGSSLMODE=require

    log_success "RDS credentials loaded: $PGHOST:$PGPORT/$PGDATABASE"
}

# 사용법 출력
usage() {
    echo "Usage: $0 <script.sql> [var=value ...]"
    echo ""
    echo "Examples:"
    echo "  $0 schema/001_create_tables.sql"
    echo "  $0 ops/delist_symbol.sql symbol=TEST001"
    echo "  $0 ops/reset_platform.sql"
    echo ""
    echo "Available scripts:"

    if [ -d "$SQL_DIR" ]; then
        find "$SQL_DIR" -name "*.sql" -type f | sed "s|$SQL_DIR/||" | sort
    fi

    exit 1
}

# 메인 함수
main() {
    local script="$1"
    shift || true

    if [ -z "$script" ]; then
        usage
    fi

    local sql_file="$SQL_DIR/$script"
    if [ ! -f "$sql_file" ]; then
        log_error "SQL file not found: $sql_file"
        exit 1
    fi

    # psql 확인
    if ! command -v psql &> /dev/null; then
        log_error "psql not found. Please install postgresql-client."
        exit 1
    fi

    # 자격 증명 가져오기
    get_rds_credentials

    # 변수를 -v 옵션으로 변환
    local psql_args=()
    for arg in "$@"; do
        if [[ "$arg" == *"="* ]]; then
            psql_args+=("-v" "$arg")
        fi
    done

    log_info "Executing: $sql_file"

    if [ ${#psql_args[@]} -gt 0 ]; then
        log_info "Variables: ${psql_args[*]}"
    fi

    # SQL 실행
    if psql "${psql_args[@]}" -f "$sql_file"; then
        log_success "SQL executed successfully"
    else
        log_error "SQL execution failed"
        exit 1
    fi
}

main "$@"
