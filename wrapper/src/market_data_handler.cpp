#include "market_data_handler.h"
#include "redis_client.h"
#include "notification_client.h"
#include "iproducer.h"
#include "logger.h"
#include "metrics.h"
#include <book/depth_level.h>
#include <nlohmann/json.hpp>
#include <cmath>

#ifdef USE_KINESIS
#include "dynamodb_client.h"
#endif

namespace aws_wrapper {

MarketDataHandler::MarketDataHandler(IProducer* producer, RedisClient* redis, DynamoDBClient* dynamodb, NotificationClient* notifier)
    : producer_(producer), redis_(redis), dynamodb_(dynamodb), notifier_(notifier) {
    Logger::info("MarketDataHandler initialized, Redis:", redis_ ? "connected" : "none",
                 "DynamoDB:", dynamodb_ ? "connected" : "none",
                 "Notifier:", notifier_ ? "enabled" : "disabled");
}

void MarketDataHandler::on_accept(const OrderPtr& order) {
    Logger::info("Order ACCEPTED:", order->order_id(), order->symbol());
    Metrics::instance().incrementOrdersAccepted();
    
    // Direct WebSocket notification (preferred)
    if (notifier_) {
        std::string side = order->is_buy() ? "BUY" : "SELL";
        std::string type = (order->price() == 0) ? "MARKET" : "LIMIT";
        notifier_->sendOrderStatus(order->user_id(), order->order_id(), 
                                   order->symbol(), side, order->price(), order->order_qty(), type, 
                                   0, 0, "ACCEPTED");
    }
}

void MarketDataHandler::on_reject(const OrderPtr& order, const char* reason) {
    Logger::warn("Order REJECTED:", order->order_id(), "reason:", reason);
    Metrics::instance().incrementOrdersRejected();
    
    if (notifier_) {
        std::string side = order->is_buy() ? "BUY" : "SELL";
        std::string type = (order->price() == 0) ? "MARKET" : "LIMIT";
        notifier_->sendOrderStatus(order->user_id(), order->order_id(), 
                                   order->symbol(), side, order->price(), order->order_qty(), type, 
                                   0, 0, "REJECTED", reason);
    }
}

void MarketDataHandler::on_fill(const OrderPtr& order,
                                 const OrderPtr& matched_order,
                                 liquibook::book::Quantity fill_qty,
                                 liquibook::book::Price fill_price) {
    std::string symbol = order->symbol();
    Logger::info("FILL:", order->order_id(), "matched:", matched_order->order_id(),
                 "qty:", fill_qty, "price:", fill_price, "symbol:", symbol);
    
    // 양쪽 주문의 filled_qty 업데이트
    liquibook::book::Cost fill_cost = fill_qty * fill_price;
    order->fill(fill_qty, fill_cost, 0);
    matched_order->fill(fill_qty, fill_cost, 0);
    
    Metrics::instance().incrementFillsPublished();
    
    // === DayData 업데이트 (on_trade 대체) ===
    checkDayReset(symbol);
    DayData& day = getDayData(symbol);
    
    // 시가 설정 (당일 첫 체결)
    if (day.open_price == 0) {
        day.open_price = fill_price;
        day.high_price = fill_price;
        day.low_price = fill_price;
        Logger::info("First trade of day for", symbol, "open:", fill_price);
    }
    
    // 고가/저가 업데이트
    if (fill_price > day.high_price) day.high_price = fill_price;
    if (fill_price < day.low_price) day.low_price = fill_price;
    
    // 현재가 및 변동률 계산
    day.last_price = fill_price;
    day.volume += fill_qty;  // 거래량 누적
    if (day.open_price > 0) {
        day.change_rate = ((double)fill_price - (double)day.open_price) / (double)day.open_price * 100.0;
    }
    
    Logger::info("DayData updated:", symbol, "price:", fill_price, "vol:", day.volume, "change:", day.change_rate, "%");
    
    // === OHLC 캐시 저장 (당일만) ===
    auto now = std::chrono::system_clock::now();
    auto epoch_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()).count();
    auto epoch_sec = epoch_ms / 1000;
    
    if (redis_ && redis_->isConnected()) {
        nlohmann::json ohlc;
        ohlc["o"] = day.open_price;
        ohlc["h"] = day.high_price;
        ohlc["l"] = day.low_price;
        ohlc["c"] = day.last_price;
        ohlc["v"] = day.volume;
        ohlc["change"] = std::round(day.change_rate * 100) / 100.0;
        ohlc["t"] = epoch_sec;  // Unix timestamp (초)
        redis_->set("ohlc:" + symbol, ohlc.dump());
        Logger::debug("OHLC saved:", symbol);
        
        // === 1분봉 캔들 업데이트 (Lua Script) ===
        redis_->updateCandle(symbol, fill_price, fill_qty, epoch_sec);
    }
    
    // buyer/seller ID 추출
    // buyer/seller ID 추출
    const std::string& buyer_id = order->is_buy() ? 
        order->user_id() : matched_order->user_id();
    const std::string& seller_id = order->is_buy() ? 
        matched_order->user_id() : order->user_id();
    
    // === Kinesis Fan-Out Publishing ===
    // Engine -> Kinesis -> [DB, Notifier, Balance]
    if (producer_) {
        const std::string& bo = order->is_buy() ? order->order_id() : matched_order->order_id();
        const std::string& so = order->is_buy() ? matched_order->order_id() : order->order_id();
        
        producer_->publishFill(symbol, bo, so, buyer_id, seller_id, fill_qty, fill_price);
        Logger::info("PUBLISHED_FILL:", symbol, fill_price, "x", fill_qty);
    }

    // Ticker 캐시 업데이트 (Sub 데이터용)
    updateTickerCache(symbol, fill_price);
    
    // Legacy Notification & DynamoDB Removed for Fan-Out Architecture
}


void MarketDataHandler::on_cancel(const OrderPtr& order) {
    Logger::info("Order CANCELLED:", order->order_id());
    
    if (notifier_) {
        std::string side = order->is_buy() ? "BUY" : "SELL";
        std::string type = (order->price() == 0) ? "MARKET" : "LIMIT";
        notifier_->sendOrderStatus(order->user_id(), order->order_id(), 
                                   order->symbol(), side, order->price(), order->order_qty(), type, 
                                   order->filled_qty(), 0, "CANCELLED");
    }
}

void MarketDataHandler::on_cancel_reject(const OrderPtr& order, const char* reason) {
    Logger::warn("Cancel REJECTED:", order->order_id(), "reason:", reason);
    
    if (notifier_) {
        std::string side = order->is_buy() ? "BUY" : "SELL";
        std::string type = (order->price() == 0) ? "MARKET" : "LIMIT";
        notifier_->sendOrderStatus(order->user_id(), order->order_id(), 
                                   order->symbol(), side, order->price(), order->order_qty(), type, 
                                   order->filled_qty(), 0, "CANCEL_REJECTED", reason);
    }
}

void MarketDataHandler::on_replace(const OrderPtr& order,
                                    const int64_t& size_delta,
                                    liquibook::book::Price new_price) {
    Logger::info("Order REPLACED:", order->order_id(), 
                 "delta:", size_delta, "new_price:", new_price);
    
    if (notifier_) {
        std::string side = order->is_buy() ? "BUY" : "SELL";
        std::string type = (order->price() == 0) ? "MARKET" : "LIMIT";
        notifier_->sendOrderStatus(order->user_id(), order->order_id(), 
                                   order->symbol(), side, order->price(), order->order_qty(), type, 
                                   order->filled_qty(), 0, "REPLACED");
    }
}

void MarketDataHandler::on_replace_reject(const OrderPtr& order, const char* reason) {
    Logger::warn("Replace REJECTED:", order->order_id(), "reason:", reason);
    
    if (notifier_) {
        std::string side = order->is_buy() ? "BUY" : "SELL";
        std::string type = (order->price() == 0) ? "MARKET" : "LIMIT";
        notifier_->sendOrderStatus(order->user_id(), order->order_id(), 
                                   order->symbol(), side, order->price(), order->order_qty(), type, 
                                   order->filled_qty(), 0, "REPLACE_REJECTED", reason);
    }
}

void MarketDataHandler::on_trade(const OrderBook* book,
                                  liquibook::book::Quantity qty,
                                  liquibook::book::Price price) {
    std::string symbol = book->symbol();
    Logger::info("TRADE:", symbol, "qty:", qty, "price:", price);
    
    Metrics::instance().incrementTradesExecuted();
    
    // 00:00 리셋 확인 및 OHLC 업데이트
    checkDayReset(symbol);
    DayData& day = getDayData(symbol);
    
    // 시가 설정 (당일 첫 체결)
    if (day.open_price == 0) {
        day.open_price = price;
        day.high_price = price;
        day.low_price = price;
    }
    
    // 고가/저가 업데이트
    if (price > day.high_price) day.high_price = price;
    if (price < day.low_price) day.low_price = price;
    
    // 현재가 및 변동률 계산
    day.last_price = price;
    if (day.open_price > 0) {
        day.change_rate = ((double)price - (double)day.open_price) / (double)day.open_price * 100.0;
    }
    
    // Ticker 캐시 업데이트 (Sub 데이터용)
    updateTickerCache(symbol, price);
    
    if (producer_) {
        producer_->publishTrade(symbol, qty, price);
    }
}

void MarketDataHandler::on_depth_change(const OrderBook* book,
                                         const BookDepth* depth) {
    std::string symbol = book->symbol();
    Logger::debug("on_depth_change called for:", symbol);
    
    // 컴팩트 포맷: {"e":"d","s":"SYM","t":123,"b":[[p,q],...],"a":[[p,q],...]}
    nlohmann::json depth_json;
    depth_json["e"] = "d";  // event = depth
    depth_json["s"] = symbol;
    
    // Bids (최대 20개)
    nlohmann::json bids_arr = nlohmann::json::array();
    const liquibook::book::DepthLevel* bid = depth->bids();
    const liquibook::book::DepthLevel* bid_end = depth->last_bid_level() + 1;
    int count = 0;
    for (; bid != bid_end && count < 20; ++bid) {
        if (bid->order_count() > 0) {
            bids_arr.push_back({bid->price(), bid->aggregate_qty()});
            count++;
        }
    }
    depth_json["b"] = bids_arr;
    
    // Asks (최대 20개)
    nlohmann::json asks_arr = nlohmann::json::array();
    const liquibook::book::DepthLevel* ask = depth->asks();
    const liquibook::book::DepthLevel* ask_end = depth->last_ask_level() + 1;
    count = 0;
    for (; ask != ask_end && count < 20; ++ask) {
        if (ask->order_count() > 0) {
            asks_arr.push_back({ask->price(), ask->aggregate_qty()});
            count++;
        }
    }
    depth_json["a"] = asks_arr;
    
    depth_json["t"] = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    
    // 변동률 추가 (Main 데이터에도 포함) - 항상 포함
    DayData& day = getDayData(symbol);
    depth_json["c"] = std::round(day.change_rate * 100) / 100.0;
    depth_json["yc"] = std::round(day.prev_change_rate * 100) / 100.0;
    depth_json["p"] = day.last_price;  // 현재가도 추가
    
    // DEBUG: 저장 전 depth_json 내용 출력
    Logger::info("DEPTH_DEBUG:", symbol, 
                 "c=", day.change_rate, 
                 "yc=", day.prev_change_rate, 
                 "p=", day.last_price,
                 "json_c=", depth_json["c"].dump(),
                 "json_yc=", depth_json["yc"].dump(),
                 "json_p=", depth_json["p"].dump());
    
    // Valkey에 depth 캐시 저장 (Streaming Server가 읽어감)
    Logger::debug("Depth cache check - redis_:", redis_ ? "exists" : "null", 
                  "connected:", (redis_ && redis_->isConnected()) ? "yes" : "no");
    if (redis_ && redis_->isConnected()) {
        std::string key = "depth:" + symbol;
        std::string json_str = depth_json.dump();
        Logger::info("DEPTH_SAVE:", key, "=", json_str.substr(0, 200));  // 앞 200자만
        bool saved = redis_->set(key, json_str);
        if (saved) {
            Logger::info("Depth saved OK:", key);
        } else {
            Logger::warn("Failed to save depth to Valkey:", key);
        }
    } else {
        Logger::warn("Depth cache not connected, skipping save for:", symbol);
    }
    
    // 참고: Kinesis 발행 제거됨 - Streaming Server 방식으로 전환
    // producer_->publishDepth(symbol, depth_json);  // DEPRECATED
}

void MarketDataHandler::on_bbo_change(const OrderBook* book,
                                       const BookDepth* depth) {
    // BBO 변경 시 depth 업데이트도 발행
    Logger::debug("BBO change for:", book->symbol());
    on_depth_change(book, depth);
}

// === Day Data 관리 ===

DayData& MarketDataHandler::getDayData(const std::string& symbol) {
    return symbol_day_data_[symbol];
}

int MarketDataHandler::getCurrentTradingDay() const {
    auto now = std::chrono::system_clock::now();
    std::time_t t = std::chrono::system_clock::to_time_t(now);
    std::tm tm = *std::localtime(&t);
    return (tm.tm_year + 1900) * 10000 + (tm.tm_mon + 1) * 100 + tm.tm_mday;
}

void MarketDataHandler::checkDayReset(const std::string& symbol) {
    int today = getCurrentTradingDay();
    DayData& day = symbol_day_data_[symbol];
    
    if (day.trading_day != today) {
        // 전일 데이터 저장 (Valkey에 백업)
        if (day.trading_day > 0 && day.open_price > 0) {
            savePrevDayData(symbol, day);
        }
        
        // 전일 변동률 보존 후 리셋
        double prev_change = day.change_rate;
        day = DayData{};
        day.trading_day = today;
        day.prev_change_rate = prev_change;
        
        Logger::info("Day reset for", symbol, "new trading day:", today);
    }
}

void MarketDataHandler::savePrevDayData(const std::string& symbol, const DayData& data) {
    if (!redis_ || !redis_->isConnected()) return;
    
    nlohmann::json prev;
    prev["symbol"] = symbol;
    prev["date"] = data.trading_day;
    prev["open"] = data.open_price;
    prev["high"] = data.high_price;
    prev["low"] = data.low_price;
    prev["close"] = data.last_price;
    prev["change_rate"] = data.change_rate;
    
    // Valkey에 전일 데이터 저장
    redis_->set("prev:" + symbol, prev.dump());
    Logger::info("Saved prev day data:", symbol, "change:", data.change_rate, "%");
}

void MarketDataHandler::updateTickerCache(const std::string& symbol, uint64_t price) {
    if (!redis_ || !redis_->isConnected()) return;
    
    const DayData& day = symbol_day_data_[symbol];
    
    // Ticker JSON (Sub 데이터용)
    nlohmann::json ticker;
    ticker["e"] = "t";  // event = ticker
    ticker["s"] = symbol;
    ticker["t"] = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    ticker["p"] = price;
    ticker["c"] = std::round(day.change_rate * 100) / 100.0;  // 소수점 2자리
    ticker["yc"] = std::round(day.prev_change_rate * 100) / 100.0;
    
    redis_->set("ticker:" + symbol, ticker.dump());
    Logger::debug("Ticker saved:", symbol, "price:", price, "change:", day.change_rate, "%");
}

} // namespace aws_wrapper

