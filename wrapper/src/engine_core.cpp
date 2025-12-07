#include "engine_core.h"
#include "logger.h"
#include <nlohmann/json.hpp>

namespace aws_wrapper {

EngineCore::EngineCore(MarketDataHandler* handler)
    : handler_(handler) {
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
    
    auto book = std::make_shared<OrderBook>();
    book->set_symbol(symbol);
    
    // 리스너 등록
    book->set_order_listener(handler_);
    // TradeListener는 OrderBook 타입이 달라서 직접 캐스트
    // DepthOrderBook은 OrderBook에서 상속받지만 템플릿 타입이 다름
    // 대신 on_trade 콜백은 MarketDataHandler에서 직접 처리
    book->set_depth_listener(handler_);
    book->set_bbo_listener(handler_);
    
    books_[symbol] = book;
    order_maps_[symbol] = {};
    
    Logger::info("Created OrderBook for symbol:", symbol);
    return book;
}

bool EngineCore::addOrder(OrderPtr order) {
    std::lock_guard<std::mutex> lock(mutex_);
    
    auto book = getOrCreateBook(order->symbol());
    
    // 주문 맵에 저장
    order_maps_[order->symbol()][order->order_id()] = order;
    
    // Liquibook에 추가
    book->add(order);
    book->perform_callbacks();
    
    ++total_orders_processed_;
    
    Logger::info("Order added:", order->order_id(), order->symbol());
    return true;
}

bool EngineCore::cancelOrder(const std::string& symbol, 
                              const std::string& order_id) {
    std::lock_guard<std::mutex> lock(mutex_);
    
    auto order = findOrder(symbol, order_id);
    if (!order) {
        Logger::warn("Cancel failed - order not found:", order_id);
        return false;
    }
    
    auto it = books_.find(symbol);
    if (it == books_.end()) return false;
    
    it->second->cancel(order);
    it->second->perform_callbacks();
    
    // 주문 맵에서 제거
    order_maps_[symbol].erase(order_id);
    
    Logger::info("Order cancelled:", order_id);
    return true;
}

bool EngineCore::replaceOrder(const std::string& symbol, 
                               const std::string& order_id,
                               int64_t qty_delta, 
                               liquibook::book::Price new_price) {
    std::lock_guard<std::mutex> lock(mutex_);
    
    auto order = findOrder(symbol, order_id);
    if (!order) {
        Logger::warn("Replace failed - order not found:", order_id);
        return false;
    }
    
    auto it = books_.find(symbol);
    if (it == books_.end()) return false;
    
    it->second->replace(order, qty_delta, new_price);
    it->second->perform_callbacks();
    
    Logger::info("Order replaced:", order_id, "delta:", qty_delta, "price:", new_price);
    return true;
}

std::string EngineCore::snapshotOrderBook(const std::string& symbol) {
    std::lock_guard<std::mutex> lock(mutex_);
    
    auto it = order_maps_.find(symbol);
    if (it == order_maps_.end()) {
        return "";
    }
    
    nlohmann::json snapshot;
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
    
    Logger::info("Snapshot created for:", symbol, "orders:", orders.size());
    return snapshot.dump();
}

bool EngineCore::restoreOrderBook(const std::string& symbol, 
                                   const std::string& data) {
    std::lock_guard<std::mutex> lock(mutex_);
    
    try {
        auto snapshot = nlohmann::json::parse(data);
        
        // 기존 오더북 제거
        books_.erase(symbol);
        order_maps_.erase(symbol);
        
        // 새 오더북 생성
        auto book = getOrCreateBook(symbol);
        
        // 주문 복원
        for (const auto& j : snapshot["orders"]) {
            auto order = Order::fromJson(j);
            order_maps_[symbol][order->order_id()] = order;
            book->add(order);
        }
        book->perform_callbacks();
        
        Logger::info("OrderBook restored for:", symbol);
        return true;
    } catch (const std::exception& e) {
        Logger::error("Failed to restore orderbook:", e.what());
        return false;
    }
}

bool EngineCore::removeOrderBook(const std::string& symbol) {
    std::lock_guard<std::mutex> lock(mutex_);
    
    books_.erase(symbol);
    order_maps_.erase(symbol);
    
    Logger::info("OrderBook removed:", symbol);
    return true;
}

size_t EngineCore::getSymbolCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return books_.size();
}

size_t EngineCore::getOrderCount(const std::string& symbol) const {
    std::lock_guard<std::mutex> lock(mutex_);
    
    auto it = order_maps_.find(symbol);
    if (it == order_maps_.end()) return 0;
    return it->second.size();
}

std::vector<std::string> EngineCore::getAllSymbols() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<std::string> symbols;
    symbols.reserve(books_.size());
    for (const auto& [sym, book] : books_) {
        symbols.push_back(sym);
    }
    return symbols;
}

} // namespace aws_wrapper
