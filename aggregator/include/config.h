#pragma once

#include <string>
#include <cstdint>

namespace aggregator {

struct Config {
    // Valkey 설정
    std::string valkey_host;
    int valkey_port;

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
