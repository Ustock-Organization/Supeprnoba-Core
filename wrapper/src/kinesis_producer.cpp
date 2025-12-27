#include "kinesis_producer.h"
#include "config.h"
#include "logger.h"
#include <aws/core/Aws.h>
#include <aws/kinesis/model/PutRecordRequest.h>
#include <chrono>

namespace aws_wrapper {

KinesisProducer::KinesisProducer(const std::string& region) {
    Aws::Client::ClientConfiguration config;
    config.region = region;
    
    client_ = std::make_unique<Aws::Kinesis::KinesisClient>(config);
    
    // 스트림 이름 로드
    fills_stream_ = Config::get("KINESIS_FILLS_STREAM", "supernoba-fills");
    trades_stream_ = Config::get("KINESIS_TRADES_STREAM", "supernoba-trades");
    depth_stream_ = Config::get("KINESIS_DEPTH_STREAM", "supernoba-depth");
    status_stream_ = Config::get("KINESIS_STATUS_STREAM", "supernoba-order-status");
    
    Logger::info("KinesisProducer created, region:", region);
}

KinesisProducer::~KinesisProducer() {
    // Kinesis는 동기식이라 특별한 정리 불필요
}

void KinesisProducer::produce(const std::string& stream_name,
                               const std::string& partition_key,
                               const std::string& data) {
    Aws::Kinesis::Model::PutRecordRequest request;
    request.SetStreamName(stream_name);
    request.SetPartitionKey(partition_key);
    request.SetData(Aws::Utils::ByteBuffer(
        reinterpret_cast<const unsigned char*>(data.c_str()), data.length()));
    
    auto outcome = client_->PutRecord(request);
    if (!outcome.IsSuccess()) {
        Logger::error("Failed to put record to", stream_name, ":", 
                      outcome.GetError().GetMessage());
    } else {
        Logger::debug("Published to", stream_name, "shard:", 
                      outcome.GetResult().GetShardId());
    }
}

void KinesisProducer::publishFill(const std::string& symbol,
                                   const std::string& order_id,
                                   const std::string& matched_order_id,
                                   const std::string& buyer_id,
                                   const std::string& seller_id,
                                   uint64_t qty,
                                   uint64_t price,
                                   bool buyer_fully_filled,
                                   bool seller_fully_filled) {
    nlohmann::json j;
    j["event"] = "FILL";
    j["symbol"] = symbol;
    j["trade_id"] = order_id + "_" + matched_order_id;
    
    // buyer 객체 명시적으로 생성
    nlohmann::json buyer_obj;
    buyer_obj["order_id"] = order_id;
    buyer_obj["user_id"] = buyer_id;
    buyer_obj["fully_filled"] = buyer_fully_filled;
    j["buyer"] = buyer_obj;
    
    // seller 객체 명시적으로 생성
    nlohmann::json seller_obj;
    seller_obj["order_id"] = matched_order_id;
    seller_obj["user_id"] = seller_id;
    seller_obj["fully_filled"] = seller_fully_filled;
    j["seller"] = seller_obj;
    
    j["quantity"] = qty;
    j["price"] = price;
    j["timestamp"] = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    
    produce(fills_stream_, symbol, j.dump());
    Logger::debug("Published fill:", order_id, "buyer_filled:", buyer_fully_filled, "seller_filled:", seller_fully_filled);
}

void KinesisProducer::publishTrade(const std::string& symbol,
                                    uint64_t qty,
                                    uint64_t price) {
    nlohmann::json j;
    j["event"] = "TRADE";
    j["symbol"] = symbol;
    j["quantity"] = qty;
    j["price"] = price;
    j["timestamp"] = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    
    produce(trades_stream_, symbol, j.dump());
    Logger::debug("Published trade:", symbol, qty, "@", price);
}

void KinesisProducer::publishDepth(const std::string& symbol,
                                    const nlohmann::json& depth) {
    nlohmann::json j = depth;
    j["symbol"] = symbol;
    j["timestamp"] = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    
    produce(depth_stream_, symbol, j.dump());
    Logger::debug("Published depth:", symbol);
}

void KinesisProducer::publishOrderStatus(const std::string& symbol,
                                          const std::string& order_id,
                                          const std::string& user_id,
                                          const std::string& status,
                                          const std::string& reason) {
    nlohmann::json j;
    j["event"] = "ORDER_STATUS";
    j["symbol"] = symbol;
    j["order_id"] = order_id;
    j["user_id"] = user_id;
    j["status"] = status;
    if (!reason.empty()) {
        j["reason"] = reason;
    }
    j["timestamp"] = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    
    // 모든 ORDER_STATUS 이벤트는 order-status 스트림으로 발행
    produce(status_stream_, symbol, j.dump());
    Logger::debug("Published ORDER_STATUS to order-status stream:", order_id, status, "user:", user_id);
}

void KinesisProducer::flush(int timeout_ms) {
    // Kinesis PutRecord는 동기식이라 flush 불필요
    (void)timeout_ms;
}

} // namespace aws_wrapper
