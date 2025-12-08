#pragma once

#include <aws/kinesis/KinesisClient.h>
#include <string>
#include <memory>
#include <nlohmann/json.hpp>
#include "iproducer.h"

namespace aws_wrapper {

class KinesisProducer : public IProducer {
public:
    explicit KinesisProducer(const std::string& region = "ap-northeast-2");
    ~KinesisProducer() override;
    
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
    void produce(const std::string& stream_name,
                 const std::string& partition_key,
                 const std::string& data);
    
    std::unique_ptr<Aws::Kinesis::KinesisClient> client_;
    std::string fills_stream_;
    std::string trades_stream_;
    std::string depth_stream_;
    std::string status_stream_;
};

} // namespace aws_wrapper

