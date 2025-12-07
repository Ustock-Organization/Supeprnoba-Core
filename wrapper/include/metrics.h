#pragma once

#include <string>
#include <chrono>
#include <atomic>
#include <map>
#include <mutex>
#include <functional>
#include <cstdint>

namespace aws_wrapper {

class Metrics {
public:
    static Metrics& instance() {
        static Metrics inst;
        return inst;
    }
    
    // 카운터
    void incrementOrdersReceived() { ++orders_received_; }
    void incrementOrdersAccepted() { ++orders_accepted_; }
    void incrementOrdersRejected() { ++orders_rejected_; }
    void incrementTradesExecuted() { ++trades_executed_; }
    void incrementFillsPublished() { ++fills_published_; }
    
    // 레이턴시 기록
    void recordOrderLatency(uint64_t microseconds);
    void recordMatchLatency(uint64_t microseconds);
    
    // 게이지
    void setSymbolCount(size_t count) { symbol_count_ = count; }
    void setActiveOrders(size_t count) { active_orders_ = count; }
    
    // 리포트 (CloudWatch용)
    std::string toJson() const;
    void reset();
    
    // Getters
    uint64_t getOrdersReceived() const { return orders_received_; }
    uint64_t getOrdersAccepted() const { return orders_accepted_; }
    uint64_t getTradesExecuted() const { return trades_executed_; }
    double getAvgOrderLatencyUs() const;
    double getAvgMatchLatencyUs() const;
    
private:
    Metrics() = default;
    
    std::atomic<uint64_t> orders_received_{0};
    std::atomic<uint64_t> orders_accepted_{0};
    std::atomic<uint64_t> orders_rejected_{0};
    std::atomic<uint64_t> trades_executed_{0};
    std::atomic<uint64_t> fills_published_{0};
    
    std::atomic<size_t> symbol_count_{0};
    std::atomic<size_t> active_orders_{0};
    
    // 레이턴시 통계
    mutable std::mutex latency_mutex_;
    uint64_t total_order_latency_us_{0};
    uint64_t order_latency_count_{0};
    uint64_t total_match_latency_us_{0};
    uint64_t match_latency_count_{0};
};

// 레이턴시 측정 헬퍼
class ScopedTimer {
public:
    explicit ScopedTimer(std::function<void(uint64_t)> callback)
        : callback_(std::move(callback))
        , start_(std::chrono::high_resolution_clock::now()) {}
    
    ~ScopedTimer() {
        auto end = std::chrono::high_resolution_clock::now();
        auto us = std::chrono::duration_cast<std::chrono::microseconds>(end - start_).count();
        callback_(us);
    }
    
private:
    std::function<void(uint64_t)> callback_;
    std::chrono::high_resolution_clock::time_point start_;
};

} // namespace aws_wrapper
