#pragma once

#include <librdkafka/rdkafkacpp.h>
#include <string>
#include <memory>
#include <nlohmann/json.hpp>
#include "iproducer.h"

namespace aws_wrapper {

class KafkaProducer : public IProducer {
public:
    explicit KafkaProducer(const std::string& brokers);
    ~KafkaProducer() override;
    
    // 체결 이벤트 발행
    void publishFill(const std::string& symbol,
                     const std::string& order_id,
                     const std::string& matched_order_id,
                     const std::string& buyer_id,
                     const std::string& seller_id,
                     uint64_t qty,
                     uint64_t price) override;
    
    // 거래 이벤트 발행
    void publishTrade(const std::string& symbol,
                      uint64_t qty,
                      uint64_t price) override;
    
    // 호가 변경 발행
    void publishDepth(const std::string& symbol,
                      const nlohmann::json& depth) override;
    
    // 주문 상태 변경 발행
    void publishOrderStatus(const std::string& symbol,
                            const std::string& order_id,
                            const std::string& status,
                            const std::string& reason = "") override;
    
    void flush(int timeout_ms = 1000) override;
    
private:
    void produce(const std::string& topic,
                 const std::string& key,
                 const std::string& value);
    
    std::unique_ptr<RdKafka::Producer> producer_;
    std::string fills_topic_;
    std::string trades_topic_;
    std::string depth_topic_;
    std::string status_topic_;
};

} // namespace aws_wrapper

