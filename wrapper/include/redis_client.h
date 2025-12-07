#pragma once

#include <hiredis/hiredis.h>
#include <string>
#include <memory>
#include <optional>
#include <vector>

namespace aws_wrapper {

class RedisClient {
public:
    RedisClient(const std::string& host, int port);
    ~RedisClient();
    
    bool connect();
    bool isConnected() const { return context_ != nullptr; }
    
    // 기본 연산
    bool set(const std::string& key, const std::string& value);
    bool setEx(const std::string& key, const std::string& value, int ttl_seconds);
    std::optional<std::string> get(const std::string& key);
    bool del(const std::string& key);
    bool exists(const std::string& key);
    std::vector<std::string> keys(const std::string& pattern);
    
    // 스냅샷 전용
    bool saveSnapshot(const std::string& symbol, const std::string& data);
    std::optional<std::string> loadSnapshot(const std::string& symbol);
    
private:
    std::string host_;
    int port_;
    redisContext* context_ = nullptr;
};

} // namespace aws_wrapper
