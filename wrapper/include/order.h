#pragma once

#include <book/order.h>
#include <book/types.h>
#include <string>
#include <memory>
#include <cstdint>
#include <nlohmann/json.hpp>

namespace aws_wrapper {

class Order : public liquibook::book::Order {
public:
    Order() = default;
    
    // Kafka JSON에서 파싱하여 생성
    static std::shared_ptr<Order> fromJson(const nlohmann::json& j);
    
    // JSON으로 직렬화 (스냅샷용)
    nlohmann::json toJson() const;
    
    // === Liquibook Order 인터페이스 구현 ===
    bool is_buy() const override { return is_buy_; }
    liquibook::book::Price price() const override { return price_; }
    liquibook::book::Quantity order_qty() const override { return order_qty_; }
    liquibook::book::Price stop_price() const override { return stop_price_; }
    bool all_or_none() const override { 
        return (conditions_ & liquibook::book::oc_all_or_none) != 0; 
    }
    bool immediate_or_cancel() const override { 
        return (conditions_ & liquibook::book::oc_immediate_or_cancel) != 0; 
    }
    
    // === 추가 메서드 (non-virtual) ===
    liquibook::book::Quantity open_qty() const { 
        return order_qty_ - filled_qty_; 
    }
    liquibook::book::OrderConditions conditions() const { 
        return conditions_; 
    }
    
    // 체결 처리 (OrderBook에서 호출)
    void fill(liquibook::book::Quantity fill_qty,
              liquibook::book::Cost fill_cost,
              liquibook::book::FillId fill_id);
    
    // Getters
    const std::string& order_id() const { return order_id_; }
    const std::string& user_id() const { return user_id_; }
    const std::string& symbol() const { return symbol_; }
    int64_t timestamp() const { return timestamp_; }
    liquibook::book::Quantity filled_qty() const { return filled_qty_; }
    liquibook::book::Cost filled_cost() const { return filled_cost_; }
    
    // Setters (for testing/restoration)
    void setOrderId(const std::string& id) { order_id_ = id; }
    void setUserId(const std::string& id) { user_id_ = id; }
    void setSymbol(const std::string& sym) { symbol_ = sym; }
    void setIsBuy(bool buy) { is_buy_ = buy; }
    void setPrice(liquibook::book::Price p) { price_ = p; }
    void setOrderQty(liquibook::book::Quantity q) { order_qty_ = q; }
    void setStopPrice(liquibook::book::Price p) { stop_price_ = p; }
    void setConditions(liquibook::book::OrderConditions c) { conditions_ = c; }
    void setTimestamp(int64_t ts) { timestamp_ = ts; }

private:
    std::string order_id_;
    std::string user_id_;
    std::string symbol_;
    bool is_buy_ = true;
    liquibook::book::Price price_ = 0;
    liquibook::book::Quantity order_qty_ = 0;
    liquibook::book::Quantity filled_qty_ = 0;
    liquibook::book::Cost filled_cost_ = 0;
    liquibook::book::Price stop_price_ = 0;
    liquibook::book::OrderConditions conditions_ = 0;
    int64_t timestamp_ = 0;
};

using OrderPtr = std::shared_ptr<Order>;

} // namespace aws_wrapper

