#pragma once

#include <aws/kinesis/KinesisClient.h>
#include <string>
#include <functional>
#include <thread>
#include <atomic>
#include <memory>
#include <unordered_map>
#include <chrono>

namespace aws_wrapper {

class KinesisConsumer {
public:
    using MessageCallback = std::function<void(const std::string& key,
                                                const std::string& value)>;
    
    KinesisConsumer(const std::string& stream_name,
                    const std::string& region = "ap-northeast-2");
    ~KinesisConsumer();
    
    void setCallback(MessageCallback callback) { callback_ = std::move(callback); }
    void start();
    void stop();
    bool isRunning() const { return running_; }
    
private:
    void consumeLoop();
    std::string getShardIterator(const std::string& shard_id);
    int countActiveIterators() const;
    
    std::unique_ptr<Aws::Kinesis::KinesisClient> client_;
    std::string stream_name_;
    std::string region_;
    MessageCallback callback_;
    std::thread worker_;
    std::atomic<bool> running_{false};
    std::unordered_map<std::string, std::string> shard_iterators_;
    std::unordered_map<std::string, std::chrono::steady_clock::time_point> shard_iterator_created_;

    // Iterator 선제적 갱신 주기 (4분 = 240초, 만료는 5분)
    static constexpr int ITERATOR_REFRESH_SECONDS = 240;
};

} // namespace aws_wrapper
