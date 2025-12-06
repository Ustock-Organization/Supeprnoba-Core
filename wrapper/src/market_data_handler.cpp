#include "market_data_handler.h"
#include "kafka_producer.h"
#include "websocket_server.h"
#include "logger.h"
#include "metrics.h"
#include <nlohmann/json.hpp>

namespace aws_wrapper {

MarketDataHandler::MarketDataHandler(KafkaProducer* producer, WebSocketServer* ws)
    : producer_(producer), ws_server_(ws) {
    Logger::info("MarketDataHandler initialized");
}

void MarketDataHandler::on_accept(const OrderPtr& order) {
    Logger::info("Order ACCEPTED:", order->order_id(), order->symbol());
    Metrics::instance().incrementOrdersAccepted();
    
    if (producer_) {
        producer_->publishOrderStatus(order->symbol(), order->order_id(), 
                                       "ACCEPTED");
    }
}

void MarketDataHandler::on_reject(const OrderPtr& order, const char* reason) {
    Logger::warn("Order REJECTED:", order->order_id(), "reason:", reason);
    Metrics::instance().incrementOrdersRejected();
    
    if (producer_) {
        producer_->publishOrderStatus(order->symbol(), order->order_id(), 
                                       "REJECTED", reason);
    }
}

void MarketDataHandler::on_fill(const OrderPtr& order,
                                 const OrderPtr& matched_order,
                                 liquibook::book::Quantity fill_qty,
                                 liquibook::book::Price fill_price) {
    Logger::info("FILL:", order->order_id(), "matched:", matched_order->order_id(),
                 "qty:", fill_qty, "price:", fill_price);
    
    Metrics::instance().incrementFillsPublished();
    
    if (producer_) {
        // 매수자/매도자 결정
        const std::string& buyer_id = order->is_buy() ? 
            order->user_id() : matched_order->user_id();
        const std::string& seller_id = order->is_buy() ? 
            matched_order->user_id() : order->user_id();
        
        producer_->publishFill(order->symbol(), order->order_id(),
                                matched_order->order_id(), buyer_id, seller_id,
                                fill_qty, fill_price);
    }
}

void MarketDataHandler::on_cancel(const OrderPtr& order) {
    Logger::info("Order CANCELLED:", order->order_id());
    
    if (producer_) {
        producer_->publishOrderStatus(order->symbol(), order->order_id(), 
                                       "CANCELLED");
    }
}

void MarketDataHandler::on_cancel_reject(const OrderPtr& order, const char* reason) {
    Logger::warn("Cancel REJECTED:", order->order_id(), "reason:", reason);
    
    if (producer_) {
        producer_->publishOrderStatus(order->symbol(), order->order_id(), 
                                       "CANCEL_REJECTED", reason);
    }
}

void MarketDataHandler::on_replace(const OrderPtr& order,
                                    const int64_t& size_delta,
                                    liquibook::book::Price new_price) {
    Logger::info("Order REPLACED:", order->order_id(), 
                 "delta:", size_delta, "new_price:", new_price);
    
    if (producer_) {
        producer_->publishOrderStatus(order->symbol(), order->order_id(), 
                                       "REPLACED");
    }
}

void MarketDataHandler::on_replace_reject(const OrderPtr& order, const char* reason) {
    Logger::warn("Replace REJECTED:", order->order_id(), "reason:", reason);
    
    if (producer_) {
        producer_->publishOrderStatus(order->symbol(), order->order_id(), 
                                       "REPLACE_REJECTED", reason);
    }
}

void MarketDataHandler::on_trade(const OrderBook* book,
                                  liquibook::book::Quantity qty,
                                  liquibook::book::Price price) {
    std::string symbol = book->symbol();
    Logger::info("TRADE:", symbol, "qty:", qty, "price:", price);
    
    Metrics::instance().incrementTradesExecuted();
    
    if (producer_) {
        producer_->publishTrade(symbol, qty, price);
    }
}

void MarketDataHandler::on_depth_change(const OrderBook* book,
                                         const BookDepth* depth) {
    std::string symbol = book->symbol();
    
    nlohmann::json depth_json;
    depth_json["event"] = "DEPTH";
    depth_json["symbol"] = symbol;
    
    // Bids
    nlohmann::json bids = nlohmann::json::array();
    for (auto& level : depth->bids()) {
        if (level.order_count() > 0) {
            bids.push_back({
                {"price", level.price()},
                {"quantity", level.aggregate_qty()},
                {"count", level.order_count()}
            });
        }
    }
    depth_json["bids"] = bids;
    
    // Asks
    nlohmann::json asks = nlohmann::json::array();
    for (auto& level : depth->asks()) {
        if (level.order_count() > 0) {
            asks.push_back({
                {"price", level.price()},
                {"quantity", level.aggregate_qty()},
                {"count", level.order_count()}
            });
        }
    }
    depth_json["asks"] = asks;
    
    depth_json["timestamp"] = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    
    if (producer_) {
        producer_->publishDepth(symbol, depth_json);
    }
    
    // WebSocket으로도 푸시 (실시간 호가)
    if (ws_server_) {
        ws_server_->pushToSymbol(symbol, depth_json);
    }
}

void MarketDataHandler::on_bbo_change(const OrderBook* book,
                                       const BookDepth* depth) {
    // BBO 변경은 depth_change로 처리됨
    Logger::debug("BBO change for:", book->symbol());
}

} // namespace aws_wrapper
