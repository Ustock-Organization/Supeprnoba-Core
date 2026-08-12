#pragma once

#include <aws/kinesis/KinesisClient.h>
#include <string>
#include <functional>
#include <thread>
#include <atomic>
#include <memory>
#include <unordered_map>
#include <map>
#include <mutex>
#include <chrono>

namespace aws_wrapper {

class CheckpointManager;  // Forward declaration

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
    void restart();
    bool isRunning() const { return running_; }

    // Checkpoint 설정
    void setCheckpointManager(CheckpointManager* manager) { checkpoint_manager_ = manager; }
    void setCheckpointEnabled(bool enabled) { checkpoint_enabled_ = enabled; }

    // Graceful shutdown 설정
    void setDrainTimeoutSeconds(int seconds) { drain_timeout_seconds_ = seconds; }

    // 메트릭
    uint64_t getRecordsProcessed() const { return records_processed_.load(); }

    // Watchdog: 마지막 진행 시각 (main thread에서 모니터링)
    int64_t getLastProgressEpochMs() const { return last_progress_epoch_ms_.load(); }
    static constexpr int WATCHDOG_TIMEOUT_SECONDS = 60;

    // 리플레이 복구용 앵커: 현재까지 처리한 샤드별 마지막 시퀀스의 스냅샷.
    // main thread에서 호출(consumer thread가 갱신하므로 mutex 보호).
    std::map<std::string, std::string> getShardPositions() const;

private:
    void consumeLoop();
    std::string getShardIterator(const std::string& shard_id);
    std::string getShardIteratorWithCheckpoint(const std::string& shard_id);
    int countActiveIterators() const;
    void drainQueue();  // Graceful shutdown 시 잔여 메시지 처리

    std::unique_ptr<Aws::Kinesis::KinesisClient> client_;
    std::string stream_name_;
    std::string region_;
    MessageCallback callback_;
    std::thread worker_;
    std::atomic<bool> running_{false};
    std::unordered_map<std::string, std::string> shard_iterators_;
    std::unordered_map<std::string, std::chrono::steady_clock::time_point> shard_iterator_created_;

    // Checkpoint 관련
    CheckpointManager* checkpoint_manager_ = nullptr;
    bool checkpoint_enabled_ = true;
    std::unordered_map<std::string, std::string> last_sequence_numbers_;  // shard별 마지막 시퀀스
    mutable std::mutex seq_mutex_;  // last_sequence_numbers_ 보호(consumer 쓰기 / main 읽기)

    // Graceful shutdown
    int drain_timeout_seconds_ = 30;
    // worker join 실패로 detach된 적이 있는가 — restart()가 UAF/이중소비를 피하도록 판단.
    bool detached_ = false;
    std::atomic<bool> draining_{false};

    // 메트릭
    std::atomic<uint64_t> records_processed_{0};

    // Watchdog: 매 루프 반복마다 갱신되는 타임스탬프
    std::atomic<int64_t> last_progress_epoch_ms_{0};

    // Iterator 선제적 갱신 주기 (4분 = 240초, 만료는 5분)
    static constexpr int ITERATOR_REFRESH_SECONDS = 240;
};

} // namespace aws_wrapper
