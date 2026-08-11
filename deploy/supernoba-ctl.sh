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
#   ./supernoba-ctl.sh kill [service]     # 프로세스 강제 종료 (pkill)
#   ./supernoba-ctl.sh kill-all           # 모든 Supernoba 프로세스 강제 종료
#
# service: engine, streamer, mm, aggregator, all
# NOTE: processor는 Supernoba-back 저장소에서 관리됩니다.
#

set -e

# 공통 라이브러리 로드 (색상, 로깅 함수, HOST_SERVICES, SERVICE_NAMES)
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

# 현재 호스트
HOSTNAME=$(hostname)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Private IP 기반 서비스 매핑 (호스트명 인식 실패 시 fallback)
declare -A IP_SERVICES
IP_SERVICES["172.31.47.97"]="engine mm"        # stock-bastion
IP_SERVICES["172.31.57.219"]="streamer"        # stock-streamer
IP_SERVICES["172.31.35.62"]="aggregator"       # stock-aggregator
IP_SERVICES["172.31.10.211"]="engine streamer mm aggregator"  # 현재 단일 EC2

# 로그 경로
declare -A LOG_PATHS
LOG_PATHS["engine"]="/var/log/supernoba/engine/engine.log"
LOG_PATHS["streamer"]="/var/log/supernoba/streamer/streamer.log"
LOG_PATHS["mm"]="/var/log/supernoba/mm-service/mm-service.log"
LOG_PATHS["aggregator"]="/var/log/supernoba/aggregator/aggregator.log"

# 빌드 경로
declare -A BUILD_PATHS
BUILD_PATHS["engine"]="$HOME/Supernoba-Core_Old/wrapper"
BUILD_PATHS["streamer"]="$HOME/Supernoba-Core_Old/streamer/node"
BUILD_PATHS["mm"]="$HOME/Supernoba-Core_Old/mm-service"
BUILD_PATHS["aggregator"]="$HOME/Supernoba-Core_Old/aggregator"

# 서비스 설명
declare -A SERVICE_DESC
SERVICE_DESC["engine"]="Matching Engine (C++)"
SERVICE_DESC["streamer"]="Streaming Server (Node.js)"
SERVICE_DESC["mm"]="Market Maker Service (Node.js)"
SERVICE_DESC["aggregator"]="Candle Aggregator (C++)"

#===== 유틸리티 함수 =====

# 현재 호스트의 로컬 서비스 목록
get_local_services() {
    # 1. 환경 변수 우선
    if [ -n "$SUPERNOBA_SERVICES" ]; then
        echo "$SUPERNOBA_SERVICES"
        return
    fi

    # 2. 호스트명 매칭
    for host in "${!HOST_SERVICES[@]}"; do
        if [[ "$HOSTNAME" == *"$host"* ]]; then
            echo "${HOST_SERVICES[$host]}"
            return
        fi
    done

    # 3. IP 주소 기반 fallback
    local my_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [ -n "$my_ip" ] && [ -n "${IP_SERVICES[$my_ip]}" ]; then
        echo "${IP_SERVICES[$my_ip]}"
        return
    fi

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

# vcpkg 빌드 아티팩트 정리
cleanup_vcpkg() {
    if [ -d "$HOME/vcpkg/buildtrees" ]; then
        local size=$(du -sh "$HOME/vcpkg/buildtrees" 2>/dev/null | cut -f1)
        if [ -n "$size" ] && [ "$size" != "0" ]; then
            log_info "Cleaning vcpkg buildtrees ($size)..."
            rm -rf "$HOME/vcpkg/buildtrees"/*
            log_success "vcpkg buildtrees cleaned"
        fi
    fi
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
            # 빌드 후 vcpkg 아티팩트 정리
            cleanup_vcpkg
            ;;
        aggregator)
            if [ ! -d "build" ]; then
                cmake -B build -S . \
                    -DCMAKE_BUILD_TYPE=Release \
                    -DCMAKE_TOOLCHAIN_FILE=$HOME/vcpkg/scripts/buildsystems/vcpkg.cmake
            fi
            cmake --build build -j$(nproc)
            # 빌드 후 vcpkg 아티팩트 정리
            cleanup_vcpkg
            ;;
        streamer|mm)
            if [ ! -d "node_modules" ]; then
                npm install
            fi
            ;;
    esac

    log_success "${SERVICE_DESC[$service]} build complete"
}

# 프로세스 강제 종료 (pkill)
kill_service() {
    local service=$1
    local desc="${SERVICE_DESC[$service]}"

    log_info "Force killing $service ($desc)..."

    case "$service" in
        engine)
            pkill -9 -f 'matching_engine' 2>/dev/null && log_success "Killed matching_engine" || log_warn "No matching_engine process found"
            ;;
        streamer)
            pkill -9 -f 'node.*streamer.*index\.mjs' 2>/dev/null && log_success "Killed streamer" || log_warn "No streamer process found"
            ;;
        mm)
            pkill -9 -f 'node.*mm-service.*index\.mjs' 2>/dev/null && log_success "Killed mm-service" || log_warn "No mm-service process found"
            ;;
        aggregator)
            pkill -9 -f 'candle_aggregator' 2>/dev/null && log_success "Killed candle_aggregator" || log_warn "No candle_aggregator process found"
            ;;
        *)
            log_error "Unknown service: $service"
            return 1
            ;;
    esac
}

# 모든 Supernoba 프로세스 강제 종료
kill_all_processes() {
    log_warn "Force killing ALL Supernoba processes..."
    echo ""

    # systemd 서비스 먼저 중지 시도
    log_info "Stopping systemd services first..."
    for svc in engine streamer mm aggregator; do
        local systemd_name="${SERVICE_NAMES[$svc]}"
        sudo systemctl stop "$systemd_name" 2>/dev/null || true
    done

    echo ""
    log_info "Force killing any remaining processes..."

    # 각 프로세스 강제 종료
    pkill -9 -f 'matching_engine' 2>/dev/null && log_success "Killed matching_engine" || true
    pkill -9 -f 'node.*streamer.*index\.mjs' 2>/dev/null && log_success "Killed streamer" || true
    pkill -9 -f 'node.*mm-service.*index\.mjs' 2>/dev/null && log_success "Killed mm-service" || true
    pkill -9 -f 'candle_aggregator' 2>/dev/null && log_success "Killed candle_aggregator" || true

    echo ""
    log_success "All Supernoba processes terminated"
}

# MM 일시 정지 (엔진 재시작 전)
pause_mm_if_running() {
    local mm_running=$(redis-cli -h 127.0.0.1 -p 6382 GET mm:running 2>/dev/null)
    if [ "$mm_running" != "1" ]; then
        return 0
    fi
    log_info "Pausing Market Maker before engine restart..."
    redis-cli -h 127.0.0.1 -p 6382 PUBLISH mm:control \
      '{"action":"stopAll","source":"supernoba-ctl"}' > /dev/null 2>&1
    for i in $(seq 1 10); do
        local still=$(redis-cli -h 127.0.0.1 -p 6382 SCARD mm:running:symbols 2>/dev/null)
        if [ "$still" = "0" ] || [ -z "$still" ]; then
            log_success "Market Maker paused"
            return 0
        fi
        sleep 0.5
    done
    log_warn "Market Maker did not fully stop within 5s, proceeding anyway"
}

# MM 재개 (엔진 재시작 후)
resume_mm_if_was_running() {
    if ! systemctl is-active --quiet supernoba-mm 2>/dev/null; then
        return 0
    fi
    log_info "Resuming Market Maker..."
    redis-cli -h 127.0.0.1 -p 6382 PUBLISH mm:control \
      '{"action":"startAll","source":"supernoba-ctl"}' > /dev/null 2>&1
    log_success "Market Maker resumed"
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
    echo "  build [service]     Build only (SCP 후 증분 빌드 — EC2 권장)"
    echo "  deploy              Full deployment (git pull + build + restart) — EC2 비권장"
    echo "  health              Health check all local services"
    echo "  kill [service]      Force kill process (pkill -9)"
    echo "  kill-all            Force kill ALL Supernoba processes"
    echo ""
    echo "Services:"
    echo "  engine      - Matching Engine (C++)"
    echo "  streamer    - Streaming Server (Node.js)"
    echo "  mm          - Market Maker Service (Node.js)"
    echo "  aggregator  - Candle Aggregator (C++)"
    echo "  all         - All services on this host"
    echo ""
    echo "NOTE: processor는 Supernoba-back 저장소에서 관리됩니다."
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
                # 엔진 재시작 시 MM 일시정지/재개
                if [ "$ACTION" == "restart" ] && [ "$svc" == "engine" ]; then
                    pause_mm_if_running
                    service_action "$ACTION" "$svc" || true
                    sleep 3
                    resume_mm_if_was_running
                else
                    service_action "$ACTION" "$svc" || true
                fi
            done
        else
            # 엔진 재시작 시 MM 일시정지/재개
            if [ "$ACTION" == "restart" ] && [ "$SERVICE" == "engine" ]; then
                pause_mm_if_running
                service_action "$ACTION" "$SERVICE"
                sleep 3
                resume_mm_if_was_running
            else
                service_action "$ACTION" "$SERVICE"
            fi
        fi
        ;;

    status)
        if [ "$SERVICE" == "all" ] || [ -z "$SERVICE" ]; then
            echo "=== Service Status ($(hostname)) ==="
            local_services=$(get_local_services)
            if [ -z "$local_services" ]; then
                # 모든 서비스 상태 표시
                for svc in engine streamer mm aggregator; do
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

    build)
        # SCP 후 증분 빌드만 수행 (EC2 배포 시 권장)
        if [ "$SERVICE" == "all" ] || [ -z "$SERVICE" ]; then
            local_services=$(get_local_services)
            if [ -z "$local_services" ]; then
                log_error "Cannot determine local services for host: $HOSTNAME"
                exit 1
            fi
            for svc in $local_services; do
                build_service "$svc"
            done
        else
            build_service "$SERVICE"
        fi
        ;;

    deploy)
        echo "============================================"
        echo "  Supernoba Full Deployment"
        echo "  Host: $(hostname)"
        echo "============================================"
        echo ""

        log_warn "deploy 명령은 git pull을 포함합니다."
        log_warn "EC2에서는 SCP 기반 배포를 사용하세요: deploy-4cache.sh"
        echo ""
        read -p "계속하시겠습니까? (y/N) " confirm
        if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
            log_info "Aborted."
            exit 0
        fi

        local_services=$(get_local_services)
        if [ -z "$local_services" ]; then
            log_error "Cannot determine local services for host: $HOSTNAME"
            exit 1
        fi

        # Git pull
        log_info "Pulling latest code..."
        cd "$HOME/Supernoba-Core_Old" && git pull

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
            for svc in engine streamer mm aggregator; do
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

    kill)
        if [ "$SERVICE" == "all" ]; then
            log_info "Killing all local services..."
            local_services=$(get_local_services)
            if [ -z "$local_services" ]; then
                local_services="engine streamer mm aggregator"
            fi
            for svc in $local_services; do
                kill_service "$svc"
            done
        elif [ -z "$SERVICE" ]; then
            log_error "Service name required for kill command"
            echo "Usage: $0 kill <service>"
            echo "       $0 kill-all  # Kill all processes"
            exit 1
        else
            kill_service "$SERVICE"
        fi
        ;;

    kill-all)
        echo "============================================"
        echo "  Force Kill ALL Supernoba Processes"
        echo "  Host: $(hostname)"
        echo "============================================"
        echo ""
        log_warn "This will forcefully terminate ALL Supernoba processes!"
        echo ""
        read -p "Are you sure? (y/N): " confirm
        if [[ "$confirm" =~ ^[Yy]$ ]]; then
            kill_all_processes
        else
            log_info "Aborted."
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
