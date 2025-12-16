// Candle Aggregator - Main Entry Point
// 실시간 타임프레임 집계 서비스

#include "config.h"
#include "logger.h"
#include "valkey_client.h"
#include "aggregator.h"
#include "dynamodb_client.h"
#include "s3_client.h"

#include <iostream>
#include <thread>
#include <chrono>
#include <csignal>
#include <atomic>

#include <aws/core/Aws.h>

using namespace aggregator;

std::atomic<bool> running{true};

void signal_handler(int signal) {
    Logger::info("Received signal", signal, "- shutting down...");
    running = false;
}

void print_banner() {
    std::cout << "\n";
    std::cout << "╔═══════════════════════════════════════════════════════════╗\n";
    std::cout << "║           Candle Aggregator Service                       ║\n";
    std::cout << "║      Real-time Timeframe Processing                       ║\n";
    std::cout << "╚═══════════════════════════════════════════════════════════╝\n";
    std::cout << "\n";
}

int main(int argc, char* argv[]) {
    print_banner();
    
    // 시그널 핸들러 등록
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);
    
    // 설정 로드
    Config cfg = Config::from_env();
    Logger::set_level(cfg.log_level);
    
    Logger::info("=== Configuration ===");
    Logger::info("Valkey Host:", cfg.valkey_host);
    Logger::info("Valkey Port:", cfg.valkey_port);
    Logger::info("DynamoDB Table:", cfg.dynamodb_table);
    Logger::info("S3 Bucket:", cfg.s3_bucket);
    Logger::info("Poll Interval:", cfg.poll_interval_ms, "ms");
    Logger::info("=====================");
    
    // AWS SDK 초기화
    Aws::SDKOptions options;
    Aws::InitAPI(options);
    
    // 클라이언트 초기화
    ValkeyClient valkey(cfg.valkey_host, cfg.valkey_port);
    if (!valkey.connect()) {
        Logger::error("Failed to connect to Valkey");
        Aws::ShutdownAPI(options);
        return 1;
    }
    Logger::info("Connected to Valkey");
    
    DynamoDBClient dynamodb(cfg.dynamodb_table, cfg.aws_region);
    if (!dynamodb.connect()) {
        Logger::error("Failed to connect to DynamoDB");
        Aws::ShutdownAPI(options);
        return 1;
    }
    Logger::info("Connected to DynamoDB");
    
    S3Client s3(cfg.s3_bucket, cfg.aws_region);
    if (!s3.connect()) {
        Logger::error("Failed to connect to S3");
        Aws::ShutdownAPI(options);
        return 1;
    }
    Logger::info("Connected to S3");
    
    Aggregator aggregator;
    
    Logger::info("=== Aggregator Running ===");
    Logger::info("Polling for closed candles every", cfg.poll_interval_ms, "ms");
    
    // 마지막으로 처리한 시간 (중복 방지)
    std::string last_processed_minute;
    
    while (running) {
        try {
            // 1. closed 캔들이 있는 심볼 목록 조회
            auto symbols = valkey.get_closed_symbols();
            
            for (const auto& symbol : symbols) {
                // 2. 마감된 1분봉 가져오기
                auto closed_candles = valkey.get_closed_candles(symbol);
                
                if (closed_candles.empty()) continue;
                
                Logger::debug("Processing", symbol, "-", closed_candles.size(), "closed candles");
                
                // 3. 타임프레임별 집계
                auto aggregated = aggregator.aggregate(closed_candles);
                
                // 4. DynamoDB 저장
                for (const auto& [interval, candles] : aggregated) {
                    if (candles.empty()) continue;
                    
                    int saved = dynamodb.batch_put_candles(symbol, interval, candles);
                    Logger::info("[DDB]", symbol, interval, ":", saved, "candles saved");
                }
                
                // 5. S3 백업 (1분봉만)
                if (!closed_candles.empty()) {
                    if (s3.put_candles(symbol, "1m", closed_candles)) {
                        Logger::info("[S3]", symbol, "1m:", closed_candles.size(), "candles saved");
                    }
                }
                
                // 6. Valkey에서 처리된 캔들 삭제
                valkey.delete_closed_candles(symbol);
                Logger::debug("[VALKEY]", symbol, "closed candles deleted");
            }
            
        } catch (const std::exception& e) {
            Logger::error("Processing error:", e.what());
        }
        
        // 폴링 간격 대기
        std::this_thread::sleep_for(std::chrono::milliseconds(cfg.poll_interval_ms));
    }
    
    Logger::info("Aggregator stopped");
    Aws::ShutdownAPI(options);
    
    return 0;
}
