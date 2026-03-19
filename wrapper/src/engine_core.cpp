#include "engine_core.h"
#include "redis_client.h"
#include "logger.h"
#include <mutex>
#include <nlohmann/json.hpp>

namespace aws_wrapper {

EngineCore::EngineCore(MarketDataHandler* handler, RedisClient* redis)
    : handler_(handler), operating_redis_(redis) {
    // MarketDataHandler에 EngineCore 참조 설정 (완전 체결된 주문 제거용)
    if (handler_) {
        handler_->setEngineCore(this);
    }
    Logger::info("EngineCore initialized");
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
