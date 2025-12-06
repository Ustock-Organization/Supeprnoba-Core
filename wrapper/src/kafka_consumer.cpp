#include "kafka_consumer.h"
#include "msk_iam_auth.h"
#include "logger.h"
#include "config.h"

namespace aws_wrapper {

// Static callback holder
static std::unique_ptr<MskOauthCallback> g_consumer_oauth_callback;

KafkaConsumer::KafkaConsumer(const std::string& brokers,
                              const std::string& topic,
                              const std::string& group_id)
    : topic_(topic) {
    std::string errstr;
    
    auto conf = std::unique_ptr<RdKafka::Conf>(
        RdKafka::Conf::create(RdKafka::Conf::CONF_GLOBAL));
    
    conf->set("bootstrap.servers", brokers, errstr);
    conf->set("group.id", group_id, errstr);
    conf->set("auto.offset.reset", "earliest", errstr);
    conf->set("enable.auto.commit", "true", errstr);
    
    // MSK IAM 인증 사용 여부 확인
    bool use_iam = Config::getBool("MSK_USE_IAM", true);
    std::string region = Config::get("AWS_REGION", "ap-northeast-2");
    
    if (use_iam) {
        Logger::info("Configuring MSK IAM authentication for consumer...");
        if (!MskIamAuth::configure(conf.get(), region)) {
            throw std::runtime_error("Failed to configure MSK IAM authentication");
        }
        
        // OAUTHBEARER 콜백 설정
        g_consumer_oauth_callback = std::make_unique<MskOauthCallback>(region);
        if (conf->set("oauthbearer_token_refresh_cb", g_consumer_oauth_callback.get(), errstr) != RdKafka::Conf::CONF_OK) {
            Logger::warn("Failed to set oauth callback:", errstr);
        }
    }
    
    consumer_.reset(RdKafka::KafkaConsumer::create(conf.get(), errstr));
    if (!consumer_) {
        Logger::error("Failed to create Kafka consumer:", errstr);
        throw std::runtime_error("Kafka consumer creation failed: " + errstr);
    }
    
    Logger::info("KafkaConsumer created, brokers:", brokers, "group:", group_id,
                 "IAM auth:", use_iam ? "enabled" : "disabled");
}

KafkaConsumer::~KafkaConsumer() {
    stop();
}

void KafkaConsumer::start() {
    if (running_) return;
    
    std::vector<std::string> topics = {topic_};
    RdKafka::ErrorCode err = consumer_->subscribe(topics);
    if (err != RdKafka::ERR_NO_ERROR) {
        Logger::error("Failed to subscribe to topic:", topic_, 
                      RdKafka::err2str(err));
        return;
    }
    
    running_ = true;
    worker_ = std::thread(&KafkaConsumer::consumeLoop, this);
    
    Logger::info("KafkaConsumer started, topic:", topic_);
}

void KafkaConsumer::stop() {
    if (!running_) return;
    
    running_ = false;
    if (worker_.joinable()) {
        worker_.join();
    }
    
    consumer_->close();
    Logger::info("KafkaConsumer stopped");
}

void KafkaConsumer::consumeLoop() {
    while (running_) {
        auto msg = std::unique_ptr<RdKafka::Message>(
            consumer_->consume(1000));  // 1초 타임아웃
        
        if (!msg) continue;
        
        switch (msg->err()) {
            case RdKafka::ERR_NO_ERROR: {
                std::string key = msg->key() ? *msg->key() : "";
                std::string value(static_cast<const char*>(msg->payload()), 
                                  msg->len());
                
                Logger::debug("Received message, key:", key, "len:", msg->len());
                
                if (callback_) {
                    try {
                        callback_(key, value);
                    } catch (const std::exception& e) {
                        Logger::error("Callback error:", e.what());
                    }
                }
                break;
            }
            case RdKafka::ERR__TIMED_OUT:
                // 정상 - 타임아웃
                break;
            case RdKafka::ERR__PARTITION_EOF:
                // 파티션 끝 도달
                break;
            default:
                Logger::error("Consume error:", msg->errstr());
                break;
        }
    }
}

} // namespace aws_wrapper
