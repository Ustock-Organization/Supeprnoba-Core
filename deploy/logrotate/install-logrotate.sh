#!/bin/bash
# Supernoba logrotate 설치 스크립트
# 사용법: sudo ./install-logrotate.sh [engine|streamer|mm|aggregator|all]
# NOTE: processor는 Supernoba-back 저장소에서 관리됩니다.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="/var/log/supernoba"

# 로그 디렉토리 생성
create_log_dirs() {
    local component=$1
    echo "Creating log directories for $component..."

    case $component in
        engine)
            mkdir -p "$LOG_DIR/engine"
            ;;
        streamer)
            mkdir -p "$LOG_DIR/streamer"
            ;;
        mm)
            mkdir -p "$LOG_DIR/mm-service"
            ;;
        aggregator)
            mkdir -p "$LOG_DIR/aggregator"
            ;;
    esac

    chown -R ec2-user:ec2-user "$LOG_DIR"
    chmod 755 "$LOG_DIR"
}

# logrotate 설정 설치
install_logrotate() {
    local component=$1
    local config_file="supernoba-$component"

    if [[ ! -f "$SCRIPT_DIR/$config_file" ]]; then
        echo "Error: Config file $config_file not found"
        exit 1
    fi

    echo "Installing logrotate config: $config_file"
    cp "$SCRIPT_DIR/$config_file" "/etc/logrotate.d/$config_file"
    chmod 644 "/etc/logrotate.d/$config_file"

    # 설정 검증
    echo "Validating logrotate config..."
    logrotate -d "/etc/logrotate.d/$config_file" 2>&1 | head -20

    echo "✅ Logrotate config installed: /etc/logrotate.d/$config_file"
}

# 메인
main() {
    if [[ $EUID -ne 0 ]]; then
        echo "Error: This script must be run as root (use sudo)"
        exit 1
    fi

    local component=${1:-all}

    case $component in
        engine)
            create_log_dirs engine
            install_logrotate engine
            ;;
        streamer)
            create_log_dirs streamer
            install_logrotate streamer
            ;;
        mm)
            create_log_dirs mm
            install_logrotate mm
            ;;
        aggregator)
            create_log_dirs aggregator
            install_logrotate aggregator
            ;;
        all)
            for c in engine streamer mm aggregator; do
                create_log_dirs $c
                install_logrotate $c
            done
            ;;
        *)
            echo "Usage: $0 [engine|streamer|mm|aggregator|all]"
            exit 1
            ;;
    esac

    echo ""
    echo "=== Installation Complete ==="
    echo "Log directories: $LOG_DIR"
    echo "Logrotate runs daily via cron"
    echo "Manual test: sudo logrotate -f /etc/logrotate.d/supernoba-$component"
}

main "$@"
