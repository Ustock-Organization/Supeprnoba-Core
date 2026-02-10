#!/bin/bash
#
# Supernoba Service Installation Script
#
# systemd 서비스 파일 설치 및 로그 디렉토리 설정
# 인스턴스 메모리 기반으로 동적 메모리 제한 설정
#
# 사용법:
#   sudo ./install-services.sh
#
# 주의: root 권한 필요
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

# 경로 설정
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_DIR="/etc/systemd/system"
LOG_BASE="/var/log/supernoba"
SECRETS_DIR="/home/ec2-user/.secrets"

# 호스트별 서비스 매핑
# NOTE: processor는 Supernoba-back 저장소에서 관리됩니다.
declare -A HOST_SERVICES
HOST_SERVICES["stock-bastion"]="supernoba-engine supernoba-mm"
HOST_SERVICES["stock-streamer"]="supernoba-streamer"
HOST_SERVICES["stock-aggregator"]="supernoba-aggregator"
# 현재 단일 EC2 환경
HOST_SERVICES["ip-172-31-10-211"]="supernoba-engine supernoba-mm supernoba-streamer supernoba-aggregator"

# 서비스별 메모리 비율 (총 메모리의 %)
# 동일 호스트에서 여러 서비스 실행 시 합이 90% 이하가 되도록 설정
declare -A SERVICE_MEMORY_PERCENT
SERVICE_MEMORY_PERCENT["supernoba-engine"]=60      # server: 60%
SERVICE_MEMORY_PERCENT["supernoba-mm"]=20          # server: 20% (engine과 함께)
SERVICE_MEMORY_PERCENT["supernoba-streamer"]=80    # streamer: 80%
SERVICE_MEMORY_PERCENT["supernoba-aggregator"]=80  # aggregator: 80%

# Node.js 서비스별 V8 힙 메모리 비율 (서비스 메모리의 %)
declare -A NODEJS_HEAP_PERCENT
NODEJS_HEAP_PERCENT["supernoba-mm"]=70
NODEJS_HEAP_PERCENT["supernoba-streamer"]=70

#===== 시스템 정보 함수 =====

# 총 시스템 메모리 (MB 단위)
get_total_memory_mb() {
    local mem_kb=$(grep MemTotal /proc/meminfo | awk '{print $2}')
    echo $((mem_kb / 1024))
}

# 총 디스크 용량 (MB 단위)
get_total_disk_mb() {
    local disk_kb=$(df / | tail -1 | awk '{print $2}')
    echo $((disk_kb / 1024))
}

# 메모리 값 계산 (MB)
calculate_memory() {
    local total_mb=$1
    local percent=$2
    echo $((total_mb * percent / 100))
}

# MB를 systemd 형식으로 변환 (예: 1536M, 2G)
format_memory() {
    local mb=$1
    if [ $mb -ge 1024 ]; then
        # 1G 이상이면 G 단위 사용 (소수점 없이)
        local gb=$((mb / 1024))
        local remainder=$((mb % 1024))
        if [ $remainder -eq 0 ]; then
            echo "${gb}G"
        else
            echo "${mb}M"
        fi
    else
        echo "${mb}M"
    fi
}

#===== 사전 요구사항 설치 =====

# cronie 설치 확인 및 설치
install_cronie() {
    log_info "Checking cronie (cron daemon)..."

    if command -v crontab &> /dev/null; then
        log_success "cronie already installed"
    else
        log_warn "cronie not found, installing..."
        yum install -y cronie
        systemctl enable crond
        systemctl start crond
        log_success "cronie installed and started"
    fi
}

#===== 디렉토리 설정 함수 =====

# 로그 디렉토리 생성
create_log_dirs() {
    log_info "Creating log directories..."

    local services=("engine" "streamer" "mm-service" "aggregator")
    for svc in "${services[@]}"; do
        if [ ! -d "$LOG_BASE/$svc" ]; then
            mkdir -p "$LOG_BASE/$svc"
            chown ec2-user:ec2-user "$LOG_BASE/$svc"
            chmod 755 "$LOG_BASE/$svc"
            log_success "Created $LOG_BASE/$svc"
        else
            log_info "$LOG_BASE/$svc already exists"
        fi
    done
}

# 비밀번호 파일 디렉토리 설정
create_secrets_dir() {
    log_info "Setting up secrets directory..."

    if [ ! -d "$SECRETS_DIR" ]; then
        mkdir -p "$SECRETS_DIR"
        chown ec2-user:ec2-user "$SECRETS_DIR"
        chmod 700 "$SECRETS_DIR"
        log_success "Created $SECRETS_DIR"
    fi

    if [ ! -f "$SECRETS_DIR/rds.env" ]; then
        log_warn "RDS password file not found: $SECRETS_DIR/rds.env"
        log_warn "Please create it manually with: RDS_PASSWORD=your_password"

        # 템플릿 생성
        cat > "$SECRETS_DIR/rds.env.template" << 'EOF'
# RDS PostgreSQL Password
# 이 파일을 rds.env로 복사하고 비밀번호를 설정하세요
RDS_PASSWORD=your_password_here
EOF
        chown ec2-user:ec2-user "$SECRETS_DIR/rds.env.template"
        chmod 600 "$SECRETS_DIR/rds.env.template"
        log_info "Created template: $SECRETS_DIR/rds.env.template"
    fi
}

# 디스크 모니터링 스크립트 설치
setup_disk_monitoring() {
    log_info "Setting up disk monitoring..."

    local script_path="/home/ec2-user/check-disk.sh"
    local log_path="/var/log/supernoba/disk-check.log"

    # 모니터링 스크립트 생성
    cat > "$script_path" << 'SCRIPT'
#!/bin/bash
# Disk usage monitor - alerts when usage exceeds 80%
USAGE=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
HOSTNAME=$(hostname)
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

if [ "$USAGE" -gt 80 ]; then
    echo "[$TIMESTAMP] WARNING: Disk usage at ${USAGE}% on $HOSTNAME"
fi
SCRIPT
    chown ec2-user:ec2-user "$script_path"
    chmod +x "$script_path"
    log_success "Created disk monitoring script: $script_path"

    # cron job 설정 (매시간 실행)
    local cron_entry="0 * * * * $script_path >> $log_path 2>&1"

    # 기존 cron job 확인 및 추가
    if crontab -u ec2-user -l 2>/dev/null | grep -q "check-disk.sh"; then
        log_info "Disk monitoring cron job already exists"
    else
        (crontab -u ec2-user -l 2>/dev/null || true; echo "$cron_entry") | crontab -u ec2-user -
        log_success "Added disk monitoring cron job (hourly)"
    fi
}

# vcpkg 정리 cron job 설정 (aggregator 전용)
setup_vcpkg_cleanup() {
    local hostname=$(hostname)

    # aggregator 인스턴스에서만 설정
    if [[ "$hostname" != *"stock-aggregator"* ]]; then
        return
    fi

    log_info "Setting up vcpkg cleanup cron job..."

    local cron_entry="0 3 * * 0 rm -rf /home/ec2-user/vcpkg/buildtrees/* 2>/dev/null"

    if crontab -u ec2-user -l 2>/dev/null | grep -q "vcpkg/buildtrees"; then
        log_info "vcpkg cleanup cron job already exists"
    else
        (crontab -u ec2-user -l 2>/dev/null || true; echo "$cron_entry") | crontab -u ec2-user -
        log_success "Added vcpkg cleanup cron job (weekly, Sunday 3AM)"
    fi
}

#===== 서비스 설치 함수 =====

# 서비스 파일 설치 (메모리 제한 동적 적용)
install_service() {
    local service=$1
    local total_mem_mb=$2
    local service_file="$SCRIPT_DIR/systemd/$service.service"

    if [ ! -f "$service_file" ]; then
        log_error "Service file not found: $service_file"
        return 1
    fi

    log_info "Installing $service..."

    # 메모리 계산
    local mem_percent=${SERVICE_MEMORY_PERCENT[$service]:-80}
    local mem_max_mb=$(calculate_memory $total_mem_mb $mem_percent)
    local mem_high_mb=$(calculate_memory $mem_max_mb 75)  # MemoryHigh = MemoryMax의 75%

    local mem_max_fmt=$(format_memory $mem_max_mb)
    local mem_high_fmt=$(format_memory $mem_high_mb)

    log_info "  Memory: ${mem_percent}% of ${total_mem_mb}MB = ${mem_max_fmt} (High: ${mem_high_fmt})"

    # Node.js V8 힙 크기 계산
    local nodejs_heap=""
    if [ -n "${NODEJS_HEAP_PERCENT[$service]}" ]; then
        local heap_percent=${NODEJS_HEAP_PERCENT[$service]}
        local heap_mb=$(calculate_memory $mem_max_mb $heap_percent)
        nodejs_heap="--max-old-space-size=$heap_mb"
        log_info "  Node.js V8 Heap: ${heap_mb}MB"
    fi

    # 서비스 파일 복사 및 메모리 값 치환
    local tmp_file=$(mktemp)
    cp "$service_file" "$tmp_file"

    # MemoryMax 치환
    sed -i "s/^MemoryMax=.*/MemoryMax=$mem_max_fmt/" "$tmp_file"

    # MemoryHigh 치환
    sed -i "s/^MemoryHigh=.*/MemoryHigh=$mem_high_fmt/" "$tmp_file"

    # Node.js V8 힙 크기 치환 (해당하는 경우)
    if [ -n "$nodejs_heap" ]; then
        sed -i "s/--max-old-space-size=[0-9]*/$nodejs_heap/" "$tmp_file"
    fi

    # 최종 서비스 파일 설치
    cp "$tmp_file" "$SYSTEMD_DIR/$service.service"
    chmod 644 "$SYSTEMD_DIR/$service.service"
    rm "$tmp_file"

    log_success "Installed $service (MemoryMax=$mem_max_fmt, MemoryHigh=$mem_high_fmt)"
}

# 현재 호스트에 맞는 서비스 찾기
get_host_services() {
    local hostname=$(hostname)

    for host in "${!HOST_SERVICES[@]}"; do
        if [[ "$hostname" == *"$host"* ]]; then
            echo "${HOST_SERVICES[$host]}"
            return
        fi
    done

    # 호스트명으로 판단 불가시 빈 문자열 반환
    echo ""
}

#===== 메인 =====

main() {
    echo "============================================"
    echo "  Supernoba Service Installation Script"
    echo "============================================"
    echo ""

    # root 권한 확인
    if [ "$EUID" -ne 0 ]; then
        log_error "This script must be run as root (use sudo)"
        exit 1
    fi

    # 시스템 정보 수집
    local total_mem_mb=$(get_total_memory_mb)
    local total_disk_mb=$(get_total_disk_mb)

    echo -e "${CYAN}=== System Information ===${NC}"
    echo "  Total Memory: ${total_mem_mb}MB ($((total_mem_mb / 1024))GB)"
    echo "  Total Disk:   ${total_disk_mb}MB ($((total_disk_mb / 1024))GB)"
    echo ""

    # 사전 요구사항 설치
    install_cronie

    # 로그 디렉토리 생성
    create_log_dirs

    # 비밀번호 디렉토리 설정
    create_secrets_dir

    # 현재 호스트에 맞는 서비스 설치
    local hostname=$(hostname)
    local services=$(get_host_services)

    log_info "Hostname: $hostname"

    if [ -z "$services" ]; then
        log_warn "Unknown host. Installing all services..."
        services="supernoba-engine supernoba-mm supernoba-streamer supernoba-aggregator"
    fi

    log_info "Installing services: $services"
    echo ""

    # 서비스별 메모리 할당 계획 표시
    echo -e "${CYAN}=== Memory Allocation Plan ===${NC}"
    local total_percent=0
    for svc in $services; do
        local pct=${SERVICE_MEMORY_PERCENT[$svc]:-80}
        local mem_mb=$(calculate_memory $total_mem_mb $pct)
        echo "  $svc: ${pct}% = $(format_memory $mem_mb)"
        total_percent=$((total_percent + pct))
    done
    echo "  ----------------------------------------"
    echo "  Total: ${total_percent}% of system memory"
    if [ $total_percent -gt 90 ]; then
        log_warn "Total memory allocation exceeds 90%!"
    fi
    echo ""

    # 서비스 설치
    for svc in $services; do
        install_service "$svc" "$total_mem_mb"
    done

    # Logrotate 설치
    if [ -f "$SCRIPT_DIR/logrotate/install-logrotate.sh" ]; then
        log_info "Installing logrotate configurations..."
        bash "$SCRIPT_DIR/logrotate/install-logrotate.sh" all
    fi

    # 디스크 모니터링 설정
    setup_disk_monitoring

    # vcpkg 정리 cron job 설정 (aggregator만)
    setup_vcpkg_cleanup

    # systemd 리로드
    log_info "Reloading systemd daemon..."
    systemctl daemon-reload
    log_success "systemd daemon reloaded"

    echo ""
    echo "============================================"
    echo "  Installation Complete!"
    echo "============================================"
    echo ""
    echo "Memory limits applied based on system memory (${total_mem_mb}MB)"
    echo ""
    echo "Next steps:"
    echo "  1. Create RDS password file (if needed):"
    echo "     echo 'RDS_PASSWORD=your_password' > ~/.secrets/rds.env"
    echo "     chmod 600 ~/.secrets/rds.env"
    echo ""
    echo "  2. Enable services:"
    echo "     ./supernoba-ctl.sh enable all"
    echo ""
    echo "  3. Start services:"
    echo "     ./supernoba-ctl.sh start all"
    echo ""
    echo "  4. Check status:"
    echo "     ./supernoba-ctl.sh health"
    echo ""
}

main "$@"
