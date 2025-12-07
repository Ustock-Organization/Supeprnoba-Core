#!/bin/bash
# Liquibook Matching Engine - EC2 실행 스크립트
# 사용법: ./run_engine.sh

set -e

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║     Liquibook Matching Engine - EC2 Run Script            ║"
echo "╚═══════════════════════════════════════════════════════════╝"

# ========================================
# 환경변수 설정
# ========================================
export VCPKG_ROOT=~/vcpkg
export PATH=$VCPKG_ROOT/downloads/tools/cmake-3.31.10-linux/cmake-3.31.10-linux-x86_64/bin:$PATH

# AWS 설정
export AWS_REGION="ap-northeast-2"

# MSK 브로커 (Plaintext 포트 9092)
export KAFKA_BROKERS="b-1.supernobamsk.c1dtdv.c3.kafka.ap-northeast-2.amazonaws.com:9092,b-2.supernobamsk.c1dtdv.c3.kafka.ap-northeast-2.amazonaws.com:9092,b-3.supernobamsk.c1dtdv.c3.kafka.ap-northeast-2.amazonaws.com:9092"

# ElastiCache Redis
export REDIS_HOST="master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com"
export REDIS_PORT="6379"

# 기타 설정
export GRPC_PORT="50051"
export LOG_LEVEL="DEBUG"

# Kafka 토픽
export KAFKA_ORDER_TOPIC="orders"
export KAFKA_FILLS_TOPIC="fills"
export KAFKA_TRADES_TOPIC="trades"
export KAFKA_DEPTH_TOPIC="depth"
export KAFKA_GROUP_ID="matching-engine"

# ========================================
# 경로 설정
# ========================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$HOME/liquibook"
WRAPPER_DIR="$REPO_ROOT/wrapper"
BUILD_DIR="$WRAPPER_DIR/build"

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
    cmake -B build -S . \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
fi

echo "  -> 컴파일..."
cmake --build build -j$(nproc)

# ========================================
# 설정 출력
# ========================================
echo ""
echo "[3/4] 현재 설정:"
echo "  - KAFKA_BROKERS: $KAFKA_BROKERS"
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
