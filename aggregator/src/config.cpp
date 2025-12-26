#include "config.h"
#include <cstdlib>

namespace aggregator {

Config Config::from_env() {
    Config cfg;
    
    // Valkey 설정
    cfg.valkey_host = std::getenv("VALKEY_HOST") ? std::getenv("VALKEY_HOST") : "localhost";
    cfg.valkey_port = std::getenv("VALKEY_PORT") ? std::atoi(std::getenv("VALKEY_PORT")) : 6379;
    
    // AWS 설정
    cfg.aws_region = std::getenv("AWS_REGION") ? std::getenv("AWS_REGION") : "ap-northeast-2";
    
    // RDS 설정
    cfg.rds_host = std::getenv("RDS_HOST") ? std::getenv("RDS_HOST") : "localhost";
    cfg.rds_port = std::getenv("RDS_PORT") ? std::atoi(std::getenv("RDS_PORT")) : 5432;
    cfg.rds_dbname = std::getenv("RDS_DBNAME") ? std::getenv("RDS_DBNAME") : "postgres";
    cfg.rds_user = std::getenv("RDS_USER") ? std::getenv("RDS_USER") : "postgres";
    cfg.rds_password = std::getenv("RDS_PASSWORD") ? std::getenv("RDS_PASSWORD") : "";
    
    // 폴링 설정
    cfg.poll_interval_ms = std::getenv("POLL_INTERVAL_MS") ? std::atoi(std::getenv("POLL_INTERVAL_MS")) : 100;
    
    // 로그 레벨
    cfg.log_level = std::getenv("LOG_LEVEL") ? std::getenv("LOG_LEVEL") : "INFO";
    
    return cfg;
}

} // namespace aggregator
