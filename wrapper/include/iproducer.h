#pragma once

#include <string>
#include <nlohmann/json.hpp>

namespace aws_wrapper {

// 공통 Producer 인터페이스 (Kafka/Kinesis 모두 지원)
class IProducer {
public:
    virtual ~IProducer() = default;
    
    // 체결 이벤트 발행
    virtual void publishFill(const std::string& symbol,
                             const std::string& order_id,
                             const std::string& matched_order_id,
                             const std::string& buyer_id,
                             const std::string& seller_id,
                             uint64_t qty,
                             uint64_t price,
                             bool buyer_fully_filled = false,
                             bool seller_fully_filled = false) = 0;
    
    // 거래 이벤트 발행
    virtual void publishTrade(const std::string& symbol,
                              uint64_t qty,
                              uint64_t price) = 0;
    
    // 호가 변경 발행
    virtual void publishDepth(const std::string& symbol,
                              const nlohmann::json& depth) = 0;
    
    // 주문 상태 변경 발행
    virtual void publishOrderStatus(const std::string& symbol,
                                    const std::string& order_id,
                                    const std::string& user_id,
                                    const std::string& status,
                                    const std::string& reason = "") = 0;
    
    virtual void flush(int timeout_ms = 1000) = 0;
};

} // namespace aws_wrapper
