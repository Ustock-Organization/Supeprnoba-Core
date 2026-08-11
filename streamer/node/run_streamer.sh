#!/bin/bash
# run_streamer.sh - Streaming Server 단일 실행 스크립트
# EC2에서 환경 설정 및 스트리머 실행
# 사용법:
#   ./run_streamer.sh           # 기본 모드
#   ./run_streamer.sh --debug   # 디버그 모드
#   ./run_streamer.sh --init    # 익명 사용자 캐시 초기화 후 시작

set -e

# ===== 옵션 파싱 =====
DEBUG_MODE=false
INIT_MODE=false
for arg in "$@"; do
    case $arg in
        --debug)
            DEBUG_MODE=true
            ;;
        --init)
            INIT_MODE=true
            ;;
    esac
done

echo "╔═══════════════════════════════════════════════════════════╗"
if [ "$INIT_MODE" == "true" ]; then
    echo "║     Liquibook Streaming Server [INIT MODE]               ║"
else
    echo "║     Liquibook Streaming Server                            ║"
fi
echo "╚═══════════════════════════════════════════════════════════╝"

# ===== 환경변수 설정 =====
# Streamer는 Real-time Depth Cache 사용
export VALKEY_HOST="${VALKEY_HOST:-supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com}"
export VALKEY_PORT="${VALKEY_PORT:-6379}"
export VALKEY_TLS="${VALKEY_TLS:-false}"
export WEBSOCKET_ENDPOINT="${WEBSOCKET_ENDPOINT:-l2ptm85wub.execute-api.ap-northeast-2.amazonaws.com/production}"
export AWS_REGION="${AWS_REGION:-ap-northeast-2}"
export DEBUG_MODE="$DEBUG_MODE"

# Admin WebSocket (MM 상태 브로드캐스트용)
export ADMIN_WEBSOCKET_ENDPOINT="${ADMIN_WEBSOCKET_ENDPOINT:-2qlrv92731.execute-api.ap-northeast-2.amazonaws.com/admin}"
export BACKUP_CACHE_HOST="${BACKUP_CACHE_HOST:-master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com}"

echo ""
echo "=== 환경 설정 ==="
echo "VALKEY_HOST: $VALKEY_HOST"
echo "VALKEY_PORT: $VALKEY_PORT"
echo "VALKEY_TLS: $VALKEY_TLS"
echo "WEBSOCKET_ENDPOINT: $WEBSOCKET_ENDPOINT"
echo "ADMIN_WEBSOCKET_ENDPOINT: $ADMIN_WEBSOCKET_ENDPOINT"
echo "BACKUP_CACHE_HOST: $BACKUP_CACHE_HOST"
echo "DEBUG_MODE: $DEBUG_MODE"
echo "INIT_MODE: $INIT_MODE"
echo "AWS_REGION: $AWS_REGION"

# ===== 경로 설정 =====
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ===== --init: 익명 사용자 캐시 초기화 =====
if [ "$INIT_MODE" == "true" ]; then
    echo ""
    echo "=== [INIT] 캐시 초기화 중... ==="
    
    # redis-cli 확인
    if command -v redis-cli &> /dev/null; then
        echo "  - ws:* 키 삭제 (WebSocket 연결 정보)..."
        redis-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" KEYS "ws:*" | xargs -r redis-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" DEL
        
        echo "  - user:*:connections 키 삭제 (사용자별 연결 목록)..."
        redis-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" KEYS "user:*:connections" | xargs -r redis-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" DEL
        
        echo "  - conn:* 키 삭제 (연결별 구독 정보)..."
        redis-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" KEYS "conn:*" | xargs -r redis-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" DEL
        
        echo "  - symbol:*:subscribers 키 삭제 (구독자 목록)..."
        redis-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" KEYS "symbol:*:subscribers" | xargs -r redis-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" DEL
        
        echo "  - symbol:*:main 키 삭제 (메인 구독자)..."
        redis-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" KEYS "symbol:*:main" | xargs -r redis-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" DEL
        
        echo "  - symbol:*:sub 키 삭제 (서브 구독자)..."
        redis-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" KEYS "symbol:*:sub" | xargs -r redis-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" DEL
        
        echo "  - active:symbols 키 삭제 (활성 심볼 목록)..."
        redis-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" DEL "active:symbols"
        
        echo "=== [INIT] 초기화 완료! ==="
    else
        echo "  [WARN] redis-cli를 찾을 수 없습니다."
        echo "         redis-cli 설치 후 --init 옵션을 사용하세요."
    fi
fi

# ===== 의존성 확인 =====
if [ ! -d "node_modules" ]; then
    echo ""
    echo "=== 의존성 설치 중... ==="
    npm install
fi

# ===== 로그 로테이션 =====
LOG_FILE="${HOME}/streamer.log"
if [ -f "$LOG_FILE" ] && [ -s "$LOG_FILE" ]; then
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    BACKUP_FILE="${HOME}/streamer.${TIMESTAMP}.log"
    echo "=== 기존 로그 백업: ${BACKUP_FILE} ==="
    cp "$LOG_FILE" "$BACKUP_FILE"
    # 최근 5개만 유지
    ls -t ${HOME}/streamer.*.log 2>/dev/null | tail -n +6 | xargs -r rm -f
fi

# ===== 실행 =====
echo ""
echo "=== 스트리머 시작 ==="
echo "Started at: $(date -Iseconds)"
echo "=========================================="
node index.mjs
