#!/bin/bash
#
# Supernoba Market Maker Service 실행 스크립트
# 배포 인스턴스: server (stock-bastion)
#
# 사용법:
#   ./run_mm.sh          # 일반 실행
#   ./run_mm.sh --debug  # 디버그 모드
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 환경 변수 설정
export AWS_REGION="${AWS_REGION:-ap-northeast-2}"
export OPERATING_CACHE_HOST="${OPERATING_CACHE_HOST:-${BACKUP_CACHE_HOST:-master.supernobaorderbookbackupcache.5vrxzz.apn2.cache.amazonaws.com}}"
export OPERATING_CACHE_PORT="${OPERATING_CACHE_PORT:-${BACKUP_CACHE_PORT:-6379}}"
export KINESIS_STREAM="${KINESIS_STREAM:-supernoba-orders}"

# 로그 디렉토리 설정
LOG_DIR="${HOME}/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/mm-service.log"

echo "=== Supernoba Market Maker Service ==="
echo "Working Directory: $SCRIPT_DIR"
echo "Log File: $LOG_FILE"
echo "AWS Region: $AWS_REGION"
echo "Operating Cache: $OPERATING_CACHE_HOST:$OPERATING_CACHE_PORT"
echo "Kinesis Stream: $KINESIS_STREAM"
echo ""

# 의존성 확인
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# 디버그 모드 확인
if [ "$1" == "--debug" ]; then
    echo "Starting in DEBUG mode (foreground)..."
    node index.mjs
else
    echo "Starting in BACKGROUND mode..."
    nohup node index.mjs >> "$LOG_FILE" 2>&1 &

    PID=$!
    echo "Started with PID: $PID"
    echo "$PID" > "${LOG_DIR}/mm-service.pid"

    # 시작 확인
    sleep 2
    if ps -p $PID > /dev/null 2>&1; then
        echo "Market Maker Service is running."
        echo ""
        echo "Commands:"
        echo "  tail -f $LOG_FILE         # 로그 확인"
        echo "  kill \$(cat ${LOG_DIR}/mm-service.pid)  # 프로세스 종료"
    else
        echo "ERROR: Failed to start Market Maker Service"
        echo "Check logs: $LOG_FILE"
        exit 1
    fi
fi
