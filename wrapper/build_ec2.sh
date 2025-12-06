#!/bin/bash
# Liquibook AWS Wrapper - EC2 Linux 빌드 스크립트
# Usage: ./build_ec2.sh

set -e

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║       Liquibook AWS Wrapper - EC2 Build Script            ║"
echo "╚═══════════════════════════════════════════════════════════╝"

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. 시스템 의존성 확인/설치
echo -e "${YELLOW}[1/5] Checking system dependencies...${NC}"

if command -v apt-get &> /dev/null; then
    # Ubuntu/Debian
    sudo apt-get update
    sudo apt-get install -y build-essential cmake git pkg-config curl zip unzip tar libcurl4-openssl-dev libssl-dev
elif command -v yum &> /dev/null; then
    # Amazon Linux/CentOS
    sudo yum groupinstall -y "Development Tools"
    sudo yum install -y cmake3 git pkgconfig curl zip unzip tar libcurl-devel openssl-devel
    # cmake3를 cmake로 링크
    if ! command -v cmake &> /dev/null; then
        sudo ln -sf /usr/bin/cmake3 /usr/bin/cmake
    fi
fi

echo -e "${GREEN}✓ System dependencies installed${NC}"

# 2. vcpkg 설치/업데이트
echo -e "${YELLOW}[2/5] Setting up vcpkg...${NC}"

VCPKG_ROOT="${HOME}/vcpkg"

if [ ! -d "$VCPKG_ROOT" ]; then
    git clone https://github.com/Microsoft/vcpkg.git "$VCPKG_ROOT"
    cd "$VCPKG_ROOT"
    ./bootstrap-vcpkg.sh
else
    cd "$VCPKG_ROOT"
    git pull
    ./bootstrap-vcpkg.sh
fi

# 환경변수 설정
export VCPKG_ROOT
export PATH="${VCPKG_ROOT}:${PATH}"

echo -e "${GREEN}✓ vcpkg ready at ${VCPKG_ROOT}${NC}"

# 3. 래퍼 의존성 설치
echo -e "${YELLOW}[3/5] Installing wrapper dependencies (this may take 10-15 minutes)...${NC}"

cd "$VCPKG_ROOT"
./vcpkg install librdkafka grpc protobuf nlohmann-json hiredis curl openssl

echo -e "${GREEN}✓ Dependencies installed${NC}"

# 4. 빌드
echo -e "${YELLOW}[4/5] Building matching engine...${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

cmake -B build -S . \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_TOOLCHAIN_FILE="${VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake"

cmake --build build --config Release -j$(nproc)

echo -e "${GREEN}✓ Build complete${NC}"

# 5. 결과 확인
echo -e "${YELLOW}[5/5] Verifying build...${NC}"

if [ -f "build/matching_engine" ]; then
    echo -e "${GREEN}✓ Binary created: build/matching_engine${NC}"
    ls -lh build/matching_engine
else
    echo -e "${RED}✗ Build failed - binary not found${NC}"
    exit 1
fi

echo ""
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║                    Build Complete!                         ║"
echo "╠═══════════════════════════════════════════════════════════╣"
echo "║ To run the matching engine:                                ║"
echo "║                                                            ║"
echo "║   export KAFKA_BROKERS=\"your-msk-broker:9092\"              ║"
echo "║   export REDIS_HOST=\"your-redis-host\"                      ║"
echo "║   ./build/matching_engine                                  ║"
echo "╚═══════════════════════════════════════════════════════════╝"
