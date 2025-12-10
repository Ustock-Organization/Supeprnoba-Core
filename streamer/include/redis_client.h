#pragma once

#include <string>
#include <vector>
#include <functional>
#include <memory>

struct DepthLevel {
    double price;
    double quantity;
};

struct DepthData {
    std::string symbol;
    std::vector<DepthLevel> bids;  // 20틱
    std::vector<DepthLevel> asks;  // 20틱
    int64_t timestamp;
};

class RedisClient {
public:
    RedisClient(const std::string& host, int port = 6379, bool use_tls = true);
    ~RedisClient();

    bool connect();
    void disconnect();
    bool isConnected() const;

    // 호가 조회
    std::optional<DepthData> getDepth(const std::string& symbol);
    
    // 구독자 조회
    std::vector<std::string> getSubscribers(const std::string& symbol);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
