#pragma once

#include <librdkafka/rdkafkacpp.h>
#include <string>
#include <functional>
#include <thread>
#include <atomic>
#include <memory>

namespace aws_wrapper {

class KafkaConsumer {
public:
    using MessageCallback = std::function<void(const std::string& key,
                                                const std::string& value)>;
    
    KafkaConsumer(const std::string& brokers,
                  const std::string& topic,
                  const std::string& group_id);
    ~KafkaConsumer();
    
    void setCallback(MessageCallback callback) { callback_ = std::move(callback); }
    void start();
    void stop();
    bool isRunning() const { return running_; }
    
private:
    void consumeLoop();
    
    std::unique_ptr<RdKafka::KafkaConsumer> consumer_;
    MessageCallback callback_;
    std::thread worker_;
    std::atomic<bool> running_{false};
    std::string topic_;
};

} // namespace aws_wrapper
