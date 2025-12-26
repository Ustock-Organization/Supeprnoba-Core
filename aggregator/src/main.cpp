// Candle Aggregator - Main Entry Point
// 실시간 타임프레임 집계 서비스 (RDS PostgreSQL 저장)

#include "config.h"
#include "logger.h"
#include "valkey_client.h"
#include "aggregator.h"
#include "rds_client.h"

#include <iostream>
#include <thread>
#include <chrono>
#include <csignal>
#include <atomic>
#include <map>

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
    std::cout << "║      Real-time Timeframe Processing (RDS)                 ║\n";
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

    // 커맨드라인 인자 파싱 (--debug)
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--debug") {
            Logger::set_level("DEBUG");
            Logger::info("Debug mode enabled via command line flag");
        }
    }
    
    Logger::info("=== Configuration ===");
    Logger::info("Valkey Host:", cfg.valkey_host);
    Logger::info("Valkey Port:", cfg.valkey_port);
    Logger::info("RDS Host:", cfg.rds_host);
    Logger::info("RDS Port:", cfg.rds_port);
    Logger::info("RDS DB:", cfg.rds_dbname);
    Logger::info("Poll Interval:", cfg.poll_interval_ms, "ms");
    Logger::info("=====================");
    
    // 클라이언트 초기화
    ValkeyClient valkey(cfg.valkey_host, cfg.valkey_port);
    if (!valkey.connect()) {
        Logger::error("Failed to connect to Valkey");
        return 1;
    }
    Logger::info("Connected to Valkey");
    
    RdsClient rds(cfg.rds_host, cfg.rds_port, cfg.rds_dbname, cfg.rds_user, cfg.rds_password);
    if (!rds.connect()) {
        Logger::error("Failed to connect to RDS");
        return 1;
    }
    Logger::info("Connected to RDS PostgreSQL");
    
    Aggregator aggregator;
    
    Logger::info("=== Aggregator Running ===");
    Logger::info("Polling for closed candles every", cfg.poll_interval_ms, "ms");
    
    // 마지막으로 처리한 캔들 개수 (중복 로그/처리 방지)
    std::map<std::string, size_t> last_processed_counts;
    
    while (running) {
        try {
            // 1. closed 캔들이 있는 심볼 목록 조회
            auto symbols = valkey.get_closed_symbols();
            
            // 심볼이 발견될 때만 로그
            static size_t last_symbol_count = 0;
            if (!symbols.empty() && symbols.size() != last_symbol_count) {
                Logger::info("Found", symbols.size(), "symbols with closed candles");
                last_symbol_count = symbols.size();
            }

            for (const auto& symbol : symbols) {
                // 2. 마감된 1분봉 가져오기
                auto closed_candles = valkey.get_closed_candles(symbol);
                
                if (closed_candles.empty()) {
                    last_processed_counts[symbol] = 0;
                    continue;
                }
                
                // 변경 사항이 없으면 스킵 (고속 폴링 방지)
                if (last_processed_counts.find(symbol) != last_processed_counts.end() && 
                    last_processed_counts[symbol] == closed_candles.size()) {
                    continue;
                }
                
                // 상태 업데이트
                last_processed_counts[symbol] = closed_candles.size();
                
                Logger::info("Processing", symbol, "-", closed_candles.size(), "1m closed candles from Valkey");
                
                // 디버깅: 가져온 캔들 정보 일부 출력
                if (!closed_candles.empty()) {
                     const auto& first = closed_candles.front();
                     Logger::debug("  First candle:", first.time, "O:", first.open, "C:", first.close);
                }

                // 3. 타임프레임별 집계
                auto aggregated = aggregator.aggregate(closed_candles);
                Logger::info("  Aggregated into", aggregated.size(), "timeframes");
                
                // 4. RDS 저장 (모든 캔들 즉시 저장)
                for (const auto& [interval, candles] : aggregated) {
                    if (candles.empty()) continue;
                    
                    Logger::info("  Saving", candles.size(), "candles for interval", interval, "to RDS...");
                    int saved = rds.batch_put_candles(symbol, interval, candles);
                    if (saved > 0) {
                        Logger::info("  [SUCCESS] RDS:", symbol, interval, "-", saved, "candles saved");
                    } else {
                        Logger::error("  [FAILURE] RDS save failed for", symbol, interval);
                    }
                }
                
                // 5. 60개 이상일 때 Valkey 정리 (S3 백업 제거됨)
                if (closed_candles.size() >= 60) {
                    // 처리된 캔들 정리
                    size_t processed_count = closed_candles.size();
                    
                    if (valkey.trim_closed_candles(symbol, processed_count)) {
                        Logger::debug("[VALKEY]", symbol, "trimmed", processed_count, "candles");
                    }
                    
                    // 처리 후 상태 업데이트
                    last_processed_counts[symbol] = 0;
                } else {
                    Logger::debug("Waiting for 60 candles, current:", closed_candles.size());
                }
            }
            
        } catch (const std::exception& e) {
            Logger::error("Processing error:", e.what());
        }
        
        // 폴링 간격 대기
        std::this_thread::sleep_for(std::chrono::milliseconds(cfg.poll_interval_ms));
    }
    
    Logger::info("Aggregator stopped");
    rds.disconnect();
    
    return 0;
}
