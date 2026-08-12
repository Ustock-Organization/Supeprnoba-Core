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
            // 기준가 동결: halt를 유발한 그 체결가로 기준가를 갱신하면, 해제 후 그 가격이
            // 정상가로 취급되어 같은 폭으로 다시 밀 수 있다(halt는 조작을 지연시킬 뿐
            // 막지 못한다). 정통 VI처럼 충격 이전 가격을 기준으로 유지한다.
        } else {
            vi_last_price_[symbol] = fill_price;
        }
    }

    if (newly_halted) {
        Logger::warn("VI HALT:", symbol, "price:", fill_price,
                     "(급변 ±", vi_dynamic_pct_ * 100.0, "% 초과) —", vi_halt_seconds_, "s 정지");
        // 상태 전파: MM·스트리머·프론트가 구독. MM은 halt 시 호가를 걷어야 함(재개 단일가 왜곡 방지).
        // TTL을 halt 길이로 걸어, 거래가 끊겨 아무도 addOrder를 호출하지 않아도(자동 해제가
        // addOrder에만 의존) 상태 키가 스스로 만료되게 한다 — HALTED 영구 고착 방지.
        if (operating_redis_ && operating_redis_->isConnected()) {
            operating_redis_->setEx("symbol:" + symbol + ":state", "HALTED", vi_halt_seconds_);
            operating_redis_->publish("symbol:state",
                                      "{\"symbol\":\"" + symbol + "\",\"state\":\"HALTED\"}");
        }
    }
}

uint64_t EngineCore::viReferencePrice(const std::string& symbol) const {
    std::lock_guard<std::mutex> lock(vi_mutex_);
    auto it = vi_last_price_.find(symbol);
    return it == vi_last_price_.end() ? 0 : it->second;
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
            operating_redis_->publish("symbol:state",
                                      "{\"symbol\":\"" + symbol + "\",\"state\":\"CONTINUOUS\"}");
        }
        return false;
    }
    return true;
}

bool EngineCore::violatesPriceBand(const OrderPtr& order) const {
    if (price_band_pct_ <= 0.0) return false;              // 비활성
    const liquibook::book::Price px = order->price();
    if (px == 0) return false;                              // MARKET SELL(price=0)
    // MARKET BUY는 collar 때문에 price=max_price(0이 아님)로 들어온다. 이는 "얼마까지
    // 지불할 수 있다"는 상한이지 호가가 아니므로 밴드로 판정하면 안 된다 — 얇은 종목에서
    // 정상 시장가 매수가 상시 거부된다. 시장가의 과도한 가격 이동은 VI가 담당한다.
    if (order->order_type() == "MARKET") return false;
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

        // Dedup Layer 2: 이미 북에 살아 있는 주문의 재등록 차단.
        // processed_orders_는 메모리 전용(재시작 시 비고, TTL도 짧음)이라 Layer 1만으로는
        // 스냅샷 복원 + 앵커 리플레이가 만드는 중복 ADD를 걸러내지 못한다. 통과시키면
        // liquibook이 같은 order_id로 Tracker를 하나 더 만들어 북에 이중 등록되고,
        // order_maps_ 엔트리는 덮어써져 옛 사본이 취소·조회 불가능한 유령 유동성이 된다.
        {
            auto sym_it = order_maps_.find(symbol);
            if (sym_it != order_maps_.end() &&
                sym_it->second.find(order_id) != sym_it->second.end()) {
                Logger::warn("DUPLICATE order rejected (already resting in book):",
                             order_id, symbol);
                ++duplicates_rejected_;
                return false;
            }
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

        // Liquibook에 추가 — conditions(IOC/AON)를 반드시 전달해야 한다.
        // liquibook의 OrderTracker는 add()로 받은 conditions만 신뢰한다: 주문 자체의
        // 플래그를 읽는 폴백은 (a) LIQUIBOOK_ORDER_KNOWS_CONDITIONS 매크로로 막혀 있고
        // (b) 멤버 초기화 리스트에서 conditions_를 이미 설정한 뒤 지역 변수만 수정하는
        // 버그라 무효다. 전달하지 않으면 IOC가 통째로 무시되어, 미체결 시장가 주문이
        // 취소되지 않고 북에 잔류한다 — MARKET SELL은 price=0으로 남아 이후 들어오는
        // 매수를 전부 쓸어간다.
        book->add(order, order->conditions());
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

                // 부분체결 주문은 "잔량"으로 등재해야 한다. liquibook의 OrderTracker는
                // open_qty를 order_qty()로 초기화하며 filled_qty를 모르기 때문에, 원주문
                // 수량 그대로 넣으면 이미 체결된 몫이 되살아나 잠금수량을 초과 체결한다.
                // (DynamoDB 복원 경로는 remaining으로 넣고 있어 규칙을 맞춘다)
                const uint64_t ordered = order->order_qty();
                const uint64_t filled = order->filled_qty();
                if (filled > 0) {
                    if (filled >= ordered) {
                        ++count;   // 이미 전량 체결 — 복원 대상 아님
                        continue;
                    }
                    order->setOrderQty(ordered - filled);
                    order->setFilledQty(0);
                }

                order_maps_[symbol][order->order_id()] = order;
                // 복원은 리스너를 붙이기 전에 수행되므로, 여기서 교차가 일어나면 on_fill이
                // 호출되지 않아 Kinesis 체결 이벤트 없이 잔량만 소멸한다(무음 체결 = 미정산).
                // 정상 스냅샷은 uncrossed여야 하므로 matched=true는 데이터 이상 신호다.
                if (book->add(order)) {
                    ++silent_restore_matches_;
                    Logger::error("복원 중 교차 발생(무음 체결 위험):", symbol,
                                  order->order_id(), "price:", order->price(),
                                  "— 스냅샷이 uncrossed가 아님");
                }
                // 복원된 주문을 dedup에 시딩 — 앵커 리플레이가 같은 ADD를 재전달해도
                // 북에 이중 등록되지 않는다(addOrder의 Layer 2와 이중 방어).
                processed_orders_[order->order_id()] = std::chrono::steady_clock::now();
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
