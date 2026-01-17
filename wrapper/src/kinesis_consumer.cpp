#include "kinesis_consumer.h"
#include "logger.h"
#include "config.h"
#include <aws/core/Aws.h>
#include <aws/kinesis/model/GetShardIteratorRequest.h>
#include <aws/kinesis/model/GetRecordsRequest.h>
#include <aws/kinesis/model/DescribeStreamRequest.h>
#include <chrono>
#include <thread>

namespace aws_wrapper {

KinesisConsumer::KinesisConsumer(const std::string& stream_name,
                                  const std::string& region)
    : stream_name_(stream_name), region_(region) {
    
    Aws::Client::ClientConfiguration config;
    config.region = region_;
    config.connectTimeoutMs = 5000;
    config.requestTimeoutMs = 10000;
    
    client_ = std::make_unique<Aws::Kinesis::KinesisClient>(config);
    
    Logger::info("KinesisConsumer created, stream:", stream_name_, "region:", region_);
}

KinesisConsumer::~KinesisConsumer() {
    stop();
}

std::string KinesisConsumer::getShardIterator(const std::string& shard_id) {
    Aws::Kinesis::Model::GetShardIteratorRequest request;
    request.SetStreamName(stream_name_);
    request.SetShardId(shard_id);
    // LATEST: 새 레코드만 읽음 (운영용)
    request.SetShardIteratorType(Aws::Kinesis::Model::ShardIteratorType::LATEST);
    
    auto outcome = client_->GetShardIterator(request);
    if (!outcome.IsSuccess()) {
        Logger::error("Failed to get shard iterator for", shard_id, ":", 
                      outcome.GetError().GetMessage());
        return "";
    }
    
    Logger::debug("Got shard iterator for:", shard_id);
    return outcome.GetResult().GetShardIterator();
}

void KinesisConsumer::start() {
    if (running_) return;
    
    // 스트림 정보 가져오기
    Aws::Kinesis::Model::DescribeStreamRequest desc_request;
    desc_request.SetStreamName(stream_name_);
    
    auto desc_outcome = client_->DescribeStream(desc_request);
    if (!desc_outcome.IsSuccess()) {
        Logger::error("Failed to describe stream:", desc_outcome.GetError().GetMessage());
        return;
    }
    
    // 모든 샤드의 iterator 가져오기
    const auto& shards = desc_outcome.GetResult().GetStreamDescription().GetShards();
    if (shards.empty()) {
        Logger::error("No shards found in stream:", stream_name_);
        return;
    }
    
    Logger::info("Found", shards.size(), "shard(s) in stream:", stream_name_);
    
    for (const auto& shard : shards) {
        std::string it = getShardIterator(shard.GetShardId());
        if (!it.empty()) {
            shard_iterators_[shard.GetShardId()] = it;
        }
    }
    
    if (shard_iterators_.empty()) {
        Logger::error("Failed to get any shard iterators");
        return;
    }
    
    running_ = true;
    worker_ = std::thread(&KinesisConsumer::consumeLoop, this);
    
    Logger::info("KinesisConsumer started, stream:", stream_name_);
}

void KinesisConsumer::stop() {
    if (!running_) return;
    
    running_ = false;
    if (worker_.joinable()) {
        worker_.join();
    }
    
    Logger::info("KinesisConsumer stopped");
}

void KinesisConsumer::consumeLoop() {
    long long poll_count = 0;
    while (running_) {
        bool any_records = false;
        poll_count++;
        
        if (poll_count % 100 == 0) {
            Logger::info("KinesisConsumer heartbeat: polling shards...");
        }
        
        for (auto& [shard_id, iterator] : shard_iterators_) {
            if (!running_) break; // 빠른 종료를 위한 체크

            if (iterator.empty()) {
                // 빈 iterator 자동 갱신 시도
                if (poll_count % 50 == 0) {
                    Logger::warn("Shard iterator empty for:", shard_id, "- attempting refresh...");
                    std::string new_iterator = getShardIterator(shard_id);
                    if (!new_iterator.empty()) {
                        iterator = new_iterator;
                        Logger::info("Iterator recovered for", shard_id);
                    }
                }
                continue;
            }
            
            Aws::Kinesis::Model::GetRecordsRequest request;
            request.SetShardIterator(iterator);
            request.SetLimit(100);
            
            auto outcome = client_->GetRecords(request);
            if (!outcome.IsSuccess()) {
                const auto& error = outcome.GetError();
                std::string error_msg = error.GetMessage();

                // Iterator 만료 감지 및 자동 갱신
                if (error_msg.find("Iterator expired") != std::string::npos ||
                    error_msg.find("ExpiredIterator") != std::string::npos) {
                    Logger::warn("Iterator expired for", shard_id, "- refreshing...");
                    std::string new_iterator = getShardIterator(shard_id);
                    if (!new_iterator.empty()) {
                        iterator = new_iterator;
                        Logger::info("Iterator refreshed for", shard_id);
                    } else {
                        Logger::error("Failed to refresh iterator for", shard_id);
                    }
                } else {
                    Logger::error("GetRecords failed for", shard_id, ":", error_msg);
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
                Logger::warn("Shard iterator ended explicitly for:", shard_id); // This is important
            } else if (poll_count % 100 == 0 && shard_id == shard_iterators_.begin()->first) {
                 Logger::debug("Shard polling active, records:", result.GetRecords().size());
            }

            iterator = next_iterator;
            
            for (const auto& record : result.GetRecords()) {
                any_records = true;
                const auto& data = record.GetData();
                std::string value(reinterpret_cast<const char*>(data.GetUnderlyingData()),
                                  data.GetLength());
                std::string partition_key = record.GetPartitionKey();
                
                Logger::info(">>> Received Kinesis record, shard:", shard_id, 
                             "key:", partition_key, "len:", data.GetLength());
                
                if (callback_) {
                    try {
                        callback_(partition_key, value);
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
}

} // namespace aws_wrapper
