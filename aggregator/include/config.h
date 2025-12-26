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
    
    // RDS 설정
    std::string rds_host;
    int rds_port;
    std::string rds_dbname;
    std::string rds_user;
    std::string rds_password;
    
    // 폴링 설정
    int poll_interval_ms;
    
    // 로그 레벨
    std::string log_level;
    
    static Config from_env();
};

} // namespace aggregator
