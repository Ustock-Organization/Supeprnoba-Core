#pragma once

#include <book/depth_order_book.h>
#include "order.h"
#include "market_data_handler.h"
#include <chrono>
#include <map>
#include <shared_mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace aws_wrapper {

class RedisClient;  // forward declaration

struct CancelAllResult {
    int cancelled_count;
    std::vector<std::string> failed_order_ids;
};

class EngineCore {
public:
    // Depth levels: 10 bid + 10 ask
    using OrderBook = liquibook::book::DepthOrderBook<OrderPtr, 10>;
    using OrderBookPtr = std::shared_ptr<OrderBook>;

    explicit EngineCore(MarketDataHandler* handler, RedisClient* redis = nullptr);

    // === 주문 API ===
    bool addOrder(OrderPtr order);
    bool cancelOrder(const std::string& symbol, const std::string& order_id);
    bool replaceOrder(const std::string& symbol, const std::string& order_id,
                      int64_t qty_delta, liquibook::book::Price new_price);
    CancelAllResult cancelAllOrders(const std::string& symbol);

    // 콜백 내에서 호출용 (락 이미 보유된 상태)
    void removeFilledOrderUnsafe(const std::string& symbol, const std::string& order_id);
    
    // === 스냅샷 API (gRPC용) ===
    std::string snapshotOrderBook(const std::string& symbol);
    bool restoreOrderBook(const std::string& symbol, const std::string& data);
    bool removeOrderBook(const std::string& symbol);
    
    // === 주문 조회 API ===
    bool hasOrder(const std::string& symbol, const std::string& order_id) const;

    // === 메트릭 API ===
    size_t getSymbolCount() const;
    std::vector<std::string> getAllSymbols() const;
    uint64_t getTotalOrdersProcessed() const { return total_orders_processed_; }
    uint64_t getTotalTradesExecuted() const { return total_trades_executed_; }

private:
    OrderBookPtr getOrCreateBook(const std::string& symbol);
    OrderPtr findOrder(const std::string& symbol, const std::string& order_id);
    void cleanupProcessedOrders();

    // Self-Trade Prevention (STP): cancel-oldest 정책.
    // aggressor의 limit price까지 반대편 북에서 동일 user_id의 resting 주문을 취소.
    // 락(rw_mutex_) 보유 상태에서 호출. MM 계정은 면제(의도적 자전체결).
    // 반환: 취소된 주문 수.
    int applySelfTradePrevention(const std::string& symbol, const OrderPtr& aggressor);
    static bool isMarketMaker(const std::string& user_id);

    std::map<std::string, OrderBookPtr> books_;
    std::map<std::string, std::map<std::string, OrderPtr>> order_maps_;
    mutable std::shared_mutex rw_mutex_;  // shared_mutex for read-write locking
    MarketDataHandler* handler_;
    RedisClient* operating_redis_ = nullptr;

    // Dedup Layer 1: recently processed order IDs (TTL-based eviction)
    std::unordered_map<std::string, std::chrono::steady_clock::time_point> processed_orders_;
    static constexpr int DEDUP_TTL_SECONDS = 120;  // 2-minute TTL

    uint64_t total_orders_processed_ = 0;
    uint64_t total_trades_executed_ = 0;
    uint64_t duplicates_rejected_ = 0;
    uint64_t self_trades_prevented_ = 0;
};

} // namespace aws_wrapper
