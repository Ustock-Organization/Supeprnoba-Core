#pragma once

#include <book/depth_order_book.h>
#include "order.h"
#include "market_data_handler.h"
#include <chrono>
#include <map>
#include <mutex>
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

    // === VI 서킷브레이커 (동적: 직전 체결가 대비 급변 시 종목 일시정지) ===
    // 체결 콜백(MarketDataHandler)에서 호출. 변동률이 임계 초과면 halt 설정 + 상태 전파.
    void onTradeForVI(const std::string& symbol, uint64_t fill_price);
    // 현재 halt 중인지(자동 해제 포함). 락 없이 호출 가능하도록 자체 뮤텍스 사용.
    bool isHalted(const std::string& symbol);
    // 변동률이 VI 임계를 초과하는지(순수 판정). |cur-ref|/ref >= pct.
    static bool exceedsViThreshold(uint64_t ref_price, uint64_t cur_price, double pct);

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

    // 가격 밴드: LIMIT 주문 가격이 직전 체결가 ±price_band_pct_ 범위를 벗어나면 true(위반).
    // 얇은 종목에서 단일 주문이 가격을 붕괴/급등시키는 fat-finger·조작을 차단.
    // 직전 체결가가 없거나(첫 거래 전) 밴드 비활성(pct<=0)이면 위반 아님.
    bool violatesPriceBand(const OrderPtr& order) const;

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
    uint64_t price_band_rejects_ = 0;
    uint64_t vi_halt_rejects_ = 0;

    // 가격 밴드 폭(직전 체결가 대비 ±비율). 0이면 비활성. PRICE_BAND_PCT env로 설정.
    double price_band_pct_ = 0.0;

    // VI 서킷브레이커 설정/상태
    double vi_dynamic_pct_ = 0.0;      // 동적 VI 임계(직전 체결가 대비). 0이면 비활성.
    int vi_halt_seconds_ = 120;        // halt 지속(초)
    std::unordered_map<std::string, uint64_t> vi_last_price_;   // 심볼별 직전 체결가(VI 기준)
    std::unordered_map<std::string, std::chrono::steady_clock::time_point> halt_until_;
    mutable std::mutex vi_mutex_;      // vi_last_price_/halt_until_ 보호(콜백 스레드/주문 스레드)
};

} // namespace aws_wrapper
