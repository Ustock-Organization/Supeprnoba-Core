#pragma once

#include <string>
#include <cstdint>

namespace aggregator {

struct Config {
    // Depth Cache (ticker reads)
    std::string depth_host;
    int depth_port;

    // Candle Cache (candle R/W)
    std::string candle_host;
    int candle_port;

    // Backup Cache (prev close, ranking)
    std::string backup_host;
    int backup_port;

    // AWS 설정
    std::string aws_region;

    // Secrets Manager 설정
    std::string db_credentials_secret_name;

    // 폴링 설정
    int poll_interval_ms;

    // 로그 레벨
    std::string log_level;

    static Config from_env();
};

} // namespace aggregator
