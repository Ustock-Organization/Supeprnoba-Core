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

    // Timeout settings to prevent long blocking
    config.connectTimeoutMs = 3000;   // 3 seconds connection timeout
    config.requestTimeoutMs = 5000;   // 5 seconds request timeout
    config.httpRequestTimeoutMs = 10000;  // 10 seconds total HTTP timeout

    // Reduce retry attempts to fail fast instead of blocking
    config.maxConnections = 25;  // Default is 25
    config.enableTcpKeepAlive = true;  // Keep connections alive

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
    auto start = std::chrono::steady_clock::now();

    Aws::Kinesis::Model::PutRecordRequest request;
    request.SetStreamName(stream_name);
    request.SetPartitionKey(partition_key);
    request.SetData(Aws::Utils::ByteBuffer(
        reinterpret_cast<const unsigned char*>(data.c_str()), data.length()));

    auto outcome = client_->PutRecord(request);

    auto end = std::chrono::steady_clock::now();
    auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();

    if (!outcome.IsSuccess()) {
        Logger::error("Failed to put record to", stream_name, "in", elapsed_ms, "ms:",
                      outcome.GetError().GetMessage());
    } else {
        if (elapsed_ms > 1000) {
            // Log warning if PutRecord took more than 1 second
            Logger::warn("[SLOW] PutRecord to", stream_name, "took", elapsed_ms, "ms");
        }
        Logger::debug("Published to", stream_name, "shard:",
                      outcome.GetResult().GetShardId(), "in", elapsed_ms, "ms");
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
                                   bool seller_fully_filled,
                                   bool buyer_is_maker) {
    nlohmann::json j;
    j["event"] = "FILL";
    j["symbol"] = symbol;
    j["trade_id"] = order_id + "_" + matched_order_id;

    // buyer 객체 명시적으로 생성
    nlohmann::json buyer_obj;
    buyer_obj["order_id"] = order_id;
    buyer_obj["user_id"] = buyer_id;
    buyer_obj["fully_filled"] = buyer_fully_filled;
    buyer_obj["is_maker"] = buyer_is_maker;
    j["buyer"] = buyer_obj;

    // seller 객체 명시적으로 생성
    nlohmann::json seller_obj;
    seller_obj["order_id"] = matched_order_id;
    seller_obj["user_id"] = seller_id;
    seller_obj["fully_filled"] = seller_fully_filled;
    seller_obj["is_maker"] = !buyer_is_maker;  // opposite of buyer
    j["seller"] = seller_obj;

    j["quantity"] = qty;
    j["price"] = price;

    // timestamp in milliseconds
    auto now = std::chrono::system_clock::now();
    j["timestamp"] = std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()).count();

    // executed_at in ISO 8601 format for history storage
    auto time_t_now = std::chrono::system_clock::to_time_t(now);
    std::tm tm_now = *std::gmtime(&time_t_now);
    char iso_buf[30];
    std::strftime(iso_buf, sizeof(iso_buf), "%Y-%m-%dT%H:%M:%SZ", &tm_now);
    j["executed_at"] = iso_buf;

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
                                          const std::string& reason,
                                          uint64_t price,
                                          uint64_t quantity,
                                          bool is_buy,
                                          const std::string& order_type) {
    nlohmann::json j;
    j["event"] = "ORDER_STATUS";
    j["symbol"] = symbol;
    j["order_id"] = order_id;
    j["user_id"] = user_id;
    j["status"] = status;
    if (!reason.empty()) {
        j["reason"] = reason;
    }
    // ACCEPTED 상태일 때 주문 정보 포함 (order-status-processor에서 DynamoDB에 저장)
    if (status == "ACCEPTED" && quantity > 0) {
        j["price"] = price;
        j["quantity"] = quantity;
        j["side"] = is_buy ? "BUY" : "SELL";
        j["type"] = order_type.empty() ? "LIMIT" : order_type;
    }
    j["timestamp"] = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();

    produce(status_stream_, symbol, j.dump());
    Logger::debug("Published ORDER_STATUS:", order_id, status, "user:", user_id);
}

void KinesisProducer::flush(int timeout_ms) {
    // Kinesis PutRecord는 동기식이라 flush 불필요
    (void)timeout_ms;
}

} // namespace aws_wrapper
