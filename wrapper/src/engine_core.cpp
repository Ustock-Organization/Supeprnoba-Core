#include "engine_core.h"
#include "redis_client.h"
#include "logger.h"
#include "config.h"
#include <mutex>
#include <cstdlib>
#include <cmath>
#include <nlohmann/json.hpp>

namespace aws_wrapper {

EngineCore::EngineCore(MarketDataHandler* handler, RedisClient* redis)
    : handler_(handler), operating_redis_(redis) {
    // MarketDataHandler에 EngineCore 참조 설정 (완전 체결된 주문 제거용)
    if (handler_) {
        handler_->setEngineCore(this);
    }
    // 가격 밴드 폭 (예: 0.5 = ±50%). 0/미설정이면 비활성.
    try {
        price_band_pct_ = std::stod(Config::get("PRICE_BAND_PCT", "0"));
    } catch (...) {
        price_band_pct_ = 0.0;
    }
    if (price_band_pct_ > 0.0) {
        Logger::info("Price band enabled: ±", price_band_pct_ * 100.0, "% of last trade");
    }
    // VI 서킷브레이커 설정
    try {
        vi_dynamic_pct_ = std::stod(Config::get("VI_DYNAMIC_PCT", "0"));
    } catch (...) {
        vi_dynamic_pct_ = 0.0;
    }
    vi_halt_seconds_ = std::stoi(Config::get("VI_HALT_SECONDS", "120"));
    if (vi_dynamic_pct_ > 0.0) {
        Logger::info("VI circuit breaker enabled: ±", vi_dynamic_pct_ * 100.0,
                     "% dynamic, halt", vi_halt_seconds_, "s");
    }
    Logger::info("EngineCore initialized");
}

bool EngineCore::exceedsViThreshold(uint64_t ref_price, uint64_t cur_price, double pct) {
    if (pct <= 0.0 || ref_price == 0) return false;
    const double change = std::abs(static_cast<double>(cur_price) -
                                   static_cast<double>(ref_price)) /
                          static_cast<double>(ref_price);
    return change >= pct;
}

void EngineCore::onTradeForVI(const std::string& symbol, uint64_t fill_price) {
    if (vi_dynamic_pct_ <= 0.0 || fill_price == 0) return;

    bool newly_halted = false;
    {
        std::lock_guard<std::mutex> lock(vi_mutex_);
        auto it = vi_last_price_.find(symbol);
        if (it != vi_last_price_.end() &&
            exceedsViThreshold(it->second, fill_price, vi_dynamic_pct_)) {
            halt_until_[symbol] = std::chrono::steady_clock::now() +
                                  std::chrono::seconds(vi_halt_seconds_);
            newly_halted = true;
        }
        vi_last_price_[symbol] = fill_price;
    }

    if (newly_halted) {
        Logger::warn("VI HALT:", symbol, "price:", fill_price,
                     "(급변 ±", vi_dynamic_pct_ * 100.0, "% 초과) —", vi_halt_seconds_, "s 정지");
        // 상태 전파: MM·스트리머·프론트가 구독. MM은 halt 시 호가를 걷어야 함(재개 단일가 왜곡 방지).
        if (operating_redis_ && operating_redis_->isConnected()) {
            operating_redis_->set("symbol:" + symbol + ":state", "HALTED");
        }
    }
}

bool EngineCore::isHalted(const std::string& symbol) {
    if (vi_dynamic_pct_ <= 0.0) return false;
    std::lock_guard<std::mutex> lock(vi_mutex_);
    auto it = halt_until_.find(symbol);
    if (it == halt_until_.end()) return false;
    if (std::chrono::steady_clock::now() >= it->second) {
        // 자동 해제
        halt_until_.erase(it);
        if (operating_redis_ && operating_redis_->isConnected()) {
            operating_redis_->set("symbol:" + symbol + ":state", "CONTINUOUS");
        }
        return false;
    }
    return true;
}

bool EngineCore::violatesPriceBand(const OrderPtr& order) const {
    if (price_band_pct_ <= 0.0) return false;              // 비활성
    const liquibook::book::Price px = order->price();
    if (px == 0) return false;                              // MARKET 주문은 밴드 대상 아님
    if (!handler_) return false;
    const uint64_t ref = handler_->getLastPrice(order->symbol());
    if (ref == 0) return false;                             // 첫 거래 전 = 가격 발견 전, 통과

    const double lo = ref * (1.0 - price_band_pct_);
    const double hi = ref * (1.0 + price_band_pct_);
    return (static_cast<double>(px) < lo) || (static_cast<double>(px) > hi);
}

bool EngineCore::isMarketMaker(const std::string& user_id) {
    // MM 계정은 mm-buyer/mm-seller 등 두 ID로 의도적 자전체결을 하므로 STP 면제.
    // restoreOrderBook의 MM 판별과 동일 기준(단일 진실원천 유지 목적).
    return user_id.rfind("mm-", 0) == 0 || user_id.rfind("mm_", 0) == 0;
}

int EngineCore::applySelfTradePrevention(const std::string& symbol,
                                          const OrderPtr& aggressor) {
    // 락(rw_mutex_) 보유 상태에서 호출됨.
    // MM aggressor는 면제 — 의도적 유동성 공급.
    if (isMarketMaker(aggressor->user_id())) return 0;

    auto book_it = books_.find(symbol);
    auto map_it = order_maps_.find(symbol);
    if (book_it == books_.end() || map_it == order_maps_.end()) return 0;

    const std::string& uid = aggressor->user_id();
    const bool agg_buy = aggressor->is_buy();
    const liquibook::book::Price agg_price = aggressor->price();
    // 시장가(price==0)는 반대편 전 구간과 교차 가능 → 모든 동일 유저 resting을 대상.
    const bool agg_is_market = (agg_price == 0);

    // iteration 중 erase 방지 위해 대상을 먼저 수집.
    std::vector<OrderPtr> to_cancel;
    for (const auto& [id, resting] : map_it->second) {
        if (resting->open_qty() == 0) continue;
        if (resting->user_id() != uid) continue;      // 동일 유저만
        if (resting->is_buy() == agg_buy) continue;    // 반대 방향만
        if (isMarketMaker(resting->user_id())) continue;

        // 교차 판정: BUY aggressor는 price >= resting(SELL) 이면 체결,
        //            SELL aggressor는 price <= resting(BUY) 이면 체결.
        bool crosses = agg_is_market ||
            (agg_buy ? agg_price >= resting->price()
                     : agg_price <= resting->price());
        if (crosses) to_cancel.push_back(resting);
    }

    for (const auto& resting : to_cancel) {
        // cancel-oldest: resting 취소 → on_cancel 발행(프로세서가 잔고 락 해제).
        book_it->second->cancel(resting);
        book_it->second->perform_callbacks();
        map_it->second.erase(resting->order_id());
        ++self_trades_prevented_;
        Logger::warn("STP: cancelled resting order", resting->order_id(),
                     "(user", uid, "symbol", symbol,
                     ") to prevent self-trade with", aggressor->order_id());
    }
    return static_cast<int>(to_cancel.size());
}

OrderPtr EngineCore::findOrder(const std::string& symbol,
                                const std::string& order_id) {
    auto sym_it = order_maps_.find(symbol);
    if (sym_it == order_maps_.end()) return nullptr;
    
    auto ord_it = sym_it->second.find(order_id);
    if (ord_it == sym_it->second.end()) return nullptr;
    
    return ord_it->second;
}

EngineCore::OrderBookPtr EngineCore::getOrCreateBook(const std::string& symbol) {
    auto it = books_.find(symbol);
    if (it != books_.end()) {
        return it->second;
    }

    // 삭제/차단된 종목인지 Valkey에서 확인
    if (operating_redis_ && operating_redis_->isConnected()) {
        if (operating_redis_->sismember("deleted:symbols", symbol) ||
            operating_redis_->sismember("blocked:symbols", symbol)) {
            Logger::warn("Blocked symbol, refusing to create OrderBook:", symbol);
            return nullptr;
        }
    }

    auto book = std::make_shared<OrderBook>();
    book->set_symbol(symbol);
    
    // 리스너 등록 (TradeListener는 타입 불일치로 on_fill에서 처리)
    book->set_order_listener(handler_);
    book->set_depth_listener(handler_);
    book->set_bbo_listener(handler_);
    
    books_[symbol] = book;
    order_maps_[symbol] = {};
    
    Logger::info("Created OrderBook for symbol:", symbol);
    return book;
}

bool EngineCore::addOrder(OrderPtr order) {
    std::string order_id = order->order_id();
    std::string symbol = order->symbol();

    {
        std::unique_lock<std::shared_mutex> lock(rw_mutex_);

        // Dedup Layer 1: reject recently processed orders (Kinesis at-least-once defense)
        auto dedup_it = processed_orders_.find(order_id);
        if (dedup_it != processed_orders_.end()) {
            auto age_s = std::chrono::duration_cast<std::chrono::seconds>(
                std::chrono::steady_clock::now() - dedup_it->second).count();
            Logger::warn("DUPLICATE order rejected:", order_id, symbol,
                         "(processed", age_s, "s ago)");
            ++duplicates_rejected_;
            return false;
        }

        auto book = getOrCreateBook(symbol);

        if (!book) {
            lock.unlock();
            // REJECTED 콜백 발행 (on_reject은 Kinesis로 REJECTED 이벤트 전송)
            if (handler_) {
                handler_->on_reject(order, "Symbol is blocked or deleted");
            }
            Logger::warn("Order rejected (blocked/deleted symbol):", order_id, symbol);
            return false;
        }

        // VI 서킷브레이커: halt 중인 종목의 신규 주문 거부 (무결성 원칙: halt 검사가 밴드보다 우선).
        if (isHalted(symbol)) {
            ++vi_halt_rejects_;
            lock.unlock();
            if (handler_) {
                handler_->on_reject(order, "Symbol halted (volatility interruption)");
            }
            Logger::warn("Order rejected (VI halt):", order_id, symbol);
            return false;
        }

        // 가격 밴드: 직전 체결가 대비 과도하게 벗어난 LIMIT 주문 거부 (fat-finger·조작 차단).
        if (violatesPriceBand(order)) {
            ++price_band_rejects_;
            lock.unlock();
            if (handler_) {
                handler_->on_reject(order, "Price outside allowed band");
            }
            Logger::warn("Order rejected (price band):", order_id, symbol,
                         "price:", order->price(),
                         "last:", handler_ ? handler_->getLastPrice(symbol) : 0);
            return false;
        }

        // Self-Trade Prevention (cancel-oldest): 동일 유저의 반대편 resting 주문을
        // aggressor 추가 전에 취소해 자전체결을 원천 차단. MM 계정은 면제.
        applySelfTradePrevention(symbol, order);

        // 주문 맵에 저장
        order_maps_[symbol][order_id] = order;

        // Liquibook에 추가
        book->add(order);
        book->perform_callbacks();

        ++total_orders_processed_;

        // Record processed order for dedup
        processed_orders_[order_id] = std::chrono::steady_clock::now();

        // Periodic TTL cleanup (every 1000 orders)
        if (total_orders_processed_ % 1000 == 0) {
            cleanupProcessedOrders();
        }
    }

    Logger::debug("Order added:", order_id, symbol);
    return true;
}

bool EngineCore::cancelOrder(const std::string& symbol,
                              const std::string& order_id) {
    {
        std::unique_lock<std::shared_mutex> lock(rw_mutex_);

        auto order = findOrder(symbol, order_id);
        if (!order) {
            lock.unlock();
            Logger::warn("Cancel failed - order not found:", order_id);
            return false;
        }

        auto it = books_.find(symbol);
        if (it == books_.end()) return false;

        it->second->cancel(order);
        it->second->perform_callbacks();

        // 주문 맵에서 제거
        order_maps_[symbol].erase(order_id);
    }

    Logger::info("Order cancelled:", order_id);
    return true;
}

bool EngineCore::replaceOrder(const std::string& symbol,
                               const std::string& order_id,
                               int64_t qty_delta,
                               liquibook::book::Price new_price) {
    {
        std::unique_lock<std::shared_mutex> lock(rw_mutex_);

        auto order = findOrder(symbol, order_id);
        if (!order) {
            lock.unlock();
            Logger::warn("Replace failed - order not found:", order_id);
            return false;
        }

        auto it = books_.find(symbol);
        if (it == books_.end()) return false;

        it->second->replace(order, qty_delta, new_price);
        it->second->perform_callbacks();
    }

    Logger::info("Order replaced:", order_id, "delta:", qty_delta, "price:", new_price);
    return true;
}

CancelAllResult EngineCore::cancelAllOrders(const std::string& symbol) {
    CancelAllResult result{0, {}};

    std::unique_lock<std::shared_mutex> lock(rw_mutex_);

    auto book_it = books_.find(symbol);
    if (book_it == books_.end()) {
        Logger::warn("cancelAllOrders: no orderbook for", symbol);
        return result;
    }

    auto map_it = order_maps_.find(symbol);
    if (map_it == order_maps_.end()) {
        return result;
    }

    // 주문 ID 목록을 먼저 수집 (iteration 중 erase 방지)
    std::vector<std::pair<std::string, OrderPtr>> orders_to_cancel;
    for (const auto& [id, order] : map_it->second) {
        if (order->open_qty() > 0) {
            orders_to_cancel.push_back({id, order});
        }
    }

    // 각 주문에 대해 cancel + perform_callbacks 호출
    for (const auto& [id, order] : orders_to_cancel) {
        try {
            book_it->second->cancel(order);
            book_it->second->perform_callbacks();
            // on_cancel 콜백이 Kinesis CANCELLED 이벤트 발행
            // stock-processor가 DynamoDB 업데이트 + locked 해제
            map_it->second.erase(id);
            result.cancelled_count++;
        } catch (const std::exception& e) {
            Logger::error("cancelAllOrders failed for", id, ":", e.what());
            result.failed_order_ids.push_back(id);
        }
    }

    Logger::info("cancelAllOrders:", symbol,
                 "cancelled:", result.cancelled_count,
                 "failed:", result.failed_order_ids.size());
    return result;
}

void EngineCore::removeFilledOrderUnsafe(const std::string& symbol,
                                          const std::string& order_id) {
    // 락이 이미 보유된 상태에서 호출됨 (콜백 컨텍스트)
    auto sym_it = order_maps_.find(symbol);
    if (sym_it == order_maps_.end()) return;

    auto ord_it = sym_it->second.find(order_id);
    if (ord_it == sym_it->second.end()) return;

    sym_it->second.erase(ord_it);
    Logger::info("Filled order removed from map:", order_id, "symbol:", symbol);
}

std::string EngineCore::snapshotOrderBook(const std::string& symbol) {
    nlohmann::json snapshot;
    size_t order_count = 0;

    {
        std::shared_lock<std::shared_mutex> lock(rw_mutex_);

        auto it = order_maps_.find(symbol);
        if (it == order_maps_.end()) {
            return "";
        }

        snapshot["symbol"] = symbol;
        snapshot["timestamp"] = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();

        nlohmann::json orders = nlohmann::json::array();
        for (const auto& [id, order] : it->second) {
            if (order->open_qty() > 0) {
                orders.push_back(order->toJson());
            }
        }
        snapshot["orders"] = orders;
        order_count = orders.size();
    }

    Logger::info("Snapshot created for:", symbol, "orders:", order_count);
    return snapshot.dump();
}

bool EngineCore::restoreOrderBook(const std::string& symbol,
                                   const std::string& data) {
    size_t total = 0;
    size_t mm_skipped = 0;

    try {
        auto snapshot = nlohmann::json::parse(data);

        {
            std::unique_lock<std::shared_mutex> lock(rw_mutex_);

            // 기존 오더북 제거
            books_.erase(symbol);
            order_maps_.erase(symbol);

            // 새 오더북 생성 (리스너 없이)
            auto book = std::make_shared<OrderBook>();
            book->set_symbol(symbol);
            books_[symbol] = book;
            order_maps_[symbol] = {};

            const auto& orders = snapshot["orders"];
            total = orders.size();
            size_t count = 0;
            size_t restored = 0;

            // 프로그레스 바 표시
            std::cout << "\r  Restoring " << symbol << ": [";
            std::cout.flush();

            // 주문 복원 (리스너 없이 조용히)
            for (const auto& j : orders) {
                auto order = Order::fromJson(j);

                // MM(마켓메이커) 주문은 복원하지 않음 — 고아 주문 누적 방지
                const std::string& uid = order->user_id();
                if (uid.find("mm-") == 0 || uid.find("mm_") == 0 ||
                    uid == "mm-bid" || uid == "mm-ask" ||
                    uid == "mm-kinesis-direct-buy" || uid == "mm-kinesis-direct-sell") {
                    ++mm_skipped;
                    ++count;
                    continue;
                }

                order_maps_[symbol][order->order_id()] = order;
                book->add(order);
                ++restored;

                // 프로그레스 업데이트
                ++count;
                if (total > 0) {
                    int progress = (count * 50) / total;
                    static int last_progress = -1;
                    if (progress != last_progress) {
                        std::cout << "\r  Restoring " << symbol << ": [";
                        for (int i = 0; i < 50; ++i) {
                            if (i < progress) std::cout << "█";
                            else std::cout << "░";
                        }
                        std::cout << "] " << count << "/" << total;
                        std::cout.flush();
                        last_progress = progress;
                    }
                }
            }

            std::cout << "\r  Restoring " << symbol << ": [";
            for (int i = 0; i < 50; ++i) std::cout << "█";
            std::cout << "] " << restored << "/" << total
                      << (mm_skipped > 0 ? " (MM skipped: " + std::to_string(mm_skipped) + ")" : "")
                      << " ✓" << std::endl;

            // 리스너 등록 (복원 완료 후)
            book->set_order_listener(handler_);
            book->set_depth_listener(handler_);
            book->set_bbo_listener(handler_);
        }

        Logger::info("OrderBook restored:", symbol, "orders:", total - mm_skipped,
                     "mm_skipped:", mm_skipped);
        return true;
    } catch (const std::exception& e) {
        Logger::error("Failed to restore orderbook:", e.what());
        return false;
    }
}

bool EngineCore::removeOrderBook(const std::string& symbol) {
    {
        std::unique_lock<std::shared_mutex> lock(rw_mutex_);
        books_.erase(symbol);
        order_maps_.erase(symbol);
    }

    Logger::info("OrderBook removed:", symbol);
    return true;
}

bool EngineCore::hasOrder(const std::string& symbol,
                           const std::string& order_id) const {
    std::shared_lock<std::shared_mutex> lock(rw_mutex_);

    auto sym_it = order_maps_.find(symbol);
    if (sym_it == order_maps_.end()) return false;

    return sym_it->second.find(order_id) != sym_it->second.end();
}

size_t EngineCore::getSymbolCount() const {
    std::shared_lock<std::shared_mutex> lock(rw_mutex_);
    return books_.size();
}

std::vector<std::string> EngineCore::getAllSymbols() const {
    std::shared_lock<std::shared_mutex> lock(rw_mutex_);
    std::vector<std::string> symbols;
    symbols.reserve(books_.size());
    for (const auto& [sym, book] : books_) {
        symbols.push_back(sym);
    }
    return symbols;
}

void EngineCore::cleanupProcessedOrders() {
    // Called within locked section — evict entries older than DEDUP_TTL_SECONDS
    auto now = std::chrono::steady_clock::now();
    size_t evicted = 0;
    for (auto it = processed_orders_.begin(); it != processed_orders_.end(); ) {
        auto age_s = std::chrono::duration_cast<std::chrono::seconds>(
            now - it->second).count();
        if (age_s > DEDUP_TTL_SECONDS) {
            it = processed_orders_.erase(it);
            ++evicted;
        } else {
            ++it;
        }
    }
    if (evicted > 0) {
        Logger::info("Dedup cleanup: evicted", evicted, "entries,",
                     processed_orders_.size(), "remaining");
    }
}

} // namespace aws_wrapper
