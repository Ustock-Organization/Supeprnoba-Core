#!/bin/bash
# Liquibook Matching Engine - EC2 실행 스크립트
# 사용법: 
#   ./run_engine.sh           # 기본 실행
#   ./run_engine.sh --dev     # Redis 캐시 초기화 후 시작
#   ./run_engine.sh --debug   # 디버그 로그 레벨
#   ./run_engine.sh --dev --debug  # 복합 사용 가능

set -e

# ========================================
# 옵션 파싱
# ========================================
DEBUG_MODE=false
DEV_MODE=false

for arg in "$@"; do
    case $arg in
        --debug)
            DEBUG_MODE=true
            ;;
        --dev)
            DEV_MODE=true
            ;;
    esac
done

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║     Liquibook Matching Engine - Kinesis                   ║"
if [ "$DEV_MODE" == "true" ]; then
    echo "║                    [DEV MODE - Cache Clear]               ║"
fi
if [ "$DEBUG_MODE" == "true" ]; then
    echo "║                    [DEBUG MODE]                           ║"
fi
echo "╚═══════════════════════════════════════════════════════════╝"

# ========================================
# 환경변수 설정
# ========================================
export VCPKG_ROOT=~/vcpkg
export PATH=$VCPKG_ROOT/downloads/tools/cmake-3.31.10-linux/cmake-3.31.10-linux-x86_64/bin:$PATH

# AWS 설정
export AWS_REGION="ap-northeast-2"

# ElastiCache Redis/Valkey (스냅샷 백업용)
export REDIS_HOST="master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com"
export REDIS_PORT="6379"

# Depth 캐시 (실시간 호가용)
export DEPTH_CACHE_HOST="supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com"
export DEPTH_CACHE_PORT="6379"

# Kinesis 스트림
export KINESIS_ORDERS_STREAM="supernoba-orders"
export KINESIS_FILLS_STREAM="supernoba-fills"
export KINESIS_TRADES_STREAM="supernoba-trades"
export KINESIS_DEPTH_STREAM="supernoba-depth"
export KINESIS_STATUS_STREAM="supernoba-order-status"

# DynamoDB
export DYNAMODB_TRADE_TABLE="trade_history"

# WebSocket 직접 알림 (API Gateway)
export WEBSOCKET_ENDPOINT="wss://l2ptm85wub.execute-api.ap-northeast-2.amazonaws.com/production/"

# 기타 설정
export GRPC_PORT="50051"
if [ "$DEBUG_MODE" == "true" ]; then
    export LOG_LEVEL="DEBUG"
else
    export LOG_LEVEL="INFO"
fi

# ========================================
# 경로 설정
# ========================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$HOME/liquibook"
WRAPPER_DIR="$REPO_ROOT/wrapper"
BUILD_DIR="$WRAPPER_DIR/build"

# ========================================
# 빌드
# ========================================
echo ""
echo "[1/3] 빌드 중..."
cd "$WRAPPER_DIR"

if [ ! -d "$BUILD_DIR" ]; then
    echo "  -> CMake 설정..."
    cmake -B "$BUILD_DIR" -S . \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
fi

echo "  -> 컴파일..."
cmake --build "$BUILD_DIR" -j$(nproc)

# ========================================
# 설정 출력
# ========================================
echo ""
echo "[2/3] 현재 설정:"
echo "  - KINESIS_ORDERS: $KINESIS_ORDERS_STREAM"
echo "  - KINESIS_FILLS: $KINESIS_FILLS_STREAM"
echo "  - DYNAMODB_TABLE: $DYNAMODB_TRADE_TABLE"
echo "  - REDIS_HOST: $REDIS_HOST"
echo "  - DEPTH_CACHE: $DEPTH_CACHE_HOST"
echo "  - LOG_LEVEL: $LOG_LEVEL"
echo "  - DEV_MODE: $DEV_MODE"

# ========================================
# DEV 모드: Redis 캐시 초기화
# ========================================
if [ "$DEV_MODE" == "true" ]; then
    echo ""
    echo "[DEV] Redis 캐시 초기화 중..."
    
    echo "  - Depth 캐시 초기화..."
    redis-cli -h "$DEPTH_CACHE_HOST" -p "$DEPTH_CACHE_PORT" FLUSHDB || echo "  [WARN] Depth 캐시 초기화 실패"
    
    echo "  - Backup 캐시 초기화..."
    redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" FLUSHDB || echo "  [WARN] Backup 캐시 초기화 실패"
    
    echo "[DEV] 캐시 초기화 완료!"
fi

# ========================================
# 실행
# ========================================
echo ""
echo "[3/3] 매칭 엔진 시작..."
echo "=========================================="
cd "$BUILD_DIR"
./matching_engine
