#include "checkpoint_manager.h"
#include "redis_client.h"
#include "logger.h"
#include <chrono>

namespace aws_wrapper {

CheckpointManager::CheckpointManager(RedisClient* redis, const Config& config)
    : redis_(redis), config_(config) {
    Logger::info("CheckpointManager created for stream:", config_.stream_name);
}

CheckpointManager::~CheckpointManager() {
    stopBackgroundFlush();
    flush();  // 최종 플러시
}

std::string CheckpointManager::makeCheckpointKey(const std::string& shard_id) const {
    return "kinesis:checkpoint:" + config_.stream_name + ":" + shard_id;
}

std::string CheckpointManager::makeTimestampKey(const std::string& shard_id) const {
    return "kinesis:checkpoint:" + config_.stream_name + ":" + shard_id + ":ts";
}

void CheckpointManager::checkpoint(const std::string& shard_id, const std::string& sequence_number) {
    std::lock_guard<std::mutex> lock(buffer_mutex_);

    auto& cp = checkpoint_buffer_[shard_id];
    cp.sequence_number = sequence_number;
    cp.last_updated = std::chrono::steady_clock::now();
    cp.records_since_flush++;
    cp.dirty = true;

    ++checkpoint_count_;

    // 즉시 플러시 조건 확인
    bool should_flush = false;

    // 레코드 수 기반
    if (cp.records_since_flush >= config_.flush_interval_records) {
        should_flush = true;
    }

    if (should_flush) {
        flushShard(shard_id, cp);
    }
}

void CheckpointManager::checkpointImmediate(const std::string& shard_id, const std::string& sequence_number) {
    std::lock_guard<std::mutex> lock(buffer_mutex_);

    auto& cp = checkpoint_buffer_[shard_id];
    cp.sequence_number = sequence_number;
    cp.last_updated = std::chrono::steady_clock::now();
    cp.dirty = true;

    ++checkpoint_count_;

    flushShard(shard_id, cp);
}

std::string CheckpointManager::getLastCheckpoint(const std::string& shard_id) {
    if (!redis_ || !redis_->isConnected()) {
        Logger::warn("CheckpointManager: Redis not connected, cannot get checkpoint");
        return "";
    }

    std::string key = makeCheckpointKey(shard_id);
    auto result = redis_->get(key);

    if (result.has_value()) {
        Logger::info("Checkpoint loaded for", shard_id, ":", result.value().substr(0, 30) + "...");
        return result.value();
    }

    Logger::debug("No checkpoint found for", shard_id);
    return "";
}

void CheckpointManager::flush() {
    std::lock_guard<std::mutex> lock(buffer_mutex_);

    if (!redis_ || !redis_->isConnected()) {
        Logger::warn("CheckpointManager: Redis not connected, cannot flush");
        return;
    }

    int flushed = 0;
    for (auto& [shard_id, cp] : checkpoint_buffer_) {
        if (cp.dirty) {
            flushShard(shard_id, cp);
            ++flushed;
        }
    }

    if (flushed > 0) {
        Logger::info("CheckpointManager flushed", flushed, "shards");
    }
}

void CheckpointManager::flushShard(const std::string& shard_id, ShardCheckpoint& cp) {
    if (!cp.dirty || cp.sequence_number.empty()) {
        return;
    }

    if (!redis_ || !redis_->isConnected()) {
        Logger::warn("CheckpointManager: Redis not connected, skip flush for", shard_id);
        return;
    }

    std::string key = makeCheckpointKey(shard_id);
    std::string ts_key = makeTimestampKey(shard_id);

    // 시퀀스 번호 저장
    bool success = redis_->set(key, cp.sequence_number);

    if (success) {
        // 타임스탬프 저장
        auto now = std::chrono::system_clock::now();
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            now.time_since_epoch()).count();
        redis_->set(ts_key, std::to_string(ms));

        cp.dirty = false;
        cp.records_since_flush = 0;
        ++flush_count_;

        Logger::debug("Checkpoint saved:", shard_id, "seq:", cp.sequence_number.substr(0, 30) + "...");
    } else {
        Logger::error("Failed to save checkpoint for", shard_id);
    }
}

size_t CheckpointManager::getPendingCount() const {
    std::lock_guard<std::mutex> lock(buffer_mutex_);

    size_t count = 0;
    for (const auto& [shard_id, cp] : checkpoint_buffer_) {
        if (cp.dirty) {
            ++count;
        }
    }
    return count;
}

void CheckpointManager::startBackgroundFlush() {
    if (running_.load()) {
        return;
    }

    running_ = true;
    flush_thread_ = std::thread(&CheckpointManager::flushLoop, this);
    Logger::info("CheckpointManager background flush started");
}

void CheckpointManager::stopBackgroundFlush() {
    if (!running_.load()) {
        return;
    }

    running_ = false;
    if (flush_thread_.joinable()) {
        flush_thread_.join();
    }
    Logger::info("CheckpointManager background flush stopped");
}

void CheckpointManager::flushLoop() {
    while (running_.load()) {
        // 설정된 간격만큼 대기
        for (int i = 0; i < config_.flush_interval_seconds * 10 && running_.load(); ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }

        if (!running_.load()) {
            break;
        }

        // 시간 기반 플러시
        {
            std::lock_guard<std::mutex> lock(buffer_mutex_);
            auto now = std::chrono::steady_clock::now();

            for (auto& [shard_id, cp] : checkpoint_buffer_) {
                if (cp.dirty) {
                    auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
                        now - cp.last_updated).count();

                    if (elapsed >= config_.flush_interval_seconds) {
                        flushShard(shard_id, cp);
                    }
                }
            }
        }
    }
}

} // namespace aws_wrapper
