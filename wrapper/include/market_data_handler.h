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

class RedisClient;          // forward declaration
class EngineCore;           // forward declaration
class RankingManager;       // forward declaration

// Depth levels: 10 bid + 10 ask
using OrderBook = liquibook::book::DepthOrderBook<OrderPtr, 10>;
using BookDepth = liquibook::book::Depth<10>;

// 일일 시장 데이터 (OHLC)
struct DayData {
    uint64_t open_price = 0;    // 당일 시가 (첫 체결가)
    uint64_t high_price = 0;    // 당일 고가
    uint64_t low_price = 0;     // 당일 저가
    uint64_t last_price = 0;    // 현재가 (마지막 체결가)
    uint64_t volume = 0;        // 당일 거래량
    int trading_day = 0;        // 거래일 (YYYYMMDD)
};

class MarketDataHandler
    : public liquibook::book::OrderListener<OrderPtr>
    , public liquibook::book::TradeListener<OrderBook>
    , public liquibook::book::DepthListener<OrderBook>
    , public liquibook::book::BboListener<OrderBook>
{
public:
    // depth/ticker 캐시 TTL(초). 엔진이 죽으면 만료되어 스트리머가 스테일 시장데이터를
    // 계속 브로드캐스트하지 못하게 한다. 정상 운영 중에는 갱신 주기가 훨씬 짧아 무해.
    static constexpr int MARKET_DATA_TTL_SECONDS = 60;

    explicit MarketDataHandler(IProducer* producer,
                               RedisClient* depth_redis = nullptr,
                               RedisClient* candle_redis = nullptr,
                               RankingManager* ranking_manager = nullptr);
    
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

    // 직전 체결가(가격 밴드 기준가). 체결 이력이 없으면 0. 엔트리를 생성하지 않는다.
    uint64_t getLastPrice(const std::string& symbol) const;

    // EngineCore 설정 (완전 체결된 주문 제거용)
    void setEngineCore(EngineCore* engine) { engine_ = engine; }

private:
    IProducer* producer_;
    RedisClient* depth_redis_;
    RedisClient* candle_redis_;
    RankingManager* ranking_manager_;
    EngineCore* engine_ = nullptr;
    std::unordered_map<std::string, DayData> symbol_day_data_;
    
    void updateTickerCache(const std::string& symbol, uint64_t price);
};

} // namespace aws_wrapper
