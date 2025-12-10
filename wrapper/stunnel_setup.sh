#!/bin/bash
# stunnel_setup.sh - EC2에서 stunnel을 설정하여 C++ 엔진이 TLS Redis에 연결할 수 있도록 함
# 사용법: sudo ./stunnel_setup.sh

set -e

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║     Stunnel Setup for ElastiCache Serverless (TLS)        ║"
echo "╚═══════════════════════════════════════════════════════════╝"

# ========================================
# 1. stunnel 설치
# ========================================
echo ""
echo "[1/4] Installing stunnel..."
if ! command -v stunnel &> /dev/null; then
    sudo yum install -y stunnel || sudo apt-get install -y stunnel4
else
    echo "  -> stunnel already installed"
fi

# ========================================
# 2. stunnel 설정 파일 생성
# ========================================
echo ""
echo "[2/4] Creating stunnel configuration..."

STUNNEL_CONF="/etc/stunnel/redis-depth.conf"
DEPTH_CACHE_HOST="supernoba-depth-cache-5vrxzz.serverless.apn2.cache.amazonaws.com"
DEPTH_CACHE_PORT="6379"
LOCAL_PORT="6380"

sudo mkdir -p /etc/stunnel

sudo tee $STUNNEL_CONF > /dev/null << EOF
# Stunnel configuration for ElastiCache Serverless (TLS)
# C++ Engine connects to localhost:$LOCAL_PORT -> tunnel -> $DEPTH_CACHE_HOST:$DEPTH_CACHE_PORT (TLS)

pid = /var/run/stunnel-redis-depth.pid
setuid = nobody
setgid = nobody

[redis-depth]
client = yes
accept = 127.0.0.1:$LOCAL_PORT
connect = $DEPTH_CACHE_HOST:$DEPTH_CACHE_PORT
# TLS 설정
sslVersion = TLSv1.2
options = NO_SSLv2
options = NO_SSLv3
EOF

echo "  -> Configuration saved to $STUNNEL_CONF"

# ========================================
# 3. stunnel 서비스 시작
# ========================================
echo ""
echo "[3/4] Starting stunnel..."

# 기존 프로세스 종료 (있으면)
sudo pkill -f "stunnel $STUNNEL_CONF" 2>/dev/null || true
sleep 1

# stunnel 시작
sudo stunnel $STUNNEL_CONF
sleep 1

# 확인
if netstat -tlnp 2>/dev/null | grep -q ":$LOCAL_PORT" || ss -tlnp | grep -q ":$LOCAL_PORT"; then
    echo "  -> ✅ stunnel is running on localhost:$LOCAL_PORT"
else
    echo "  -> ❌ Failed to start stunnel. Check logs: /var/log/stunnel.log"
    exit 1
fi

# ========================================
# 4. 테스트
# ========================================
echo ""
echo "[4/4] Testing connection..."
if command -v redis-cli &> /dev/null; then
    if redis-cli -h 127.0.0.1 -p $LOCAL_PORT PING 2>/dev/null | grep -q "PONG"; then
        echo "  -> ✅ Connection to Depth Cache via stunnel: SUCCESS"
    else
        echo "  -> ⚠️ PING failed (might need VPC/Security Group check)"
    fi
else
    echo "  -> redis-cli not found, skipping test"
fi

# ========================================
# 완료
# ========================================
echo ""
echo "==========================================="
echo "✅ Stunnel setup complete!"
echo ""
echo "C++ Engine 환경변수 설정:"
echo "  export DEPTH_CACHE_HOST=127.0.0.1"
echo "  export DEPTH_CACHE_PORT=$LOCAL_PORT"
echo ""
echo "또는 run_engine.sh에서 자동 감지하도록 설정됨."
echo "==========================================="
