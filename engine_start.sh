#!/bin/bash
# engine_start.sh - 매칭 엔진 및 스트리머 통합 시작 스크립트
# 사용법: ./engine_start.sh [--build] [--streamer]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Liquibook Engine Startup ===${NC}"

# ===== 환경변수 로드 =====
if [ -f .env ]; then
    echo -e "${YELLOW}Loading .env file...${NC}"
    export $(cat .env | grep -v '^#' | xargs)
fi

# 기본값 설정
export AWS_REGION="${AWS_REGION:-ap-northeast-2}"
export VALKEY_HOST="${VALKEY_HOST:-localhost}"
export VALKEY_PORT="${VALKEY_PORT:-6379}"
export KINESIS_ORDERS="${KINESIS_ORDERS:-supernoba-orders}"
export KINESIS_FILLS="${KINESIS_FILLS:-supernoba-fills}"
export KINESIS_STATUS="${KINESIS_STATUS:-supernoba-order-status}"
export WEBSOCKET_ENDPOINT="${WEBSOCKET_ENDPOINT}"

echo "AWS_REGION: $AWS_REGION"
echo "VALKEY_HOST: $VALKEY_HOST"
echo "KINESIS_ORDERS: $KINESIS_ORDERS"
echo "WEBSOCKET_ENDPOINT: $WEBSOCKET_ENDPOINT"

# ===== 옵션 파싱 =====
BUILD=false
STREAMER=false

for arg in "$@"; do
    case $arg in
        --build)
            BUILD=true
            shift
            ;;
        --streamer)
            STREAMER=true
            shift
            ;;
        --help)
            echo "Usage: $0 [--build] [--streamer]"
            echo "  --build     Rebuild matching engine before starting"
            echo "  --streamer  Also start the Node.js streaming server"
            exit 0
            ;;
    esac
done

# ===== 빌드 (선택) =====
if [ "$BUILD" = true ]; then
    echo -e "${YELLOW}Building matching engine...${NC}"
    cd wrapper
    
    if [ ! -d build ]; then
        mkdir build
    fi
    cd build
    
    cmake .. -DUSE_KINESIS=ON
    make -j$(nproc)
    
    cd "$SCRIPT_DIR"
    echo -e "${GREEN}Build complete${NC}"
fi

# ===== 매칭 엔진 시작 =====
echo -e "${YELLOW}Starting matching engine...${NC}"

# 기존 프로세스 종료
pkill -f matching_engine 2>/dev/null || true

# 엔진 실행
cd wrapper/build
./matching_engine &
ENGINE_PID=$!
echo -e "${GREEN}Matching engine started (PID: $ENGINE_PID)${NC}"

cd "$SCRIPT_DIR"

# ===== 스트리머 시작 (선택) =====
if [ "$STREAMER" = true ]; then
    echo -e "${YELLOW}Starting streaming server...${NC}"
    
    cd streamer/node
    
    # 의존성 설치 (필요시)
    if [ ! -d node_modules ]; then
        echo "Installing dependencies..."
        npm install
    fi
    
    # 스트리머 실행
    node index.mjs &
    STREAMER_PID=$!
    echo -e "${GREEN}Streaming server started (PID: $STREAMER_PID)${NC}"
    
    cd "$SCRIPT_DIR"
fi

# ===== 상태 출력 =====
echo ""
echo -e "${GREEN}=== All services started ===${NC}"
echo "Engine PID: $ENGINE_PID"
[ "$STREAMER" = true ] && echo "Streamer PID: $STREAMER_PID"
echo ""
echo "To stop all services:"
echo "  pkill -f matching_engine"
[ "$STREAMER" = true ] && echo "  pkill -f 'node index.mjs'"

# 프로세스 대기
wait $ENGINE_PID
