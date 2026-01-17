#!/bin/bash
#
# Supernoba Service Control Script
#
# 서비스 통합 관리 CLI
#
# 사용법:
#   ./supernoba-ctl.sh start [service]    # 서비스 시작
#   ./supernoba-ctl.sh stop [service]     # 서비스 중지
#   ./supernoba-ctl.sh restart [service]  # 서비스 재시작
#   ./supernoba-ctl.sh status [service]   # 상태 확인
#   ./supernoba-ctl.sh logs [service]     # 로그 확인
#   ./supernoba-ctl.sh enable [service]   # 부팅 시 자동 시작 활성화
#   ./supernoba-ctl.sh disable [service]  # 부팅 시 자동 시작 비활성화
#   ./supernoba-ctl.sh deploy             # 전체 배포 (빌드 + 재시작)
#   ./supernoba-ctl.sh health             # 헬스체크
#
# service: engine, streamer, mm, aggregator, processor, all
#

set -e

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# 현재 호스트
HOSTNAME=$(hostname)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 호스트별 서비스 정의
declare -A HOST_SERVICES
HOST_SERVICES["stock-bastion"]="engine mm"
HOST_SERVICES["stock-streamer"]="streamer"
HOST_SERVICES["stock-processor"]="processor"
HOST_SERVICES["stock-aggregator"]="aggregator"

# 서비스명 매핑 (short -> systemd name)
declare -A SERVICE_NAMES
SERVICE_NAMES["engine"]="supernoba-engine"
SERVICE_NAMES["streamer"]="supernoba-streamer"
SERVICE_NAMES["mm"]="supernoba-mm"
SERVICE_NAMES["aggregator"]="supernoba-aggregator"
SERVICE_NAMES["processor"]="supernoba-processor"

# 로그 경로
declare -A LOG_PATHS
LOG_PATHS["engine"]="/var/log/supernoba/engine/engine.log"
LOG_PATHS["streamer"]="/var/log/supernoba/streamer/streamer.log"
LOG_PATHS["mm"]="/var/log/supernoba/mm-service/mm-service.log"
LOG_PATHS["aggregator"]="/var/log/supernoba/aggregator/aggregator.log"
LOG_PATHS["processor"]="/var/log/supernoba/processor/processor.log"

# 빌드 경로
declare -A BUILD_PATHS
BUILD_PATHS["engine"]="$HOME/Supeprnoba-Core/wrapper"
BUILD_PATHS["streamer"]="$HOME/Supeprnoba-Core/streamer/node"
BUILD_PATHS["mm"]="$HOME/Supeprnoba-Core/mm-service"
BUILD_PATHS["aggregator"]="$HOME/Supeprnoba-Core/aggregator"
BUILD_PATHS["processor"]="$HOME/Supernoba-back"

# 서비스 설명
declare -A SERVICE_DESC
SERVICE_DESC["engine"]="Matching Engine (C++)"
SERVICE_DESC["streamer"]="Streaming Server (Node.js)"
SERVICE_DESC["mm"]="Market Maker Service (Node.js)"
SERVICE_DESC["aggregator"]="Candle Aggregator (C++)"
SERVICE_DESC["processor"]="Stock Processor (C++)"

#===== 유틸리티 함수 =====

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 현재 호스트의 로컬 서비스 목록
get_local_services() {
    for host in "${!HOST_SERVICES[@]}"; do
        if [[ "$HOSTNAME" == *"$host"* ]]; then
            echo "${HOST_SERVICES[$host]}"
            return
        fi
    done
    echo ""
}

# systemctl 액션 실행
service_action() {
    local action=$1
    local service=$2
    local systemd_name="${SERVICE_NAMES[$service]}"

    if [ -z "$systemd_name" ]; then
        log_error "Unknown service: $service"
        return 1
    fi

    log_info "Running: systemctl $action $systemd_name"
    sudo systemctl "$action" "$systemd_name"
}

# 서비스 빌드
build_service() {
    local service=$1
    local build_path="${BUILD_PATHS[$service]}"

    if [ -z "$build_path" ]; then
        log_error "Unknown service: $service"
        return 1
    fi

    log_info "Building ${SERVICE_DESC[$service]}..."
    cd "$build_path"

    case "$service" in
        engine)
            if [ ! -d "build" ]; then
                cmake -B build -S . \
                    -DCMAKE_BUILD_TYPE=Release \
                    -DCMAKE_TOOLCHAIN_FILE=$HOME/vcpkg/scripts/buildsystems/vcpkg.cmake
            fi
            cmake --build build -j$(nproc)
            ;;
        aggregator)
            if [ ! -d "build" ]; then
                cmake -B build -S . \
                    -DCMAKE_BUILD_TYPE=Release \
                    -DCMAKE_TOOLCHAIN_FILE=$HOME/vcpkg/scripts/buildsystems/vcpkg.cmake
            fi
            cmake --build build -j$(nproc)
            ;;
        processor)
            if [ ! -d "build" ]; then
                cmake -B build -S . \
                    -DCMAKE_BUILD_TYPE=Release \
                    -DCMAKE_TOOLCHAIN_FILE=$HOME/vcpkg/scripts/buildsystems/vcpkg.cmake
            fi
            cmake --build build -j$(nproc)
            ;;
        streamer|mm)
            if [ ! -d "node_modules" ]; then
                npm install
            fi
            ;;
    esac

    log_success "${SERVICE_DESC[$service]} build complete"
}

# 헬스체크
health_check() {
    local service=$1
    local systemd_name="${SERVICE_NAMES[$service]}"
    local desc="${SERVICE_DESC[$service]}"

    if systemctl is-active --quiet "$systemd_name" 2>/dev/null; then
        local pid=$(systemctl show "$systemd_name" --property=MainPID --value 2>/dev/null)
        local memory=""
        local uptime=""

        if [ -n "$pid" ] && [ "$pid" != "0" ]; then
            memory=$(ps -o rss= -p "$pid" 2>/dev/null | awk '{printf "%.1fMB", $1/1024}')
            uptime=$(systemctl show "$systemd_name" --property=ActiveEnterTimestamp --value 2>/dev/null)
        fi

        echo -e "${GREEN}[RUNNING]${NC} $service ($desc)"
        echo -e "          PID: $pid, Memory: $memory"
        echo -e "          Started: $uptime"
    else
        echo -e "${RED}[STOPPED]${NC} $service ($desc)"
    fi
}

# 도움말 출력
show_help() {
    echo "Supernoba Service Control Script"
    echo ""
    echo "Usage: $0 <action> [service]"
    echo ""
    echo "Actions:"
    echo "  start [service]     Start service(s)"
    echo "  stop [service]      Stop service(s)"
    echo "  restart [service]   Restart service(s)"
    echo "  status [service]    Show service status"
    echo "  logs <service>      Tail service logs"
    echo "  enable [service]    Enable service(s) at boot"
    echo "  disable [service]   Disable service(s) at boot"
    echo "  deploy              Full deployment (git pull + build + restart)"
    echo "  health              Health check all local services"
    echo ""
    echo "Services:"
    echo "  engine      - Matching Engine (C++)"
    echo "  streamer    - Streaming Server (Node.js)"
    echo "  mm          - Market Maker Service (Node.js)"
    echo "  aggregator  - Candle Aggregator (C++)"
    echo "  processor   - Stock Processor (C++)"
    echo "  all         - All services on this host"
    echo ""
    echo "Examples:"
    echo "  $0 start all       # Start all services on this host"
    echo "  $0 restart engine  # Restart matching engine"
    echo "  $0 logs mm         # Tail MM service logs"
    echo "  $0 health          # Check all services health"
    echo ""
}

#===== 메인 =====

ACTION=$1
SERVICE=$2

# 인자 없으면 도움말
if [ -z "$ACTION" ]; then
    show_help
    exit 0
fi

case "$ACTION" in
    start|stop|restart|enable|disable)
        if [ "$SERVICE" == "all" ] || [ -z "$SERVICE" ]; then
            local_services=$(get_local_services)
            if [ -z "$local_services" ]; then
                log_error "Cannot determine local services for host: $HOSTNAME"
                exit 1
            fi
            for svc in $local_services; do
                service_action "$ACTION" "$svc" || true
            done
        else
            service_action "$ACTION" "$SERVICE"
        fi
        ;;

    status)
        if [ "$SERVICE" == "all" ] || [ -z "$SERVICE" ]; then
            echo "=== Service Status ($(hostname)) ==="
            local_services=$(get_local_services)
            if [ -z "$local_services" ]; then
                # 모든 서비스 상태 표시
                for svc in engine streamer mm aggregator processor; do
                    health_check "$svc"
                done
            else
                for svc in $local_services; do
                    health_check "$svc"
                done
            fi
        else
            health_check "$SERVICE"
        fi
        ;;

    logs)
        if [ -z "$SERVICE" ]; then
            log_error "Service name required for logs command"
            echo "Usage: $0 logs <service>"
            exit 1
        fi

        log_path="${LOG_PATHS[$SERVICE]}"
        if [ -n "$log_path" ]; then
            log_info "Tailing: $log_path"
            tail -f "$log_path"
        else
            log_error "Unknown service: $SERVICE"
            exit 1
        fi
        ;;

    deploy)
        echo "============================================"
        echo "  Supernoba Full Deployment"
        echo "  Host: $(hostname)"
        echo "============================================"
        echo ""

        local_services=$(get_local_services)
        if [ -z "$local_services" ]; then
            log_error "Cannot determine local services for host: $HOSTNAME"
            exit 1
        fi

        # Git pull
        log_info "Pulling latest code..."
        cd "$HOME/Supeprnoba-Core" && git pull

        # 빌드 및 재시작
        for svc in $local_services; do
            echo ""
            log_info "=== Processing $svc ==="

            # 서비스 중지
            service_action stop "$svc" 2>/dev/null || true

            # 빌드
            build_service "$svc"

            # 서비스 시작
            service_action start "$svc"

            # 잠시 대기
            sleep 2

            # 헬스체크
            health_check "$svc"
        done

        echo ""
        echo "============================================"
        echo "  Deployment Complete!"
        echo "============================================"
        ;;

    health)
        echo "============================================"
        echo "  Health Check - $(hostname)"
        echo "  $(date)"
        echo "============================================"
        echo ""

        local_services=$(get_local_services)
        if [ -z "$local_services" ]; then
            # 모든 서비스 확인
            for svc in engine streamer mm aggregator processor; do
                health_check "$svc"
                echo ""
            done
        else
            for svc in $local_services; do
                health_check "$svc"
                echo ""
            done
        fi
        ;;

    help|--help|-h)
        show_help
        ;;

    *)
        log_error "Unknown action: $ACTION"
        echo ""
        show_help
        exit 1
        ;;
esac
