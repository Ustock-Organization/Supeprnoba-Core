#pragma once

#include <book/depth_order_book.h>
#include "order.h"
#include "market_data_handler.h"
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace aws_wrapper {

class EngineCore {
public:
    // Depth levels: 10 bid + 10 ask
    using OrderBook = liquibook::book::DepthOrderBook<OrderPtr, 10>;
    using OrderBookPtr = std::shared_ptr<OrderBook>;
    
    explicit EngineCore(MarketDataHandler* handler);
    
    // === 주문 API ===
    bool addOrder(OrderPtr order);
    bool cancelOrder(const std::string& symbol, const std::string& order_id);
    bool replaceOrder(const std::string& symbol, const std::string& order_id,
                      int64_t qty_delta, liquibook::book::Price new_price);
    
    // === 스냅샷 API (gRPC용) ===
    std::string snapshotOrderBook(const std::string& symbol);
    bool restoreOrderBook(const std::string& symbol, const std::string& data);
    bool removeOrderBook(const std::string& symbol);
    
    // === 메트릭 API ===
    size_t getSymbolCount() const;
    size_t getOrderCount(const std::string& symbol) const;
    std::vector<std::string> getAllSymbols() const;
    uint64_t getTotalOrdersProcessed() const { return total_orders_processed_; }
    uint64_t getTotalTradesExecuted() const { return total_trades_executed_; }
    
    void incrementTradeCount() { ++total_trades_executed_; }
    
private:
    OrderBookPtr getOrCreateBook(const std::string& symbol);
    OrderPtr findOrder(const std::string& symbol, const std::string& order_id);
    
    std::map<std::string, OrderBookPtr> books_;
    std::map<std::string, std::map<std::string, OrderPtr>> order_maps_;
    mutable std::mutex mutex_;
    MarketDataHandler* handler_;
    
    uint64_t total_orders_processed_ = 0;
    uint64_t total_trades_executed_ = 0;
};

} // namespace aws_wrapper
