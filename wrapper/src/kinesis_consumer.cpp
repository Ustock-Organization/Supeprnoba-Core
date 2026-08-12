#include "kinesis_consumer.h"
#include "checkpoint_manager.h"
#include "logger.h"
#include "config.h"
#include <aws/core/Aws.h>
#include <aws/kinesis/model/GetShardIteratorRequest.h>
#include <aws/kinesis/model/GetRecordsRequest.h>
#include <aws/kinesis/model/DescribeStreamRequest.h>
#include <chrono>
#include <thread>
#include <future>

namespace aws_wrapper {

KinesisConsumer::KinesisConsumer(const std::string& stream_name,
                                  const std::string& region)
    : stream_name_(stream_name), region_(region) {

    Aws::Client::ClientConfiguration config;
    config.region = region_;
    config.connectTimeoutMs = 2000;       // Fix 2: 5000 → 2000
    config.requestTimeoutMs = 3000;       // Fix 2: 10000 → 3000
    config.enableTcpKeepAlive = true;     // Fix 2: TCP keepalive 활성화

    client_ = std::make_unique<Aws::Kinesis::KinesisClient>(config);

    Logger::info("KinesisConsumer created, stream:", stream_name_, "region:", region_,
                 "connectTimeout:", config.connectTimeoutMs, "requestTimeout:", config.requestTimeoutMs,
                 "tcpKeepAlive:", config.enableTcpKeepAlive ? "ON" : "OFF");
}

KinesisConsumer::~KinesisConsumer() {
    stop();
}

std::string KinesisConsumer::getShardIterator(const std::string& shard_id) {
    // 체크포인트가 활성화되어 있으면 체크포인트 기반 복구 시도
    if (checkpoint_enabled_ && checkpoint_manager_) {
        return getShardIteratorWithCheckpoint(shard_id);
    }

    // 기본: LATEST
    Aws::Kinesis::Model::GetShardIteratorRequest request;
    request.SetStreamName(stream_name_);
    request.SetShardId(shard_id);
    request.SetShardIteratorType(Aws::Kinesis::Model::ShardIteratorType::LATEST);

    auto outcome = client_->GetShardIterator(request);
    if (!outcome.IsSuccess()) {
        Logger::error("Failed to get shard iterator for", shard_id, ":",
                      outcome.GetError().GetMessage());
        return "";
    }

    Logger::info("Got LATEST shard iterator for:", shard_id);
    return outcome.GetResult().GetShardIterator();
}

std::string KinesisConsumer::getShardIteratorWithCheckpoint(const std::string& shard_id) {
    Aws::Kinesis::Model::GetShardIteratorRequest request;
    request.SetStreamName(stream_name_);
    request.SetShardId(shard_id);

    // 체크포인트에서 마지막 시퀀스 번호 조회
    std::string last_seq = checkpoint_manager_->getLastCheckpoint(shard_id);

    if (!last_seq.empty()) {
        // 체크포인트 복구: AFTER_SEQUENCE_NUMBER
        request.SetShardIteratorType(Aws::Kinesis::Model::ShardIteratorType::AFTER_SEQUENCE_NUMBER);
        request.SetStartingSequenceNumber(last_seq);
        Logger::info("Resuming shard", shard_id, "from checkpoint:", last_seq.substr(0, 30) + "...");
    } else {
        // 체크포인트 없음: LATEST (첫 시작)
        request.SetShardIteratorType(Aws::Kinesis::Model::ShardIteratorType::LATEST);
        Logger::info("Starting shard", shard_id, "from LATEST (no checkpoint)");
    }

    auto outcome = client_->GetShardIterator(request);
    if (!outcome.IsSuccess()) {
        Logger::error("Failed to get shard iterator for", shard_id, ":",
                      outcome.GetError().GetMessage());

        // 체크포인트 기반 복구 실패 시 LATEST로 폴백
        if (!last_seq.empty()) {
            Logger::warn("Checkpoint recovery failed, falling back to LATEST for", shard_id);
            request.SetShardIteratorType(Aws::Kinesis::Model::ShardIteratorType::LATEST);
            request.SetStartingSequenceNumber("");

            outcome = client_->GetShardIterator(request);
            if (outcome.IsSuccess()) {
                return outcome.GetResult().GetShardIterator();
            }
        }
        return "";
    }

    return outcome.GetResult().GetShardIterator();
}

void KinesisConsumer::start() {
    if (running_) return;

    // 스트림의 모든 shard 수집 (페이지네이션 처리)
    std::vector<Aws::Kinesis::Model::Shard> all_shards;
    std::string exclusive_start_shard_id;

    do {
        Aws::Kinesis::Model::DescribeStreamRequest desc_request;
        desc_request.SetStreamName(stream_name_);
        if (!exclusive_start_shard_id.empty()) {
            desc_request.SetExclusiveStartShardId(exclusive_start_shard_id);
        }

        auto desc_outcome = client_->DescribeStream(desc_request);
        if (!desc_outcome.IsSuccess()) {
            Logger::error("Failed to describe stream:", desc_outcome.GetError().GetMessage());
            return;
        }

        const auto& desc = desc_outcome.GetResult().GetStreamDescription();
        const auto& shards = desc.GetShards();

        for (const auto& shard : shards) {
            all_shards.push_back(shard);
        }

        if (desc.GetHasMoreShards() && !shards.empty()) {
            exclusive_start_shard_id = shards.back().GetShardId();
            Logger::info("DescribeStream has more shards, continuing from:", exclusive_start_shard_id);
        } else {
            break;
        }
    } while (true);

    if (all_shards.empty()) {
        Logger::error("No shards found in stream:", stream_name_);
        return;
    }

    Logger::info("Found", all_shards.size(), "shard(s) in stream:", stream_name_);
    Logger::info("Checkpoint enabled:", checkpoint_enabled_ ? "YES" : "NO");

    for (const auto& shard : all_shards) {
        std::string shard_id = shard.GetShardId();

        // 닫힌 shard는 건너뛰기 (ending sequence number가 있으면 닫힘)
        if (!shard.GetSequenceNumberRange().GetEndingSequenceNumber().empty()) {
            Logger::info("Skipping closed shard:", shard_id);
            continue;
        }

        std::string it = getShardIterator(shard_id);
        if (!it.empty()) {
            shard_iterators_[shard_id] = it;
            shard_iterator_created_[shard_id] = std::chrono::steady_clock::now();
            Logger::info("Shard iterator acquired:", shard_id);
        } else {
            Logger::error("Failed to get iterator for shard:", shard_id);
        }
    }

    if (shard_iterators_.empty()) {
        Logger::error("Failed to get any shard iterators");
        return;
    }

    Logger::info("Active shard iterators:", shard_iterators_.size());

    running_ = true;
    draining_ = false;
    worker_ = std::thread(&KinesisConsumer::consumeLoop, this);

    Logger::info("KinesisConsumer started, stream:", stream_name_);
}

void KinesisConsumer::stop() {
    if (!running_) return;

    Logger::info("KinesisConsumer stopping - initiating graceful shutdown");

    // 1. 새 레코드 수신 중단 (worker는 다음 루프에서 running_=false를 보고 빠져나온다)
    draining_ = true;
    running_ = false;

    // 2. worker join 대기 — client_는 아직 유지한다.
    //    ⚠ 종료 SEGV 근본원인: 예전엔 join 전에 client_.reset()을 호출했는데, worker가
    //    GetRecords(client_->...) 진행 중이면 use-after-free가 됐다(TOCTOU: !client_ 체크와
    //    실제 호출 사이 reset). requestTimeoutMs=3000이라 in-flight 요청은 ~3초 내 반환되고
    //    worker가 스스로 종료하므로 reset으로 강제 취소할 필요가 없다. 여유롭게 10초 대기.
    bool joined = false;
    if (worker_.joinable()) {
        auto future = std::async(std::launch::async, [this]() { worker_.join(); });
        if (future.wait_for(std::chrono::seconds(10)) == std::future_status::timeout) {
            Logger::error("KinesisConsumer worker did not exit within 10s - detaching "
                          "(client_ 유지: reset 시 UAF 위험)");
            worker_.detach();
        } else {
            joined = true;
        }
    } else {
        joined = true;
    }

    // 3. worker가 확실히 종료된 뒤에만 client_ 파괴 (안전 — 더 이상 참조자 없음).
    if (joined) {
        client_.reset();
    }

    // 4. 마지막 체크포인트 저장 — join 이후에만 last_sequence_numbers_ 접근(경쟁 방지).
    if (joined && checkpoint_enabled_ && checkpoint_manager_) {
        Logger::info("Flushing final checkpoints...");
        for (const auto& [shard_id, seq] : last_sequence_numbers_) {
            if (!seq.empty()) {
                checkpoint_manager_->checkpointImmediate(shard_id, seq);
            }
        }
        checkpoint_manager_->flush();
        Logger::info("Final checkpoints saved");
    } else if (!joined) {
        Logger::warn("Skipping checkpoint flush — worker detached (상태 불확실)");
    }

    Logger::info("KinesisConsumer stopped, records processed:", records_processed_.load());
}

std::map<std::string, std::string> KinesisConsumer::getShardPositions() const {
    std::lock_guard<std::mutex> seq_lock(seq_mutex_);
    return std::map<std::string, std::string>(
        last_sequence_numbers_.begin(), last_sequence_numbers_.end());
}

void KinesisConsumer::restart() {
    Logger::warn("KinesisConsumer restarting...");
    stop();
    std::this_thread::sleep_for(std::chrono::seconds(1));

    // KinesisClient 재생성 (새 TCP 연결 풀)
    Aws::Client::ClientConfiguration config;
    config.region = region_;
    config.connectTimeoutMs = 2000;
    config.requestTimeoutMs = 3000;
    config.enableTcpKeepAlive = true;
    client_ = std::make_unique<Aws::Kinesis::KinesisClient>(config);

    shard_iterators_.clear();
    shard_iterator_created_.clear();
    last_sequence_numbers_.clear();

    start();
    Logger::info("KinesisConsumer restarted successfully");
}

void KinesisConsumer::drainQueue() {
    // Graceful shutdown 시 잔여 메시지 처리
    Logger::info("Draining queue (timeout:", drain_timeout_seconds_, "s)...");

    auto start = std::chrono::steady_clock::now();
    int drained = 0;

    while (draining_) {
        auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::steady_clock::now() - start).count();

        if (elapsed >= drain_timeout_seconds_) {
            Logger::warn("Drain timeout reached, stopping");
            break;
        }

        bool any_records = false;

        for (auto& [shard_id, iterator] : shard_iterators_) {
            if (iterator.empty()) continue;

            Aws::Kinesis::Model::GetRecordsRequest request;
            request.SetShardIterator(iterator);
            request.SetLimit(100);

            auto outcome = client_->GetRecords(request);
            if (!outcome.IsSuccess()) {
                continue;
            }

            const auto& result = outcome.GetResult();
            iterator = result.GetNextShardIterator();

            for (const auto& record : result.GetRecords()) {
                any_records = true;
                ++drained;

                const auto& data = record.GetData();
                std::string value(reinterpret_cast<const char*>(data.GetUnderlyingData()),
                                  data.GetLength());

                if (callback_) {
                    try {
                        callback_(record.GetPartitionKey(), value);
                    } catch (const std::exception& e) {
                        Logger::error("Drain callback error:", e.what());
                    }
                }

                // 체크포인트 저장
                if (checkpoint_enabled_ && checkpoint_manager_) {
                    checkpoint_manager_->checkpoint(shard_id, record.GetSequenceNumber());
                }
            }
        }

        if (!any_records) {
            // 레코드 없으면 종료
            break;
        }
    }

    Logger::info("Drained", drained, "records");
}

int KinesisConsumer::countActiveIterators() const {
    int count = 0;
    for (const auto& [shard_id, iterator] : shard_iterators_) {
        if (!iterator.empty()) count++;
    }
    return count;
}

void KinesisConsumer::consumeLoop() {
    long long poll_count = 0;
    auto last_heartbeat = std::chrono::steady_clock::now();
    constexpr int HEARTBEAT_INTERVAL_SECONDS = 30;  // Fix 4: 시간 기반 하트비트

    while (running_) {
        bool any_records = false;
        poll_count++;

        // Fix 4: 시간 기반 하트비트 (30초마다)
        auto now_steady = std::chrono::steady_clock::now();
        if (std::chrono::duration_cast<std::chrono::seconds>(now_steady - last_heartbeat).count()
            >= HEARTBEAT_INTERVAL_SECONDS) {
            Logger::info("KinesisConsumer heartbeat: polling", shard_iterators_.size(),
                         "shards, active iterators:", countActiveIterators(),
                         "records:", records_processed_.load(),
                         "poll_count:", poll_count);
            last_heartbeat = now_steady;
        }

        for (auto& [shard_id, iterator] : shard_iterators_) {
            if (!running_ || !client_) break; // 빠른 종료를 위한 체크 (client_ null = stop() 호출됨)

            // 선제적 Iterator 갱신 (만료 전 4분마다)
            auto now = std::chrono::steady_clock::now();
            auto created_it = shard_iterator_created_.find(shard_id);
            if (created_it != shard_iterator_created_.end()) {
                auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - created_it->second).count();
                if (elapsed >= ITERATOR_REFRESH_SECONDS) {
                    Logger::info("Proactive iterator refresh for", shard_id, "after", elapsed, "seconds");
                    std::string new_iterator = getShardIterator(shard_id);
                    if (!new_iterator.empty()) {
                        iterator = new_iterator;
                        shard_iterator_created_[shard_id] = now;
                        Logger::info("Iterator proactively refreshed for", shard_id);
                    } else {
                        // Fix 5: 실패 시 30초 후 재시도 (즉시 재시도 방지)
                        Logger::warn("Failed to proactively refresh iterator for", shard_id, "- will retry in 30s");
                        shard_iterator_created_[shard_id] = now - std::chrono::seconds(ITERATOR_REFRESH_SECONDS - 30);
                    }
                }
            }

            if (iterator.empty()) {
                // 빈 iterator 즉시 갱신 시도 (지연 없음)
                Logger::warn("Shard iterator empty for:", shard_id, "- immediate refresh");
                std::string new_iterator = getShardIterator(shard_id);
                if (!new_iterator.empty()) {
                    iterator = new_iterator;
                    shard_iterator_created_[shard_id] = std::chrono::steady_clock::now();
                    Logger::info("Iterator recovered for", shard_id);
                } else {
                    Logger::error("Failed to refresh iterator for", shard_id);
                    std::this_thread::sleep_for(std::chrono::milliseconds(500));
                }
                continue;
            }

            Aws::Kinesis::Model::GetRecordsRequest request;
            request.SetShardIterator(iterator);
            request.SetLimit(100);

            // Watchdog 타임스탬프 갱신: GetRecords 직전에만 갱신
            // GetRecords에서 hang → 다음 갱신 없음 → 60초 후 watchdog 트리거
            // callback에서 hang → 다음 루프의 GetRecords 전 갱신 없음 → 60초 후 watchdog 트리거
            last_progress_epoch_ms_.store(
                std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::system_clock::now().time_since_epoch()).count());

            auto outcome = client_->GetRecords(request);
            if (!outcome.IsSuccess()) {
                const auto& error = outcome.GetError();
                std::string error_type = error.GetExceptionName();
                std::string error_msg = error.GetMessage();

                // 모든 에러 케이스에서 상세 로깅 및 iterator 갱신 시도
                Logger::warn("GetRecords failed for", shard_id,
                             "type:", error_type, "msg:", error_msg);

                // 모든 실패 케이스에서 Iterator 갱신 시도
                std::string new_iterator = getShardIterator(shard_id);
                if (!new_iterator.empty()) {
                    iterator = new_iterator;
                    shard_iterator_created_[shard_id] = std::chrono::steady_clock::now();
                    Logger::info("Iterator refreshed after error for", shard_id);
                } else {
                    Logger::error("Failed to refresh iterator for", shard_id);
                }

                // 에러 발생 시 잠시 대기하되 running_ 체크
                for (int i = 0; i < 5 && running_; ++i) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(100));
                }
                continue;
            }

            const auto& result = outcome.GetResult();
            std::string next_iterator = result.GetNextShardIterator();

            if (next_iterator.empty()) {
                // next_iterator가 빈 문자열이면 즉시 새 iterator 획득
                Logger::warn("NextIterator empty for:", shard_id, "- refreshing immediately");
                std::string fresh_iterator = getShardIterator(shard_id);
                if (!fresh_iterator.empty()) {
                    iterator = fresh_iterator;
                    shard_iterator_created_[shard_id] = std::chrono::steady_clock::now();
                    Logger::info("Iterator refreshed after empty next for", shard_id);
                } else {
                    Logger::error("Failed to get fresh iterator for", shard_id);
                    iterator = "";  // 다음 루프에서 즉시 복구 시도
                }
            } else {
                if (poll_count % 100 == 0 && shard_id == shard_iterators_.begin()->first) {
                    Logger::debug("Shard polling active, records:", result.GetRecords().size());
                }
                iterator = next_iterator;
            }

            for (const auto& record : result.GetRecords()) {
                any_records = true;
                const auto& data = record.GetData();
                std::string value(reinterpret_cast<const char*>(data.GetUnderlyingData()),
                                  data.GetLength());
                std::string partition_key = record.GetPartitionKey();
                std::string sequence_number = record.GetSequenceNumber();

                Logger::debug(">>> Received Kinesis record, shard:", shard_id,
                              "key:", partition_key, "len:", data.GetLength());

                if (callback_) {
                    try {
                        callback_(partition_key, value);
                        ++records_processed_;

                        // 시퀀스 번호 저장 (체크포인팅용)
                        {
                            std::lock_guard<std::mutex> seq_lock(seq_mutex_);
                            last_sequence_numbers_[shard_id] = sequence_number;
                        }

                        // 체크포인트 저장
                        if (checkpoint_enabled_ && checkpoint_manager_) {
                            checkpoint_manager_->checkpoint(shard_id, sequence_number);
                        }
                    } catch (const std::exception& e) {
                        Logger::error("Callback error:", e.what());
                    }
                }
            }
        }

        // Kinesis는 최소 200ms 간격 권장
        if (!any_records && running_) {
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
        }
    }

    // Graceful shutdown 시 draining 처리 (client_가 유효한 경우에만)
    if (draining_ && client_) {
        drainQueue();
    }
}

} // namespace aws_wrapper
