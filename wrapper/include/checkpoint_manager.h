#pragma once

#include <string>
#include <unordered_map>
#include <mutex>
#include <chrono>
#include <thread>
#include <atomic>

namespace aws_wrapper {

class RedisClient;

/**
 * CheckpointManager: Kinesis Sequence Number를 Redis에 저장/복구
 *
 * Redis Keys:
 *   kinesis:checkpoint:{stream}:{shard_id} = sequence_number
 *   kinesis:checkpoint:{stream}:{shard_id}:ts = timestamp_ms
 *
 * Features:
 *   - 주기적 체크포인트 플러시 (100 레코드 또는 5초)
 *   - In-memory 버퍼 + dirty flag
 *   - Graceful shutdown 시 최종 플러시
 */
class CheckpointManager {
public:
    struct Config {
        std::string stream_name;
        int flush_interval_records = 100;       // N 레코드마다 저장
        int flush_interval_seconds = 5;         // 또는 N초마다 저장
        bool enable_background_flush = false;   // 백그라운드 플러시 (선택)
    };

    CheckpointManager(RedisClient* redis, const Config& config);
    ~CheckpointManager();

    // 체크포인트 저장 (메모리 버퍼)
    void checkpoint(const std::string& shard_id, const std::string& sequence_number);

    // 마지막 체크포인트 조회 (Redis에서 직접)
    std::string getLastCheckpoint(const std::string& shard_id);

    // 강제 플러시 (종료 시 호출)
    void flush();

    // 즉시 저장 (flush + persist)
    void checkpointImmediate(const std::string& shard_id, const std::string& sequence_number);

    // 백그라운드 플러시 스레드 (선택)
    void startBackgroundFlush();
    void stopBackgroundFlush();

    // 메트릭
    uint64_t getCheckpointCount() const { return checkpoint_count_.load(); }
    uint64_t getFlushCount() const { return flush_count_.load(); }
    size_t getPendingCount() const;

private:
    RedisClient* redis_;
    Config config_;

    // 체크포인트 버퍼
    struct ShardCheckpoint {
        std::string sequence_number;
        std::chrono::steady_clock::time_point last_updated;
        int records_since_flush = 0;
        bool dirty = false;
    };

    mutable std::mutex buffer_mutex_;
    std::unordered_map<std::string, ShardCheckpoint> checkpoint_buffer_;

    // 백그라운드 플러시 스레드
    std::thread flush_thread_;
    std::atomic<bool> running_{false};
    void flushLoop();

    // 메트릭
    std::atomic<uint64_t> checkpoint_count_{0};
    std::atomic<uint64_t> flush_count_{0};

    // Redis 키 헬퍼
    std::string makeCheckpointKey(const std::string& shard_id) const;
    std::string makeTimestampKey(const std::string& shard_id) const;

    // 단일 샤드 플러시
    void flushShard(const std::string& shard_id, ShardCheckpoint& cp);
};

} // namespace aws_wrapper
