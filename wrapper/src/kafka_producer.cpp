#include "kafka_producer.h"
#include "config.h"
#include "logger.h"
#include "msk_iam_auth.h"
#include <chrono>

namespace aws_wrapper {

KafkaProducer::KafkaProducer(const std::string& brokers) {
    std::string errstr;
    
    auto conf = std::unique_ptr<RdKafka::Conf>(
        RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
    
    conf->set("bootstrap.servers", brokers, errstr);
    conf->set("acks", "1", errstr);  // Leader ack만 대기 (빠름)
    conf->set("linger.ms", "5", errstr);  // 배칭 딜레이
    
    // MSK IAM 인증 설정 (포트 9098 사용 시)
    std::string aws_region = Config::get("AWS_REGION", "ap-northeast-2");
    if (brokers.find(":9098") != std::string::npos) {
        Logger::info("Configuring MSK IAM authentication for producer");
        if (!MskIamAuth::configure(conf.get(), aws_region)) {
            Logger::error("Failed to configure MSK IAM auth");
        }
        
        // OAUTHBEARER 콜백 등록
        static MskOauthCallback oauth_cb(aws_region);
        conf->set("oauthbearer_token_refresh_cb", &oauth_cb, errstr);
    }
    
    producer_.reset(RdKafka::Producer::create(conf.get(), errstr));
    if (!producer_) {
        Logger::error("Failed to create Kafka producer:", errstr);
        throw std::runtime_error("Kafka producer creation failed: " + errstr);
    }
    
    // 토픽 이름 로드
    fills_topic_ = Config::get(Config::KAFKA_FILLS_TOPIC, "fills");
    trades_topic_ = Config::get(Config::KAFKA_TRADES_TOPIC, "trades");
    depth_topic_ = Config::get(Config::KAFKA_DEPTH_TOPIC, "depth");
    status_topic_ = Config::get("KAFKA_STATUS_TOPIC", "order_status");
    
    Logger::info("KafkaProducer created, brokers:", brokers);
}

KafkaProducer::~KafkaProducer() {
    flush(5000);
}

void KafkaProducer::produce(const std::string& topic,
                             const std::string& key,
                             const std::string& value) {
    RdKafka::ErrorCode err = producer_->produce(
        topic,
        RdKafka::Topic::PARTITION_UA,  // 자동 파티셔닝
        RdKafka::Producer::RK_MSG_COPY,
        const_cast<char*>(value.c_str()), value.size(),
        key.c_str(), key.size(),
        0, nullptr);
    
    if (err != RdKafka::ERR_NO_ERROR) {
        Logger::error("Failed to produce to", topic, ":", RdKafka::err2str(err));
    }
    
    producer_->poll(0);  // 비동기 콜백 처리
}

void KafkaProducer::publishFill(const std::string& symbol,
                                 const std::string& order_id,
                                 const std::string& matched_order_id,
                                 const std::string& buyer_id,
                                 const std::string& seller_id,
                                 uint64_t qty,
                                 uint64_t price) {
    nlohmann::json j;
    j["event"] = "FILL";
    j["symbol"] = symbol;
    j["order_id"] = order_id;
    j["matched_order_id"] = matched_order_id;
    j["buyer_id"] = buyer_id;
    j["seller_id"] = seller_id;
    j["fill_qty"] = qty;
    j["fill_price"] = price;
    j["timestamp"] = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    
    produce(fills_topic_, symbol, j.dump());
    Logger::debug("Published fill:", order_id);
}

void KafkaProducer::publishTrade(const std::string& symbol,
                                  uint64_t qty,
                                  uint64_t price) {
    nlohmann::json j;
    j["event"] = "TRADE";
    j["symbol"] = symbol;
    j["quantity"] = qty;
    j["price"] = price;
    j["timestamp"] = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    
    produce(trades_topic_, symbol, j.dump());
    Logger::debug("Published trade:", symbol, qty, "@", price);
}

void KafkaProducer::publishDepth(const std::string& symbol,
                                  const nlohmann::json& depth) {
    produce(depth_topic_, symbol, depth.dump());
    Logger::debug("Published depth:", symbol);
}

void KafkaProducer::publishOrderStatus(const std::string& symbol,
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
    
    produce(status_topic_, symbol, j.dump());
}

void KafkaProducer::flush(int timeout_ms) {
    producer_->flush(timeout_ms);
}

} // namespace aws_wrapper
