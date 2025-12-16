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
    cfg.dynamodb_table = std::getenv("DYNAMODB_CANDLE_TABLE") ? std::getenv("DYNAMODB_CANDLE_TABLE") : "candle_history";
    cfg.s3_bucket = std::getenv("S3_BUCKET") ? std::getenv("S3_BUCKET") : "supernoba-market-data";
    
    // 폴링 설정
    cfg.poll_interval_ms = std::getenv("POLL_INTERVAL_MS") ? std::atoi(std::getenv("POLL_INTERVAL_MS")) : 100;
    
    // 로그 레벨
    cfg.log_level = std::getenv("LOG_LEVEL") ? std::getenv("LOG_LEVEL") : "INFO";
    
    return cfg;
}

} // namespace aggregator
