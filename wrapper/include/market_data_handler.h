#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <ctime>
#include <book/order_listener.h>
#include <book/trade_listener.h>
#include <book/depth_listener.h>
#include <book/bbo_listener.h>
#include <book/depth_order_book.h>
#include "order.h"
#include "iproducer.h"

namespace aws_wrapper {

class RedisClient;  // forward declaration

// Depth levels: 10 bid + 10 ask
using OrderBook = liquibook::book::DepthOrderBook<OrderPtr, 10>;
using BookDepth = liquibook::book::Depth<10>;

// 일일 시장 데이터 (OHLC + 변동률)
struct DayData {
    uint64_t open_price = 0;    // 당일 시가 (첫 체결가)
    uint64_t high_price = 0;    // 당일 고가
    uint64_t low_price = 0;     // 당일 저가
    uint64_t last_price = 0;    // 현재가 (마지막 체결가)
    double change_rate = 0.0;   // 당일 변동률 (%)
    double prev_change_rate = 0.0;  // 전일 변동률 (%)
    int trading_day = 0;        // 거래일 (YYYYMMDD)
};

class MarketDataHandler
    : public liquibook::book::OrderListener<OrderPtr>
    , public liquibook::book::TradeListener<OrderBook>
    , public liquibook::book::DepthListener<OrderBook>
    , public liquibook::book::BboListener<OrderBook>
{
public:
    explicit MarketDataHandler(IProducer* producer, RedisClient* redis = nullptr);
    
    // === OrderListener ===
    void on_accept(const OrderPtr& order) override;
    void on_reject(const OrderPtr& order, const char* reason) override;
    void on_fill(const OrderPtr& order,
                 const OrderPtr& matched_order,
                 liquibook::book::Quantity fill_qty,
                 liquibook::book::Price fill_price) override;
    void on_cancel(const OrderPtr& order) override;
    void on_cancel_reject(const OrderPtr& order, const char* reason) override;
    void on_replace(const OrderPtr& order,
                    const int64_t& size_delta,
                    liquibook::book::Price new_price) override;
    void on_replace_reject(const OrderPtr& order, const char* reason) override;
    
    // === TradeListener ===
    void on_trade(const OrderBook* book,
                  liquibook::book::Quantity qty,
                  liquibook::book::Price price) override;
    
    // === DepthListener ===
    void on_depth_change(const OrderBook* book,
                         const BookDepth* depth) override;
    
    // === BboListener ===
    void on_bbo_change(const OrderBook* book,
                       const BookDepth* depth) override;
    
    // === Day Data ===
    DayData& getDayData(const std::string& symbol);
    void checkDayReset(const std::string& symbol);
    int getCurrentTradingDay() const;

private:
    IProducer* producer_;
    RedisClient* redis_;
    std::unordered_map<std::string, DayData> symbol_day_data_;
    
    void updateTickerCache(const std::string& symbol, uint64_t price);
    void savePrevDayData(const std::string& symbol, const DayData& data);
};

} // namespace aws_wrapper
