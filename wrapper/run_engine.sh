#!/bin/bash
# Liquibook Matching Engine - EC2 실행 스크립트
# 사용법: 
#   ./run_engine.sh           # Kinesis 모드 (기본)
#   ./run_engine.sh --kafka   # Kafka 모드

set -e

# ========================================
# 모드 선택 (기본값: Kinesis)
# ========================================
USE_KINESIS=true
if [ "$1" == "--kafka" ]; then
    USE_KINESIS=false
fi

if [ "$USE_KINESIS" == "true" ]; then
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║     Liquibook Matching Engine - KINESIS Mode              ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
else
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║     Liquibook Matching Engine - KAFKA Mode                ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
fi

# ========================================
# 환경변수 설정
# ========================================
export VCPKG_ROOT=~/vcpkg
export PATH=$VCPKG_ROOT/downloads/tools/cmake-3.31.10-linux/cmake-3.31.10-linux-x86_64/bin:$PATH

# AWS 설정
export AWS_REGION="ap-northeast-2"

# ElastiCache Redis/Valkey
export REDIS_HOST="master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com"
export REDIS_PORT="6379"

# 기타 설정
export GRPC_PORT="50051"
export LOG_LEVEL="DEBUG"

if [ "$USE_KINESIS" == "true" ]; then
    # ========= Kinesis 환경변수 =========
    export KINESIS_ORDERS_STREAM="supernoba-orders"
    export KINESIS_FILLS_STREAM="supernoba-fills"
    export KINESIS_TRADES_STREAM="supernoba-trades"
    export KINESIS_DEPTH_STREAM="supernoba-depth"
    export KINESIS_STATUS_STREAM="supernoba-order-status"
else
    # ========= Kafka/MSK 환경변수 =========
    export KAFKA_BROKERS="b-1.supernobamskpipe.qhwtla.c3.kafka.ap-northeast-2.amazonaws.com:9092,b-2.supernobamskpipe.qhwtla.c3.kafka.ap-northeast-2.amazonaws.com:9092,b-3.supernobamskpipe.qhwtla.c3.kafka.ap-northeast-2.amazonaws.com:9092"
    export KAFKA_ORDER_TOPIC="orders"
    export KAFKA_FILLS_TOPIC="fills"
    export KAFKA_TRADES_TOPIC="trades"
    export KAFKA_DEPTH_TOPIC="depth"
    export KAFKA_GROUP_ID="matching-engine"
fi

# ========================================
# 경로 설정
# ========================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$HOME/liquibook"
WRAPPER_DIR="$REPO_ROOT/wrapper"

if [ "$USE_KINESIS" == "true" ]; then
    BUILD_DIR="$WRAPPER_DIR/build_kinesis"
else
    BUILD_DIR="$WRAPPER_DIR/build"
fi

# ========================================
# Git 업데이트
# ========================================
echo ""
echo "[1/4] Git 업데이트 중..."
cd "$REPO_ROOT"
git stash 2>/dev/null || true
git pull origin AWSwrapper

# ========================================
# 빌드
# ========================================
echo ""
echo "[2/4] 빌드 중..."
cd "$WRAPPER_DIR"

if [ ! -d "$BUILD_DIR" ]; then
    echo "  -> CMake 설정..."
    if [ "$USE_KINESIS" == "true" ]; then
        cmake -B "$BUILD_DIR" -S . \
            -DCMAKE_BUILD_TYPE=Release \
            -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake \
            -DUSE_KINESIS=ON
    else
        cmake -B "$BUILD_DIR" -S . \
            -DCMAKE_BUILD_TYPE=Release \
            -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
    fi
fi

echo "  -> 컴파일..."
cmake --build "$BUILD_DIR" -j$(nproc)

# ========================================
# 설정 출력
# ========================================
echo ""
echo "[3/4] 현재 설정:"
if [ "$USE_KINESIS" == "true" ]; then
    echo "  - MODE: Kinesis"
    echo "  - KINESIS_ORDERS_STREAM: $KINESIS_ORDERS_STREAM"
    echo "  - KINESIS_FILLS_STREAM: $KINESIS_FILLS_STREAM"
    echo "  - KINESIS_DEPTH_STREAM: $KINESIS_DEPTH_STREAM"
else
    echo "  - MODE: Kafka/MSK"
    echo "  - KAFKA_BROKERS: ${KAFKA_BROKERS:0:50}..."
fi
echo "  - REDIS_HOST: $REDIS_HOST"
echo "  - AWS_REGION: $AWS_REGION"
echo "  - LOG_LEVEL: $LOG_LEVEL"

# ========================================
# 실행
# ========================================
echo ""
echo "[4/4] 매칭 엔진 시작..."
echo "=========================================="
cd "$BUILD_DIR"
./matching_engine

