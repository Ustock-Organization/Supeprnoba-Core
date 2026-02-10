#pragma once

#include <string>
#include <functional>
#include <atomic>
#include <thread>

namespace aws_wrapper {

/**
 * LocalConsumer - Redis Pub/Sub 기반 주문 수신
 * Kinesis Consumer 대체
 */
class LocalConsumer {
public:
    using MessageCallback = std::function<void(const std::string& message)>;

    LocalConsumer(const std::string& redis_host, int redis_port, const std::string& channel);
    ~LocalConsumer();

    bool start(MessageCallback callback);
    void stop();
    bool isRunning() const { return running_.load(); }

private:
    void subscribeLoop();

    std::string redis_host_;
    int redis_port_;
    std::string channel_;
    MessageCallback callback_;
    std::atomic<bool> running_{false};
    std::thread subscribe_thread_;
    void* redis_ctx_{nullptr};  // hiredis context
};

} // namespace aws_wrapper
