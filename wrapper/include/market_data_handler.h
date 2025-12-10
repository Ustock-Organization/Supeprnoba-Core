#pragma once

#include <cstdint>
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

private:
    IProducer* producer_;
    RedisClient* redis_;
};

} // namespace aws_wrapper
