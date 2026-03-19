#pragma once

#include "redis_client.h"
#include "websocket_server.h"
#include <atomic>
#include <thread>
#include <set>
#include <map>

class DepthBroadcaster {
public:
    DepthBroadcaster(RedisClient& redis, WebSocketServer& ws_server);
    ~DepthBroadcaster();

    // 폴링 시작 (interval_ms: 폴링 간격)
    void start(int interval_ms = 100);
    void stop();
    
private:
    void pollingLoop();
    
    RedisClient& redis_;
    WebSocketServer& ws_server_;
    
    std::atomic<bool> running_{false};
    std::thread polling_thread_;
    int polling_interval_ms_{100};
    
    // 심볼별 구독자 (로컬 캐시)
    std::map<std::string, std::set<std::string>> subscriptions_;
    mutable std::mutex subscriptions_mutex_;
};
