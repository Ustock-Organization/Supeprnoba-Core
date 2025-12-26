#!/bin/bash
# Candle Aggregator - EC2 실행 스크립트 (RDS PostgreSQL)
# 사용법: 
#   ./run_aggregator.sh           # 기본 실행
#   ./run_aggregator.sh --dev     # Valkey 캐시 초기화 후 시작
#   ./run_aggregator.sh --debug   # 디버그 로그 레벨

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
echo "║     Candle Aggregator - RDS PostgreSQL                    ║"
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

# ElastiCache Valkey (Depth 캐시)
export VALKEY_HOST="supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com"
export VALKEY_PORT="6379"

# RDS PostgreSQL
export RDS_HOST="supernoba-rdb1.cluster-cyxfcbnpfoci.ap-northeast-2.rds.amazonaws.com"
export RDS_PORT="5432"
export RDS_DBNAME="postgres"
# RDS 자격 증명 (Secrets Manager에서 가져오거나 환경변수로 설정)
# 실제 배포 시 aws secretsmanager get-secret-value 사용 권장
export RDS_USER="${RDS_USER:-postgres}"
export RDS_PASSWORD="${RDS_PASSWORD:-}"

# 폴링 간격 (ms)
export POLL_INTERVAL_MS="10"

# 로그 레벨
if [ "$DEBUG_MODE" == "true" ]; then
    export LOG_LEVEL="DEBUG"
else
    export LOG_LEVEL="INFO"
fi

# ========================================
# 경로 설정 (스크립트 위치 기반으로 자동 설정)
# ========================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGGREGATOR_DIR="$SCRIPT_DIR"
REPO_ROOT="$(dirname "$AGGREGATOR_DIR")"
BUILD_DIR="$AGGREGATOR_DIR/build"

# ========================================
# 빌드
# ========================================
echo ""
echo "[1/3] 빌드 중..."
cd "$AGGREGATOR_DIR"

# 기존 빌드 디렉토리가 AWS SDK 기반이면 삭제
if [ -d "$BUILD_DIR" ] && grep -q "AWSSDK" "$BUILD_DIR/CMakeCache.txt" 2>/dev/null; then
    echo "  -> 이전 AWS SDK 빌드 제거 중..."
    rm -rf "$BUILD_DIR"
fi

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
echo "  - VALKEY_HOST: $VALKEY_HOST"
echo "  - RDS_HOST: $RDS_HOST"
echo "  - RDS_DBNAME: $RDS_DBNAME"
echo "  - POLL_INTERVAL: ${POLL_INTERVAL_MS}ms"
echo "  - LOG_LEVEL: $LOG_LEVEL"
echo "  - DEV_MODE: $DEV_MODE"

# ========================================
# DEV 모드: Redis 캐시 초기화
# ========================================
if [ "$DEV_MODE" == "true" ]; then
    echo ""
    echo "[DEV] closed 캔들 리스트 초기화 중..."
    
    redis-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" KEYS "candle:closed:*" | while read key; do
        redis-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" DEL "$key"
    done || echo "  [WARN] 캐시 초기화 실패"
    
    echo "[DEV] 캐시 초기화 완료!"
fi

# ========================================
# 실행
# ========================================
echo ""
echo "[3/3] Candle Aggregator 시작..."
echo "=========================================="
cd "$BUILD_DIR"
./candle_aggregator
