#include "market_data_handler.h"
#include "engine_core.h"
#include "redis_client.h"
#include "notification_client.h"
#include "ranking_manager.h"
#include "iproducer.h"
#include "logger.h"
#include "metrics.h"
#include <book/depth_level.h>
#include <nlohmann/json.hpp>
#include <cmath>



namespace aws_wrapper {

MarketDataHandler::MarketDataHandler(IProducer* producer, RedisClient* redis,
                                     NotificationClient* notifier, RankingManager* ranking_manager)
    : producer_(producer), redis_(redis), notifier_(notifier), ranking_manager_(ranking_manager) {
    Logger::info("MarketDataHandler initialized, Redis:", redis_ ? "connected" : "none",
                 "Notifier:", notifier_ ? "enabled" : "disabled",
                 "RankingManager:", ranking_manager_ ? "enabled" : "disabled");
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
    
    // Kinesis로 ACCEPTED 이벤트 발행 (order-status 스트림) - 주문 정보 포함
    if (producer_) {
        std::string otype = (order->price() == 0) ? "MARKET" : "LIMIT";
        producer_->publishOrderStatus(order->symbol(), order->order_id(),
                                      order->user_id(), "ACCEPTED", "",
                                      order->price(), order->order_qty(), order->is_buy(), otype);
        Logger::info("Published ACCEPTED event to Kinesis:", order->order_id());
    }
}

void MarketDataHandler::on_reject(const OrderPtr& order, const char* reason) {
    Logger::warn("Order REJECTED:", order->order_id(), "reason:", reason);
    Metrics::instance().incrementOrdersRejected();
    
    // WebSocket 알림 전송
    if (notifier_) {
        std::string side = order->is_buy() ? "BUY" : "SELL";
        std::string type = (order->price() == 0) ? "MARKET" : "LIMIT";
        notifier_->sendOrderStatus(order->user_id(), order->order_id(), 
                                   order->symbol(), side, order->price(), order->order_qty(), type, 
                                   0, 0, "REJECTED", reason);
    }
    
    // Kinesis로 REJECTED 이벤트 발행 (order-status 스트림)
    if (producer_) {
        producer_->publishOrderStatus(order->symbol(), order->order_id(),
                                      order->user_id(), "REJECTED", reason ? reason : "");
        Logger::info("Published REJECTED event to Kinesis:", order->order_id());
    }

    // Reject된 주문을 order_maps_에서 제거 (메모리 누수 방지)
    // 콜백 컨텍스트에서는 락이 이미 보유된 상태이므로 Unsafe 버전 사용
    if (engine_) {
        engine_->removeFilledOrderUnsafe(order->symbol(), order->order_id());
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

    // 현재가 업데이트
    day.last_price = fill_price;
    day.volume += fill_qty;  // 거래량 누적

    Logger::info("DayData updated:", symbol, "price:", fill_price, "vol:", day.volume);
    
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
        ohlc["t"] = epoch_sec;  // Unix timestamp (초)
        redis_->set("ohlc:" + symbol, ohlc.dump());
        Logger::debug("OHLC saved:", symbol);

        // === 1분봉 캔들 업데이트 (Lua Script) ===
        redis_->updateCandle(symbol, fill_price, fill_qty, epoch_sec);
    }

    // === 랭킹 업데이트 (거래량/시총만 - 변동률은 Aggregator가 관리) ===
    if (ranking_manager_) {
        uint64_t total_shares = ranking_manager_->getTotalShares(symbol);
        ranking_manager_->updateOnFill(symbol, fill_price, fill_qty, 0.0, total_shares);
    }

    // buyer/seller ID 추출
    const std::string& buyer_id = order->is_buy() ? 
        order->user_id() : matched_order->user_id();
    const std::string& seller_id = order->is_buy() ? 
        matched_order->user_id() : order->user_id();
    
    // 전량 체결 여부 확인 (fill 호출 후 filled_qty 업데이트됨)
    bool order_fully_filled = (order->filled_qty() >= order->order_qty());
    bool matched_order_fully_filled = (matched_order->filled_qty() >= matched_order->order_qty());
    
    // === 부분 체결 실시간 알림 (엔진 직접 전송) ===
    // 전량 체결은 Lambda가 처리하므로 엔진에서는 부분 체결만 알림
    if (notifier_ && (!order_fully_filled || !matched_order_fully_filled)) {
        // 부분 체결된 주문에 대해 실시간 상태 업데이트
        if (!order_fully_filled) {
            std::string side = order->is_buy() ? "BUY" : "SELL";
            std::string type = (order->price() == 0) ? "MARKET" : "LIMIT";
            notifier_->sendOrderStatus(order->user_id(), order->order_id(), 
                                       order->symbol(), side, order->price(), order->order_qty(), type, 
                                       order->filled_qty(), fill_price, "PARTIALLY_FILLED");
            Logger::info("PARTIAL_FILL notification sent:", order->order_id());
        }
        
        if (!matched_order_fully_filled) {
            std::string side = matched_order->is_buy() ? "BUY" : "SELL";
            std::string type = (matched_order->price() == 0) ? "MARKET" : "LIMIT";
            notifier_->sendOrderStatus(matched_order->user_id(), matched_order->order_id(), 
                                       matched_order->symbol(), side, matched_order->price(), matched_order->order_qty(), type, 
                                       matched_order->filled_qty(), fill_price, "PARTIALLY_FILLED");
            Logger::info("PARTIAL_FILL notification sent:", matched_order->order_id());
        }
    }
    
    // === Kinesis Fan-Out Publishing ===
    // Engine -> Kinesis -> [DB, Balance]
    // FILL 이벤트는 fills 스트림으로 발행 (부분/전량 모두)
    if (producer_) {
        const std::string& bo = order->is_buy() ? order->order_id() : matched_order->order_id();
        const std::string& so = order->is_buy() ? matched_order->order_id() : order->order_id();
        
        // buyer/seller 전량 체결 여부 전달
        bool buyer_fully_filled = order->is_buy() ? order_fully_filled : matched_order_fully_filled;
        bool seller_fully_filled = order->is_buy() ? matched_order_fully_filled : order_fully_filled;
        
        // buyer_is_maker: order is inbound (taker), matched_order is maker
        // if order is buy, buyer is taker (not maker)
        // if order is sell, buyer (matched_order) is maker
        bool buyer_is_maker = !order->is_buy();
        producer_->publishFill(symbol, bo, so, buyer_id, seller_id, fill_qty, fill_price,
                               buyer_fully_filled, seller_fully_filled, buyer_is_maker);
        Logger::info("PUBLISHED_FILL:", symbol, fill_price, "x", fill_qty, 
                     "buyer_filled:", buyer_fully_filled, "seller_filled:", seller_fully_filled);
        
        // 전량 체결된 주문은 ORDER_STATUS (FILLED)를 order-status 스트림으로 발행
        if (buyer_fully_filled) {
            std::string buyer_side = order->is_buy() ? "BUY" : "SELL";
            std::string buyer_type = (order->is_buy() ? order->price() : matched_order->price()) == 0 ? "MARKET" : "LIMIT";
            producer_->publishOrderStatus(symbol, bo, buyer_id, "FILLED", "");
            Logger::info("Published FILLED status for buyer:", bo);
        }
        
        if (seller_fully_filled) {
            std::string seller_side = order->is_buy() ? "SELL" : "BUY";
            std::string seller_type = (order->is_buy() ? matched_order->price() : order->price()) == 0 ? "MARKET" : "LIMIT";
            producer_->publishOrderStatus(symbol, so, seller_id, "FILLED", "");
            Logger::info("Published FILLED status for seller:", so);
        }
    }

    // Ticker 캐시 업데이트 (Sub 데이터용)
    updateTickerCache(symbol, fill_price);

    // 완전 체결된 주문을 order_maps_에서 제거 (메모리 누수 방지)
    // 콜백 컨텍스트에서는 락이 이미 보유된 상태이므로 Unsafe 버전 사용
    if (engine_) {
        if (order_fully_filled) {
            engine_->removeFilledOrderUnsafe(symbol, order->order_id());
        }
        if (matched_order_fully_filled) {
            engine_->removeFilledOrderUnsafe(symbol, matched_order->order_id());
        }
    }
}


void MarketDataHandler::on_cancel(const OrderPtr& order) {
    Logger::info("Order CANCELLED:", order->order_id());
    
    // WebSocket 알림 전송
    if (notifier_) {
        std::string side = order->is_buy() ? "BUY" : "SELL";
        std::string type = (order->price() == 0) ? "MARKET" : "LIMIT";
        notifier_->sendOrderStatus(order->user_id(), order->order_id(), 
                                   order->symbol(), side, order->price(), order->order_qty(), type, 
                                   order->filled_qty(), 0, "CANCELLED");
    }
    
    // Kinesis로 CANCEL 이벤트 발행 (DynamoDB 업데이트를 위해)
    if (producer_) {
        producer_->publishOrderStatus(order->symbol(), order->order_id(), 
                                      order->user_id(), "CANCELLED", "");
        Logger::info("Published CANCEL event to Kinesis:", order->order_id());
    }
}

void MarketDataHandler::on_cancel_reject(const OrderPtr& order, const char* reason) {
    Logger::warn("Cancel REJECTED:", order->order_id(), "reason:", reason);
    
    // WebSocket 알림 전송
    if (notifier_) {
        std::string side = order->is_buy() ? "BUY" : "SELL";
        std::string type = (order->price() == 0) ? "MARKET" : "LIMIT";
        notifier_->sendOrderStatus(order->user_id(), order->order_id(), 
                                   order->symbol(), side, order->price(), order->order_qty(), type, 
                                   order->filled_qty(), 0, "CANCEL_REJECTED", reason);
    }
    
    // Kinesis로 CANCEL_REJECTED 이벤트 발행
    if (producer_) {
        producer_->publishOrderStatus(order->symbol(), order->order_id(), 
                                      order->user_id(), "CANCEL_REJECTED", reason ? reason : "");
        Logger::info("Published CANCEL_REJECTED event to Kinesis:", order->order_id());
    }
}

void MarketDataHandler::on_replace(const OrderPtr& order,
                                    const int64_t& size_delta,
                                    liquibook::book::Price new_price) {
    Logger::info("Order REPLACED:", order->order_id(), 
                 "delta:", size_delta, "new_price:", new_price);
    
    // WebSocket 알림 전송
    if (notifier_) {
        std::string side = order->is_buy() ? "BUY" : "SELL";
        std::string type = (order->price() == 0) ? "MARKET" : "LIMIT";
        notifier_->sendOrderStatus(order->user_id(), order->order_id(), 
                                   order->symbol(), side, order->price(), order->order_qty(), type, 
                                   order->filled_qty(), 0, "REPLACED");
    }
    
    // Kinesis로 REPLACED 이벤트 발행
    if (producer_) {
        producer_->publishOrderStatus(order->symbol(), order->order_id(), 
                                      order->user_id(), "REPLACED", "");
        Logger::info("Published REPLACED event to Kinesis:", order->order_id());
    }
}

void MarketDataHandler::on_replace_reject(const OrderPtr& order, const char* reason) {
    Logger::warn("Replace REJECTED:", order->order_id(), "reason:", reason);
    
    // WebSocket 알림 전송
    if (notifier_) {
        std::string side = order->is_buy() ? "BUY" : "SELL";
        std::string type = (order->price() == 0) ? "MARKET" : "LIMIT";
        notifier_->sendOrderStatus(order->user_id(), order->order_id(), 
                                   order->symbol(), side, order->price(), order->order_qty(), type, 
                                   order->filled_qty(), 0, "REPLACE_REJECTED", reason);
    }
    
    // Kinesis로 REPLACE_REJECTED 이벤트 발행
    if (producer_) {
        producer_->publishOrderStatus(order->symbol(), order->order_id(), 
                                      order->user_id(), "REPLACE_REJECTED", reason ? reason : "");
        Logger::info("Published REPLACE_REJECTED event to Kinesis:", order->order_id());
    }
}

void MarketDataHandler::on_trade(const OrderBook* book,
                                  liquibook::book::Quantity qty,
                                  liquibook::book::Price price) {
    // NOTE: on_trade는 더 이상 사용하지 않음 (중복 제거)
    // 모든 체결 처리는 on_fill에서 수행:
    //   - DayData (OHLC) 업데이트
    //   - 1분봉 캔들 업데이트
    //   - 랭킹 업데이트
    //   - Kinesis fills 발행
    // supernoba-trades 스트림을 소비하는 프로세서가 없으므로 publishTrade()도 제거
    (void)book;
    (void)qty;
    (void)price;
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

    // 현재가만 추가 (변동률 c, yc, pc는 클라이언트에서 계산)
    DayData& day = getDayData(symbol);
    depth_json["p"] = day.last_price;
    
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
        // 일일 데이터 리셋 (prev_close는 Aggregator가 관리)
        day = DayData{};
        day.trading_day = today;
        Logger::info("Day reset for", symbol, "new trading day:", today);
    }
}

void MarketDataHandler::updateTickerCache(const std::string& symbol, uint64_t price) {
    if (!redis_ || !redis_->isConnected()) return;

    // Ticker JSON (Sub 데이터용) - 현재가만 전송, 변동률은 클라이언트 계산
    nlohmann::json ticker;
    ticker["e"] = "t";  // event = ticker
    ticker["s"] = symbol;
    ticker["t"] = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    ticker["p"] = price;

    redis_->set("ticker:" + symbol, ticker.dump());
    Logger::debug("Ticker saved:", symbol, "price:", price);
}

} // namespace aws_wrapper

