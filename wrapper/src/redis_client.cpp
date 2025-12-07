#include "redis_client.h"
#include "logger.h"
#include <chrono>

namespace aws_wrapper {

RedisClient::RedisClient(const std::string& host, int port)
    : host_(host), port_(port) {
    Logger::info("RedisClient created, host:", host, "port:", port);
}

RedisClient::~RedisClient() {
    if (context_) {
        redisFree(context_);
    }
}

bool RedisClient::connect() {
    if (context_) {
        redisFree(context_);
    }
    
    struct timeval timeout = {1, 500000};  // 1.5초
    context_ = redisConnectWithTimeout(host_.c_str(), port_, timeout);
    
    if (context_ == nullptr || context_->err) {
        if (context_) {
            Logger::error("Redis connection failed:", context_->errstr);
            redisFree(context_);
            context_ = nullptr;
        } else {
            Logger::error("Redis connection failed: can't allocate context");
        }
        return false;
    }
    
    Logger::info("Redis connected to:", host_, ":", port_);
    return true;
}

bool RedisClient::set(const std::string& key, const std::string& value) {
    if (!context_) return false;
    
    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "SET %s %s", key.c_str(), value.c_str()));
    
    if (!reply) {
        Logger::error("Redis SET failed:", context_->errstr);
        return false;
    }
    
    bool success = (reply->type != REDIS_REPLY_ERROR);
    freeReplyObject(reply);
    return success;
}

bool RedisClient::setEx(const std::string& key, const std::string& value, 
                         int ttl_seconds) {
    if (!context_) return false;
    
    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "SETEX %s %d %s", 
                     key.c_str(), ttl_seconds, value.c_str()));
    
    if (!reply) return false;
    
    bool success = (reply->type != REDIS_REPLY_ERROR);
    freeReplyObject(reply);
    return success;
}

std::optional<std::string> RedisClient::get(const std::string& key) {
    if (!context_) return std::nullopt;
    
    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "GET %s", key.c_str()));
    
    if (!reply) return std::nullopt;
    
    std::optional<std::string> result;
    if (reply->type == REDIS_REPLY_STRING) {
        result = std::string(reply->str, reply->len);
    }
    
    freeReplyObject(reply);
    return result;
}

bool RedisClient::del(const std::string& key) {
    if (!context_) return false;
    
    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "DEL %s", key.c_str()));
    
    if (!reply) return false;
    
    freeReplyObject(reply);
    return true;
}

bool RedisClient::exists(const std::string& key) {
    if (!context_) return false;
    
    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "EXISTS %s", key.c_str()));
    
    if (!reply) return false;
    
    bool result = (reply->type == REDIS_REPLY_INTEGER && reply->integer > 0);
    freeReplyObject(reply);
    return result;
}

bool RedisClient::saveSnapshot(const std::string& symbol, 
                                const std::string& data) {
    std::string key = "snapshot:" + symbol;
    std::string ts_key = "snapshot:" + symbol + ":timestamp";
    
    auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    
    if (!set(key, data)) return false;
    if (!set(ts_key, std::to_string(now))) return false;
    
    Logger::info("Snapshot saved to Redis:", symbol);
    return true;
}

std::optional<std::string> RedisClient::loadSnapshot(const std::string& symbol) {
    std::string key = "snapshot:" + symbol;
    return get(key);
}

std::vector<std::string> RedisClient::keys(const std::string& pattern) {
    std::vector<std::string> result;
    if (!context_) return result;
    
    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "KEYS %s", pattern.c_str()));
    
    if (!reply) return result;
    
    if (reply->type == REDIS_REPLY_ARRAY) {
        for (size_t i = 0; i < reply->elements; ++i) {
            if (reply->element[i]->type == REDIS_REPLY_STRING) {
                result.emplace_back(reply->element[i]->str, reply->element[i]->len);
            }
        }
    }
    
    freeReplyObject(reply);
    return result;
}

} // namespace aws_wrapper
