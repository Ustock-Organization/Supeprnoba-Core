#include "depth_broadcaster.h"
#include <nlohmann/json.hpp>
#include <iostream>

using json = nlohmann::json;

DepthBroadcaster::DepthBroadcaster(RedisClient& redis, WebSocketServer& ws_server)
    : redis_(redis), ws_server_(ws_server) {}

DepthBroadcaster::~DepthBroadcaster() {
    stop();
}

void DepthBroadcaster::start(int interval_ms) {
    if (running_) return;
    
    polling_interval_ms_ = interval_ms;
    running_ = true;
    polling_thread_ = std::thread(&DepthBroadcaster::pollingLoop, this);
    
    std::cout << "DepthBroadcaster started with " << interval_ms << "ms interval" << std::endl;
}

void DepthBroadcaster::stop() {
    if (!running_) return;
    
    running_ = false;
    if (polling_thread_.joinable()) {
        polling_thread_.join();
    }
    
    std::cout << "DepthBroadcaster stopped" << std::endl;
}

void DepthBroadcaster::subscribe(const std::string& connection_id, const std::string& symbol) {
    std::lock_guard<std::mutex> lock(subscriptions_mutex_);
    subscriptions_[symbol].insert(connection_id);
    std::cout << "Subscribed " << connection_id << " to " << symbol << std::endl;
}

void DepthBroadcaster::unsubscribe(const std::string& connection_id, const std::string& symbol) {
    std::lock_guard<std::mutex> lock(subscriptions_mutex_);
    auto it = subscriptions_.find(symbol);
    if (it != subscriptions_.end()) {
        it->second.erase(connection_id);
    }
}

void DepthBroadcaster::unsubscribeAll(const std::string& connection_id) {
    std::lock_guard<std::mutex> lock(subscriptions_mutex_);
    for (auto& [symbol, subscribers] : subscriptions_) {
        subscribers.erase(connection_id);
    }
}

void DepthBroadcaster::pollingLoop() {
    while (running_) {
        // 구독 목록 복사
        std::map<std::string, std::set<std::string>> subs_copy;
        {
            std::lock_guard<std::mutex> lock(subscriptions_mutex_);
            subs_copy = subscriptions_;
        }
        
        // 각 심볼에 대해 호가 조회 및 브로드캐스트
        for (const auto& [symbol, subscribers] : subs_copy) {
            if (subscribers.empty()) continue;
            
            auto depth = redis_.getDepth(symbol);
            if (!depth) continue;
            
            // JSON 직렬화
            json data;
            data["type"] = "DEPTH";
            data["symbol"] = depth->symbol;
            data["timestamp"] = depth->timestamp;
            
            json bids = json::array();
            for (const auto& level : depth->bids) {
                bids.push_back({{"price", level.price}, {"quantity", level.quantity}});
            }
            data["bids"] = bids;
            
            json asks = json::array();
            for (const auto& level : depth->asks) {
                asks.push_back({{"price", level.price}, {"quantity", level.quantity}});
            }
            data["asks"] = asks;
            
            std::string message = data.dump();
            
            // 구독자에게 브로드캐스트
            ws_server_.broadcast(subscribers, message);
        }
        
        std::this_thread::sleep_for(std::chrono::milliseconds(polling_interval_ms_));
    }
}
