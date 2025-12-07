#pragma once

#include <string>
#include <cstdlib>

namespace aws_wrapper {

class Config {
public:
    static std::string get(const std::string& key, const std::string& default_value = "") {
        const char* val = std::getenv(key.c_str());
        return val ? std::string(val) : default_value;
    }

    static int getInt(const std::string& key, int default_value = 0) {
        const char* val = std::getenv(key.c_str());
        return val ? std::stoi(val) : default_value;
    }

    static bool getBool(const std::string& key, bool default_value = false) {
        const char* val = std::getenv(key.c_str());
        if (!val) return default_value;
        std::string s(val);
        return s == "1" || s == "true" || s == "TRUE";
    }

    // 환경변수 키 상수
    static constexpr const char* KAFKA_BROKERS = "KAFKA_BROKERS";
    static constexpr const char* KAFKA_ORDER_TOPIC = "KAFKA_ORDER_TOPIC";
    static constexpr const char* KAFKA_FILLS_TOPIC = "KAFKA_FILLS_TOPIC";
    static constexpr const char* KAFKA_TRADES_TOPIC = "KAFKA_TRADES_TOPIC";
    static constexpr const char* KAFKA_DEPTH_TOPIC = "KAFKA_DEPTH_TOPIC";
    static constexpr const char* KAFKA_GROUP_ID = "KAFKA_GROUP_ID";
    static constexpr const char* GRPC_PORT = "GRPC_PORT";
    static constexpr const char* REDIS_HOST = "REDIS_HOST";
    static constexpr const char* REDIS_PORT = "REDIS_PORT";
    static constexpr const char* LOG_LEVEL = "LOG_LEVEL";
};

} // namespace aws_wrapper
