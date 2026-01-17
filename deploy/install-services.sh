#!/bin/bash
#
# Supernoba Service Installation Script
#
# systemd 서비스 파일 설치 및 로그 디렉토리 설정
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
declare -A HOST_SERVICES
HOST_SERVICES["stock-bastion"]="supernoba-engine supernoba-mm"
HOST_SERVICES["stock-streamer"]="supernoba-streamer"
HOST_SERVICES["stock-processor"]="supernoba-processor"
HOST_SERVICES["stock-aggregator"]="supernoba-aggregator"

# 로그 디렉토리 생성
create_log_dirs() {
    log_info "Creating log directories..."

    local services=("engine" "streamer" "mm-service" "aggregator" "processor")
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

# 서비스 파일 설치
install_service() {
    local service=$1
    local service_file="$SCRIPT_DIR/systemd/$service.service"

    if [ -f "$service_file" ]; then
        log_info "Installing $service..."
        cp "$service_file" "$SYSTEMD_DIR/"
        chmod 644 "$SYSTEMD_DIR/$service.service"
        log_success "Installed $service"
    else
        log_error "Service file not found: $service_file"
        return 1
    fi
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

# 메인
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
        services="supernoba-engine supernoba-mm supernoba-streamer supernoba-processor supernoba-aggregator"
    fi

    log_info "Installing services: $services"
    echo ""

    for svc in $services; do
        install_service "$svc"
    done

    # Logrotate 설치
    if [ -f "$SCRIPT_DIR/logrotate/install-logrotate.sh" ]; then
        log_info "Installing logrotate configurations..."
        bash "$SCRIPT_DIR/logrotate/install-logrotate.sh" all
    fi

    # systemd 리로드
    log_info "Reloading systemd daemon..."
    systemctl daemon-reload
    log_success "systemd daemon reloaded"

    echo ""
    echo "============================================"
    echo "  Installation Complete!"
    echo "============================================"
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
