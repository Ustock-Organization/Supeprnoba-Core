#pragma once

#include "iproducer.h"
#include <string>
#include <nlohmann/json.hpp>

namespace aws_wrapper {

/**
 * LocalProducer - Redis Pub/Sub 기반 이벤트 발행
 * IProducer 인터페이스 구현 (Kinesis Producer 대체)
 */
class LocalProducer : public IProducer {
public:
    LocalProducer(const std::string& redis_host, int redis_port);
    ~LocalProducer() override;

    bool connect();
    bool isConnected() const { return connected_; }

    // IProducer 인터페이스 구현
    void publishFill(const std::string& symbol,
                     const std::string& order_id,
                     const std::string& matched_order_id,
                     const std::string& buyer_id,
                     const std::string& seller_id,
                     uint64_t qty,
                     uint64_t price,
                     bool buyer_fully_filled = false,
                     bool seller_fully_filled = false,
                     bool buyer_is_maker = false) override;

    void publishTrade(const std::string& symbol,
                      uint64_t qty,
                      uint64_t price) override;

    void publishDepth(const std::string& symbol,
                      const nlohmann::json& depth) override;

    void publishOrderStatus(const std::string& symbol,
                            const std::string& order_id,
                            const std::string& user_id,
                            const std::string& status,
                            const std::string& reason = "",
                            uint64_t price = 0,
                            uint64_t quantity = 0,
                            bool is_buy = true,
                            const std::string& order_type = "") override;

    void flush(int timeout_ms = 1000) override;

private:
    bool publish(const std::string& channel, const std::string& data);
    bool setWithExpiry(const std::string& key, const std::string& data, int ttl_seconds);

    std::string redis_host_;
    int redis_port_;
    bool connected_{false};
    void* redis_ctx_{nullptr};  // hiredis context
};

} // namespace aws_wrapper
