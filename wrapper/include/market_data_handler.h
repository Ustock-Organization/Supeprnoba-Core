#pragma once

#include <cstdint>
#include <book/order_listener.h>
#include <book/trade_listener.h>
#include <book/depth_listener.h>
#include <book/bbo_listener.h>
#include <book/depth_order_book.h>
#include "order.h"

namespace aws_wrapper {

class KafkaProducer;

using OrderBook = liquibook::book::DepthOrderBook<OrderPtr>;
using BookDepth = liquibook::book::Depth<>;

class MarketDataHandler
    : public liquibook::book::OrderListener<OrderPtr>
    , public liquibook::book::TradeListener<OrderBook>
    , public liquibook::book::DepthListener<OrderBook>
    , public liquibook::book::BboListener<OrderBook>
{
public:
    explicit MarketDataHandler(KafkaProducer* producer);
    
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
    KafkaProducer* producer_;
};

} // namespace aws_wrapper

