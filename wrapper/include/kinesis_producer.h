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
                     uint64_t price,
                     bool buyer_fully_filled = false,
                     bool seller_fully_filled = false,
                     bool buyer_is_maker = false) override;
    
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
                            const std::string& user_id,
                            const std::string& status,
                            const std::string& reason = "",
                            uint64_t price = 0,
                            uint64_t quantity = 0,
                            bool is_buy = true,
                            const std::string& order_type = "") override;
    
    void flush(int timeout_ms = 1000) override;

    // WAL 재생: 발행 실패로 로컬 WAL에 남은 이벤트를 재발행한다.
    // 기동 시 호출. 재발행 실패분은 새 WAL로 남아 다음 기동에 재시도된다.
    // 정산 멱등화(trade_id dedup)와 결합하면 중복 재발행도 안전(effectively-once).
    // 반환: 재발행 시도한 레코드 수.
    int replayWAL();

private:
    void produce(const std::string& stream_name,
                 const std::string& partition_key,
                 const std::string& data);

    void saveToWAL(const std::string& stream_name,
                   const std::string& partition_key,
                   const std::string& data);

    std::unique_ptr<Aws::Kinesis::KinesisClient> client_;
    std::string fills_stream_;
    std::string trades_stream_;
    std::string depth_stream_;
    std::string status_stream_;
};

} // namespace aws_wrapper

