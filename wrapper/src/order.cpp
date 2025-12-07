#include "order.h"
#include "logger.h"
#include <chrono>

namespace aws_wrapper {

std::shared_ptr<Order> Order::fromJson(const nlohmann::json& j) {
    auto order = std::make_shared<Order>();
    
    order->order_id_ = j.value("order_id", "");
    order->user_id_ = j.value("user_id", "");
    order->symbol_ = j.value("symbol", "");
    
    // is_buy (boolean) 또는 side (string) 둘 다 지원
    if (j.contains("is_buy")) {
        order->is_buy_ = j["is_buy"].get<bool>();
    } else {
        std::string side = j.value("side", "BUY");
        order->is_buy_ = (side == "BUY" || side == "buy");
    }
    
    order->price_ = j.value("price", 0);
    order->order_qty_ = j.value("quantity", 0);
    order->stop_price_ = j.value("stop_price", 0);
    
    // Conditions 파싱
    if (j.contains("conditions")) {
        auto& cond = j["conditions"];
        if (cond.value("all_or_none", false)) {
            order->conditions_ |= liquibook::book::oc_all_or_none;
        }
        if (cond.value("immediate_or_cancel", false)) {
            order->conditions_ |= liquibook::book::oc_immediate_or_cancel;
        }
    }
    
    order->timestamp_ = j.value("timestamp", 
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count());
    
    Logger::debug("Order parsed:", order->order_id_, order->symbol_, 
                  order->is_buy_ ? "BUY" : "SELL", order->price_, order->order_qty_);
    
    return order;
}

nlohmann::json Order::toJson() const {
    nlohmann::json j;
    j["order_id"] = order_id_;
    j["user_id"] = user_id_;
    j["symbol"] = symbol_;
    j["side"] = is_buy_ ? "BUY" : "SELL";
    j["price"] = price_;
    j["quantity"] = order_qty_;
    j["filled_qty"] = filled_qty_;
    j["filled_cost"] = filled_cost_;
    j["stop_price"] = stop_price_;
    j["conditions"] = {
        {"all_or_none", all_or_none()},
        {"immediate_or_cancel", immediate_or_cancel()}
    };
    j["timestamp"] = timestamp_;
    return j;
}

void Order::fill(liquibook::book::Quantity fill_qty,
                 liquibook::book::Cost fill_cost,
                 liquibook::book::FillId fill_id) {
    filled_qty_ += fill_qty;
    filled_cost_ += fill_cost;
    
    Logger::info("Order filled:", order_id_, "qty:", fill_qty, 
                 "cost:", fill_cost, "total_filled:", filled_qty_);
}

} // namespace aws_wrapper
