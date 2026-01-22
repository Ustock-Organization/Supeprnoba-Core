#pragma once

#include <hiredis/hiredis.h>
#include <string>
#include <memory>
#include <optional>
#include <vector>
#include <map>
#include <chrono>

namespace aws_wrapper {

class RedisClient {
public:
    RedisClient(const std::string& host, int port);
    ~RedisClient();

    bool connect();
    bool isConnected() const { return context_ != nullptr && state_ == ConnectionState::CONNECTED; }

    // Connection management
    void setAutoReconnect(bool enabled);
    void setMaxReconnectAttempts(int attempts);
    void setReconnectDelay(int initial_ms, int max_ms);
    void setHealthCheckInterval(int interval_ms);

    // Connection state monitoring
    bool isHealthy();
    int getReconnectAttempts() const { return current_reconnect_attempts_; }

    // 기본 연산
    bool set(const std::string& key, const std::string& value);
    bool setEx(const std::string& key, const std::string& value, int ttl_seconds);
    std::optional<std::string> get(const std::string& key);
    bool del(const std::string& key);
    bool exists(const std::string& key);
    std::vector<std::string> keys(const std::string& pattern);

    // 리스트 연산 (체결 내역용)
    bool lpush(const std::string& key, const std::string& value);
    bool ltrim(const std::string& key, long start, long stop);
    std::vector<std::string> lrange(const std::string& key, long start, long stop);

    // Set 연산 (연결 관리용)
    std::vector<std::string> smembers(const std::string& key);

    // 해시 연산 (캔들용)
    bool hset(const std::string& key, const std::string& field, const std::string& value);
    std::optional<std::string> hget(const std::string& key, const std::string& field);
    std::map<std::string, std::string> hgetall(const std::string& key);

    // Sorted Set 연산 (랭킹용)
    bool zadd(const std::string& key, double score, const std::string& member);
    double zincrby(const std::string& key, double increment, const std::string& member);
    std::vector<std::pair<std::string, double>> zrevrange(const std::string& key, long start, long stop, bool withScores = false);
    std::vector<std::pair<std::string, double>> zrange(const std::string& key, long start, long stop, bool withScores = false);
    bool zremrangebyrank(const std::string& key, long start, long stop);

    // Pub/Sub (랭킹 브로드캐스트용)
    long long publish(const std::string& channel, const std::string& message);

    // Lua Script (EVAL)
    std::string eval(const std::string& script, int numKeys,
                     const std::vector<std::string>& keys,
                     const std::vector<std::string>& args);

    // 캔들 집계 (Lua Script 사용)
    bool updateCandle(const std::string& symbol, uint64_t price, uint64_t qty, int64_t timestamp);

    // 스냅샷 전용
    bool saveSnapshot(const std::string& symbol, const std::string& data);
    std::optional<std::string> loadSnapshot(const std::string& symbol);

private:
    // Connection info
    std::string host_;
    int port_;
    redisContext* context_ = nullptr;

    // Connection state
    enum class ConnectionState {
        CONNECTED,
        DISCONNECTED,
        CIRCUIT_OPEN  // Circuit breaker open - temporarily stop reconnect attempts
    };
    ConnectionState state_ = ConnectionState::DISCONNECTED;

    // Reconnection settings
    bool auto_reconnect_enabled_ = false;  // Default OFF for safety
    int max_reconnect_attempts_ = 10;
    int reconnect_delay_ms_ = 100;         // Initial backoff delay
    int max_reconnect_delay_ms_ = 30000;   // Max 30 seconds
    int circuit_breaker_timeout_ms_ = 60000; // 60 seconds before retry after circuit opens

    // Reconnection state
    int current_reconnect_attempts_ = 0;
    std::chrono::steady_clock::time_point last_reconnect_attempt_;
    std::chrono::steady_clock::time_point circuit_breaker_opened_at_;

    // Health check
    int health_check_interval_ms_ = 5000;  // Check every 5 seconds
    std::chrono::steady_clock::time_point last_health_check_;

    // Private helpers
    bool attemptReconnect();
    bool isHealthCheckDue();
    bool performHealthCheck();
    int calculateBackoffDelay();
    void markDisconnected();
    bool ensureConnection();  // Helper to check/reconnect before operations
};

} // namespace aws_wrapper
