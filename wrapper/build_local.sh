#!/bin/bash

# Supernoba Matching Engine - Local Build Script
# AWS 의존성 없이 Redis Pub/Sub만 사용

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build_local"
VCPKG_ROOT="${VCPKG_ROOT:-$HOME/vcpkg}"

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║    Supernoba Matching Engine - Local Build                ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

# vcpkg 확인
if [ ! -f "$VCPKG_ROOT/vcpkg" ]; then
    echo "ERROR: vcpkg not found at $VCPKG_ROOT"
    echo "Please set VCPKG_ROOT environment variable"
    exit 1
fi

# 의존성 설치 (없으면) - classic 모드로 설치
echo "[1/4] Checking dependencies..."
DEPS="grpc protobuf nlohmann-json hiredis openssl curl"
for dep in $DEPS; do
    if ! $VCPKG_ROOT/vcpkg list | grep -q "^$dep:"; then
        echo "Installing $dep..."
        $VCPKG_ROOT/vcpkg install $dep --classic
    fi
done

# 빌드 디렉토리 생성
echo "[2/4] Preparing build directory..."
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# CMake 설정
echo "[3/4] Configuring with CMake..."
cmake .. \
    -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
    -DCMAKE_BUILD_TYPE=Release \
    -DUSE_LOCAL=ON \
    -G "Unix Makefiles"

# 빌드
echo "[4/4] Building..."
make -j$(nproc)

echo ""
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║    Build Complete!                                        ║"
echo "╠═══════════════════════════════════════════════════════════╣"
echo "║    Binary: $BUILD_DIR/matching_engine_local               ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""
echo "Run with:"
echo "  REDIS_HOST=localhost REDIS_PORT=6379 ./matching_engine_local"
