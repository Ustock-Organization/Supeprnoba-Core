#!/bin/bash
# run_streamer.sh - Streaming Server 단일 실행 스크립트
# EC2에서 환경 설정 및 스트리머 실행
# 사용법:
#   ./run_streamer.sh           # 기본 모드
#   ./run_streamer.sh --debug   # 디버그 모드

set -e

# ===== 옵션 파싱 =====
DEBUG_MODE=false
for arg in "$@"; do
    case $arg in
        --debug)
            DEBUG_MODE=true
            ;;
    esac
done

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║     Liquibook Streaming Server                            ║"
echo "╚═══════════════════════════════════════════════════════════╝"

# ===== 환경변수 설정 =====
# Streamer는 Real-time Depth Cache 사용
export VALKEY_HOST="${VALKEY_HOST:-supernoba-depth-cache.5vrxzz.ng.0001.apn2.cache.amazonaws.com}"
export VALKEY_PORT="${VALKEY_PORT:-6379}"
export VALKEY_TLS="${VALKEY_TLS:-false}"
export WEBSOCKET_ENDPOINT="${WEBSOCKET_ENDPOINT:-l2ptm85wub.execute-api.ap-northeast-2.amazonaws.com/production}"
export AWS_REGION="${AWS_REGION:-ap-northeast-2}"
export DEBUG_MODE="$DEBUG_MODE"

echo ""
echo "=== 환경 설정 ==="
echo "VALKEY_HOST: $VALKEY_HOST"
echo "VALKEY_PORT: $VALKEY_PORT"
echo "VALKEY_TLS: $VALKEY_TLS"
echo "WEBSOCKET_ENDPOINT: $WEBSOCKET_ENDPOINT"
echo "DEBUG_MODE: $DEBUG_MODE"
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
