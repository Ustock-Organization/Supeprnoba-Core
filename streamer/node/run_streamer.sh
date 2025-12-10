#!/bin/bash
# run_streamer.sh - Streaming Server 단일 실행 스크립트
# EC2에서 환경 설정 및 스트리머 실행

set -e

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║     Liquibook Streaming Server                            ║"
echo "╚═══════════════════════════════════════════════════════════╝"

# ===== 환경변수 설정 =====
export VALKEY_HOST="${VALKEY_HOST:-master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com}"
export VALKEY_PORT="${VALKEY_PORT:-6379}"
export WEBSOCKET_ENDPOINT="${WEBSOCKET_ENDPOINT:-xxxxxxxxxx.execute-api.ap-northeast-2.amazonaws.com/production}"
export AWS_REGION="${AWS_REGION:-ap-northeast-2}"

echo ""
echo "=== 환경 설정 ==="
echo "VALKEY_HOST: $VALKEY_HOST"
echo "VALKEY_PORT: $VALKEY_PORT"
echo "WEBSOCKET_ENDPOINT: $WEBSOCKET_ENDPOINT"
echo "AWS_REGION: $AWS_REGION"

# ===== 경로 설정 =====
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ===== 의존성 확인 =====
if [ ! -d "node_modules" ]; then
    echo ""
    echo "=== 의존성 설치 중... ==="
    npm install
fi

# ===== 실행 =====
echo ""
echo "=== 스트리머 시작 ==="
echo "=========================================="
node index.mjs
