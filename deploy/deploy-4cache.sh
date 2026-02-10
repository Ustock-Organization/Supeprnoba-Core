#!/bin/bash
#
# 4-Cache Architecture Deployment Script
#
# 로컬(WSL)에서 실행하여 EC2에 4-Cache 아키텍처를 배포합니다.
# 기존 배포 스크립트(install-services.sh, supernoba-ctl.sh)를 활용합니다.
#
# 수행 역할:
#   Phase 1: SCP - 수정된 소스/설정 파일을 EC2로 전송
#   Phase 2: Stop - 전체 서비스 중지
#   Phase 3: Migrate - Redis 키를 올바른 캐시 포트로 이동
#   Phase 4: Build - Engine(C++) + Aggregator(C++) cmake 빌드
#   Phase 5: Install - systemd 서비스 파일 + logrotate 설정 설치
#   Phase 6: Start - 전체 서비스 시작
#   Phase 7: Verify - E2E 검증
#
# 사용법:
#   bash deploy-4cache.sh [phase]
#   bash deploy-4cache.sh          # 전체 실행
#   bash deploy-4cache.sh scp      # SCP만 실행
#   bash deploy-4cache.sh build    # 빌드만 실행
#   bash deploy-4cache.sh verify   # 검증만 실행
#

set -e

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_phase() { echo -e "\n${CYAN}========== $1 ==========${NC}\n"; }

# SSH/SCP 설정
EC2_HOST="server"  # ~/.ssh/config alias
EC2_USER="ec2-user"
REMOTE_CORE="~/Supernoba-Core_Old"
REMOTE_BACK="~/Supernoba-back"

# 로컬 경로
LOCAL_BASE="/mnt/c/develop/Supernoba-Core_Old"
LOCAL_BACK="/mnt/c/develop/Supernoba-back"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# SSH 명령 wrapper
run_ssh() {
    ssh -o ConnectTimeout=10 "$EC2_HOST" "$@"
}

#===== Phase 1: SCP 전송 =====
phase_scp() {
    log_phase "Phase 1: SCP Transfer"

    # --- Engine C++ (7 files) ---
    log_info "Uploading Engine C++ files..."
    scp "$LOCAL_BASE/wrapper/src/main.cpp" \
        "$EC2_HOST:$REMOTE_CORE/wrapper/src/main.cpp"
    scp "$LOCAL_BASE/wrapper/include/market_data_handler.h" \
        "$EC2_HOST:$REMOTE_CORE/wrapper/include/market_data_handler.h"
    scp "$LOCAL_BASE/wrapper/src/market_data_handler.cpp" \
        "$EC2_HOST:$REMOTE_CORE/wrapper/src/market_data_handler.cpp"
    scp "$LOCAL_BASE/wrapper/include/engine_core.h" \
        "$EC2_HOST:$REMOTE_CORE/wrapper/include/engine_core.h"
    scp "$LOCAL_BASE/wrapper/src/engine_core.cpp" \
        "$EC2_HOST:$REMOTE_CORE/wrapper/src/engine_core.cpp"
    scp "$LOCAL_BASE/wrapper/include/ranking_manager.h" \
        "$EC2_HOST:$REMOTE_CORE/wrapper/include/ranking_manager.h"
    scp "$LOCAL_BASE/wrapper/src/ranking_manager.cpp" \
        "$EC2_HOST:$REMOTE_CORE/wrapper/src/ranking_manager.cpp"
    log_success "Engine: 7 files uploaded"

    # --- Aggregator C++ (3 files) ---
    log_info "Uploading Aggregator C++ files..."
    scp "$LOCAL_BASE/aggregator/include/config.h" \
        "$EC2_HOST:$REMOTE_CORE/aggregator/include/config.h"
    scp "$LOCAL_BASE/aggregator/src/config.cpp" \
        "$EC2_HOST:$REMOTE_CORE/aggregator/src/config.cpp"
    scp "$LOCAL_BASE/aggregator/src/main.cpp" \
        "$EC2_HOST:$REMOTE_CORE/aggregator/src/main.cpp"
    log_success "Aggregator: 3 files uploaded"

    # --- Streamer (1 file) ---
    log_info "Uploading Streamer..."
    scp "$LOCAL_BASE/streamer/node/index.mjs" \
        "$EC2_HOST:$REMOTE_CORE/streamer/node/index.mjs"
    log_success "Streamer: 1 file uploaded"

    # --- MM Service (1 file) ---
    log_info "Uploading MM Service..."
    scp "$LOCAL_BASE/mm-service/index.mjs" \
        "$EC2_HOST:$REMOTE_CORE/mm-service/index.mjs"
    log_success "MM Service: 1 file uploaded"

    # --- Deploy scripts & env ---
    log_info "Uploading deploy scripts and env files..."
    scp "$LOCAL_BASE/deploy/supernoba-ctl.sh" \
        "$EC2_HOST:$REMOTE_CORE/deploy/supernoba-ctl.sh"
    scp "$LOCAL_BASE/deploy/migrate-4cache.sh" \
        "$EC2_HOST:$REMOTE_CORE/deploy/migrate-4cache.sh"
    scp "$LOCAL_BASE/deploy/install-services.sh" \
        "$EC2_HOST:$REMOTE_CORE/deploy/install-services.sh"

    # env 파일은 전체 덮어쓰기 (EC2에서 common.env의 ElastiCache 주소는 서비스별 env에서 127.0.0.1로 오버라이드됨)
    scp "$LOCAL_BASE/deploy/env/engine.env" \
        "$EC2_HOST:$REMOTE_CORE/deploy/env/engine.env"
    scp "$LOCAL_BASE/deploy/env/streamer.env" \
        "$EC2_HOST:$REMOTE_CORE/deploy/env/streamer.env"
    scp "$LOCAL_BASE/deploy/env/aggregator.env" \
        "$EC2_HOST:$REMOTE_CORE/deploy/env/aggregator.env"
    scp "$LOCAL_BASE/deploy/env/mm-service.env" \
        "$EC2_HOST:$REMOTE_CORE/deploy/env/mm-service.env"
    log_success "Deploy scripts + env: uploaded"

    # --- common.env는 sed로 포트 변수만 추가 (HOST 덮어쓰기 방지) ---
    log_info "Updating common.env on EC2 (sed - PORT variables only)..."
    run_ssh << 'REMOTE_SCRIPT'
cd ~/Supernoba-Core_Old/deploy/env

# 이미 4-Cache 포트 설정이 있는지 확인
if grep -q "CANDLE_CACHE_PORT" common.env; then
    echo "  common.env already has 4-Cache ports"
else
    echo "" >> common.env
    echo "# === 4-Cache Port Configuration ===" >> common.env
    echo "DEPTH_CACHE_PORT=6379" >> common.env
    echo "CANDLE_CACHE_PORT=6380" >> common.env
    echo "BACKUP_CACHE_PORT=6381" >> common.env
    echo "OPERATING_CACHE_PORT=6382" >> common.env
    echo "OPERATING_CACHE_HOST=127.0.0.1" >> common.env
    echo "CANDLE_CACHE_HOST=127.0.0.1" >> common.env
    echo "  common.env: 4-Cache ports added"
fi
REMOTE_SCRIPT
    log_success "common.env updated on EC2"

    # --- Logrotate configs ---
    log_info "Uploading logrotate configs..."
    scp "$LOCAL_BASE/deploy/logrotate/supernoba-engine" \
        "$EC2_HOST:$REMOTE_CORE/deploy/logrotate/supernoba-engine"
    scp "$LOCAL_BASE/deploy/logrotate/supernoba-streamer" \
        "$EC2_HOST:$REMOTE_CORE/deploy/logrotate/supernoba-streamer"
    scp "$LOCAL_BASE/deploy/logrotate/supernoba-mm" \
        "$EC2_HOST:$REMOTE_CORE/deploy/logrotate/supernoba-mm"
    scp "$LOCAL_BASE/deploy/logrotate/supernoba-aggregator" \
        "$EC2_HOST:$REMOTE_CORE/deploy/logrotate/supernoba-aggregator"
    scp "$LOCAL_BASE/deploy/logrotate/install-logrotate.sh" \
        "$EC2_HOST:$REMOTE_CORE/deploy/logrotate/install-logrotate.sh"
    log_success "Logrotate: 5 files uploaded"

    # --- Systemd service files ---
    log_info "Uploading systemd service files..."
    scp "$LOCAL_BASE/deploy/systemd/supernoba-engine.service" \
        "$EC2_HOST:$REMOTE_CORE/deploy/systemd/supernoba-engine.service"
    scp "$LOCAL_BASE/deploy/systemd/supernoba-streamer.service" \
        "$EC2_HOST:$REMOTE_CORE/deploy/systemd/supernoba-streamer.service"
    scp "$LOCAL_BASE/deploy/systemd/supernoba-mm.service" \
        "$EC2_HOST:$REMOTE_CORE/deploy/systemd/supernoba-mm.service"
    scp "$LOCAL_BASE/deploy/systemd/supernoba-aggregator.service" \
        "$EC2_HOST:$REMOTE_CORE/deploy/systemd/supernoba-aggregator.service"
    log_success "Systemd: 4 files uploaded"

    # --- Processor (Supernoba-back) ---
    log_info "Uploading Processor run_processor.sh..."
    scp "$LOCAL_BACK/run_processor.sh" \
        "$EC2_HOST:$REMOTE_BACK/run_processor.sh"
    log_success "Processor: 1 file uploaded"

    echo ""
    log_success "Phase 1 complete: 28 files transferred"
}

#===== Phase 2: Stop Services =====
phase_stop() {
    log_phase "Phase 2: Stop All Services"

    run_ssh << 'REMOTE_SCRIPT'
cd ~/Supernoba-Core_Old/deploy
chmod +x supernoba-ctl.sh

echo "Stopping all services..."
./supernoba-ctl.sh stop all 2>/dev/null || true

# Processor도 중지
echo "Stopping processor..."
sudo systemctl stop supernoba-processor 2>/dev/null || true

# 모든 서비스 상태 확인
sleep 2
echo ""
echo "Service status after stop:"
for svc in supernoba-engine supernoba-streamer supernoba-mm supernoba-aggregator supernoba-processor; do
    if systemctl is-active --quiet "$svc" 2>/dev/null; then
        echo "  [STILL RUNNING] $svc"
    else
        echo "  [STOPPED] $svc"
    fi
done
REMOTE_SCRIPT

    log_success "Phase 2 complete: All services stopped"
}

#===== Phase 3: Data Migration =====
phase_migrate() {
    log_phase "Phase 3: Data Migration (4-Cache)"

    run_ssh << 'REMOTE_SCRIPT'
cd ~/Supernoba-Core_Old/deploy
chmod +x migrate-4cache.sh

echo "Checking Redis instances..."
for port in 6379 6380 6381 6382; do
    dbsize=$(redis-cli -p $port DBSIZE 2>/dev/null || echo "UNREACHABLE")
    echo "  Port $port: $dbsize"
done

echo ""
echo "Running migration..."
bash migrate-4cache.sh
REMOTE_SCRIPT

    log_success "Phase 3 complete: Data migrated to 4 caches"
}

#===== Phase 4: Build =====
phase_build() {
    log_phase "Phase 4: Build (Engine + Aggregator)"

    log_info "Building Engine (cmake incremental)..."
    run_ssh << 'REMOTE_SCRIPT'
cd ~/Supernoba-Core_Old/wrapper

if [ ! -d "build" ]; then
    echo "First build - running cmake configure..."
    cmake -B build -S . \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_TOOLCHAIN_FILE=$HOME/vcpkg/scripts/buildsystems/vcpkg.cmake
fi

echo "Building matching_engine..."
cmake --build build -j$(nproc)
echo "Engine build complete"

# vcpkg 빌드 아티팩트 정리
if [ -d "$HOME/vcpkg/buildtrees" ]; then
    rm -rf "$HOME/vcpkg/buildtrees"/* 2>/dev/null || true
    echo "vcpkg buildtrees cleaned"
fi
REMOTE_SCRIPT
    log_success "Engine built"

    log_info "Building Aggregator (cmake incremental)..."
    run_ssh << 'REMOTE_SCRIPT'
cd ~/Supernoba-Core_Old/aggregator

if [ ! -d "build" ]; then
    echo "First build - running cmake configure..."
    cmake -B build -S . \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_TOOLCHAIN_FILE=$HOME/vcpkg/scripts/buildsystems/vcpkg.cmake
fi

echo "Building candle_aggregator..."
cmake --build build -j$(nproc)
echo "Aggregator build complete"

# vcpkg 빌드 아티팩트 정리
if [ -d "$HOME/vcpkg/buildtrees" ]; then
    rm -rf "$HOME/vcpkg/buildtrees"/* 2>/dev/null || true
    echo "vcpkg buildtrees cleaned"
fi
REMOTE_SCRIPT
    log_success "Aggregator built"

    log_success "Phase 4 complete: Both C++ services built"
}

#===== Phase 5: Install (systemd + logrotate) =====
phase_install() {
    log_phase "Phase 5: Install (systemd + logrotate)"

    run_ssh << 'REMOTE_SCRIPT'
cd ~/Supernoba-Core_Old/deploy

# install-services.sh 실행 (systemd + logrotate + disk monitoring)
chmod +x install-services.sh
chmod +x logrotate/install-logrotate.sh
sudo bash install-services.sh

# supernoba-ctl.sh 실행 권한
chmod +x supernoba-ctl.sh
chmod +x migrate-4cache.sh

echo ""
echo "Verifying logrotate installation..."
for svc in engine streamer mm aggregator; do
    if [ -f "/etc/logrotate.d/supernoba-$svc" ]; then
        echo "  [OK] /etc/logrotate.d/supernoba-$svc"
    else
        echo "  [MISSING] /etc/logrotate.d/supernoba-$svc"
    fi
done

echo ""
echo "Verifying systemd services..."
sudo systemctl daemon-reload
for svc in supernoba-engine supernoba-streamer supernoba-mm supernoba-aggregator; do
    if systemctl list-unit-files | grep -q "$svc"; then
        echo "  [OK] $svc.service installed"
    else
        echo "  [MISSING] $svc.service"
    fi
done
REMOTE_SCRIPT

    log_success "Phase 5 complete: systemd + logrotate installed"
}

#===== Phase 6: Start Services =====
phase_start() {
    log_phase "Phase 6: Start All Services"

    run_ssh << 'REMOTE_SCRIPT'
cd ~/Supernoba-Core_Old/deploy

echo "Starting services in order: engine → processor → streamer → mm → aggregator"
echo ""

# 1. Engine 먼저 시작
echo "Starting engine..."
sudo systemctl start supernoba-engine
sleep 3
if systemctl is-active --quiet supernoba-engine; then
    echo "  [OK] Engine started"
else
    echo "  [FAIL] Engine failed to start"
    journalctl -u supernoba-engine --since "30 sec ago" --no-pager | tail -5
fi

# 2. Processor
echo "Starting processor..."
sudo systemctl start supernoba-processor 2>/dev/null || true
sleep 2
if systemctl is-active --quiet supernoba-processor 2>/dev/null; then
    echo "  [OK] Processor started"
else
    echo "  [WARN] Processor not available or failed"
fi

# 3. Streamer
echo "Starting streamer..."
sudo systemctl start supernoba-streamer
sleep 2
if systemctl is-active --quiet supernoba-streamer; then
    echo "  [OK] Streamer started"
else
    echo "  [FAIL] Streamer failed to start"
    journalctl -u supernoba-streamer --since "30 sec ago" --no-pager | tail -5
fi

# 4. MM Service
echo "Starting mm-service..."
sudo systemctl start supernoba-mm
sleep 2
if systemctl is-active --quiet supernoba-mm; then
    echo "  [OK] MM Service started"
else
    echo "  [FAIL] MM Service failed to start"
    journalctl -u supernoba-mm --since "30 sec ago" --no-pager | tail -5
fi

# 5. Aggregator
echo "Starting aggregator..."
sudo systemctl start supernoba-aggregator
sleep 2
if systemctl is-active --quiet supernoba-aggregator; then
    echo "  [OK] Aggregator started"
else
    echo "  [FAIL] Aggregator failed to start"
    journalctl -u supernoba-aggregator --since "30 sec ago" --no-pager | tail -5
fi

echo ""
echo "=== All services status ==="
./supernoba-ctl.sh health
REMOTE_SCRIPT

    log_success "Phase 6 complete: All services started"
}

#===== Phase 7: Verify =====
phase_verify() {
    log_phase "Phase 7: E2E Verification"

    run_ssh << 'REMOTE_SCRIPT'
echo "=== 4-Cache Key Distribution ==="
for port in 6379 6380 6381 6382; do
    dbsize=$(redis-cli -p $port DBSIZE 2>/dev/null)
    echo "  Port $port: $dbsize"
done

echo ""
echo "=== Key Samples ==="

echo "--- Depth Cache (6379) ---"
redis-cli -p 6379 KEYS "depth:*" 2>/dev/null | head -3
redis-cli -p 6379 KEYS "ticker:*" 2>/dev/null | head -3
redis-cli -p 6379 KEYS "prev:*" 2>/dev/null | head -3

echo "--- Candle Cache (6380) ---"
redis-cli -p 6380 KEYS "candle:*" 2>/dev/null | head -3

echo "--- Backup Cache (6381) ---"
redis-cli -p 6381 KEYS "snapshot:*" 2>/dev/null | head -3
redis-cli -p 6381 KEYS "kinesis:checkpoint:*" 2>/dev/null | head -3
redis-cli -p 6381 KEYS "ranking:*" 2>/dev/null | head -3

echo "--- Operating Cache (6382) ---"
redis-cli -p 6382 KEYS "mm:*" 2>/dev/null | head -3
redis-cli -p 6382 KEYS "deleted:*" 2>/dev/null | head -3

echo ""
echo "=== Engine Log (last 10 lines) ==="
tail -10 /var/log/supernoba/engine/engine.log 2>/dev/null || echo "No engine log yet"

echo ""
echo "=== Streamer Log (last 5 lines) ==="
tail -5 /var/log/supernoba/streamer/streamer.log 2>/dev/null || echo "No streamer log yet"

echo ""
echo "=== Aggregator Log (last 5 lines) ==="
tail -5 /var/log/supernoba/aggregator/aggregator.log 2>/dev/null || echo "No aggregator log yet"

echo ""
echo "=== MM Service Log (last 5 lines) ==="
tail -5 /var/log/supernoba/mm-service/mm-service.log 2>/dev/null || echo "No mm log yet"

echo ""
echo "=== Logrotate Status ==="
for svc in engine streamer mm aggregator; do
    if [ -f "/etc/logrotate.d/supernoba-$svc" ]; then
        echo "  [OK] supernoba-$svc"
    else
        echo "  [MISSING] supernoba-$svc"
    fi
done

echo ""
echo "=== Service Health ==="
cd ~/Supernoba-Core_Old/deploy
./supernoba-ctl.sh health 2>/dev/null || true

echo ""
echo "=== Verification Complete ==="
REMOTE_SCRIPT

    log_success "Phase 7 complete: E2E verification done"
}

#===== Main =====
main() {
    echo "============================================"
    echo "  Supernoba 4-Cache Architecture Deployment"
    echo "  $(date)"
    echo "============================================"
    echo ""

    local phase=${1:-all}

    case "$phase" in
        scp)     phase_scp ;;
        stop)    phase_stop ;;
        migrate) phase_migrate ;;
        build)   phase_build ;;
        install) phase_install ;;
        start)   phase_start ;;
        verify)  phase_verify ;;
        all)
            phase_scp
            phase_stop
            phase_migrate
            phase_build
            phase_install
            phase_start
            phase_verify
            ;;
        *)
            echo "Usage: $0 [scp|stop|migrate|build|install|start|verify|all]"
            exit 1
            ;;
    esac

    echo ""
    echo "============================================"
    echo "  Deployment Complete!"
    echo "  $(date)"
    echo "============================================"
}

main "$@"
