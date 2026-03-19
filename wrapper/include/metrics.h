#pragma once

#include <string>
#include <atomic>
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
    void incrementFillsPublished() { ++fills_published_; }

    // Getters
    uint64_t getOrdersReceived() const { return orders_received_; }
    uint64_t getOrdersAccepted() const { return orders_accepted_; }
    uint64_t getTradesExecuted() const { return trades_executed_; }

private:
    Metrics() = default;

    std::atomic<uint64_t> orders_received_{0};
    std::atomic<uint64_t> orders_accepted_{0};
    std::atomic<uint64_t> orders_rejected_{0};
    std::atomic<uint64_t> trades_executed_{0};
    std::atomic<uint64_t> fills_published_{0};
};

} // namespace aws_wrapper
