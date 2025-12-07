#include "metrics.h"
#include <nlohmann/json.hpp>

namespace aws_wrapper {

void Metrics::recordOrderLatency(uint64_t microseconds) {
    std::lock_guard<std::mutex> lock(latency_mutex_);
    total_order_latency_us_ += microseconds;
    ++order_latency_count_;
}

void Metrics::recordMatchLatency(uint64_t microseconds) {
    std::lock_guard<std::mutex> lock(latency_mutex_);
    total_match_latency_us_ += microseconds;
    ++match_latency_count_;
}

double Metrics::getAvgOrderLatencyUs() const {
    std::lock_guard<std::mutex> lock(latency_mutex_);
    if (order_latency_count_ == 0) return 0.0;
    return static_cast<double>(total_order_latency_us_) / order_latency_count_;
}

double Metrics::getAvgMatchLatencyUs() const {
    std::lock_guard<std::mutex> lock(latency_mutex_);
    if (match_latency_count_ == 0) return 0.0;
    return static_cast<double>(total_match_latency_us_) / match_latency_count_;
}

std::string Metrics::toJson() const {
    nlohmann::json j;
    j["orders_received"] = orders_received_.load();
    j["orders_accepted"] = orders_accepted_.load();
    j["orders_rejected"] = orders_rejected_.load();
    j["trades_executed"] = trades_executed_.load();
    j["fills_published"] = fills_published_.load();
    j["symbol_count"] = symbol_count_.load();
    j["active_orders"] = active_orders_.load();
    j["avg_order_latency_us"] = getAvgOrderLatencyUs();
    j["avg_match_latency_us"] = getAvgMatchLatencyUs();
    
    return j.dump();
}

void Metrics::reset() {
    orders_received_ = 0;
    orders_accepted_ = 0;
    orders_rejected_ = 0;
    trades_executed_ = 0;
    fills_published_ = 0;
    
    std::lock_guard<std::mutex> lock(latency_mutex_);
    total_order_latency_us_ = 0;
    order_latency_count_ = 0;
    total_match_latency_us_ = 0;
    match_latency_count_ = 0;
}

} // namespace aws_wrapper
