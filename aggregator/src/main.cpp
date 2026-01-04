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
#include <ctime>
#include <set>

using namespace aggregator;

// [Phase 3] 현재 UTC epoch 조회
int64_t get_current_epoch() {
    return static_cast<int64_t>(std::time(nullptr));
}

// [Phase 3] epoch를 타임프레임 시작으로 정렬 (내림)
int64_t align_epoch_to_timeframe(int64_t epoch, int seconds) {
    return (epoch / seconds) * seconds;
}

// [Phase 3] YYYYMMDDHHmm 형식으로 변환 (KST 기준)
std::string epoch_to_ymdhm(int64_t epoch) {
    const int64_t KST_OFFSET = 9 * 3600;  // UTC+9
    time_t kst_time = static_cast<time_t>(epoch + KST_OFFSET);
    struct tm* tm = gmtime(&kst_time);

    char buf[16];
    snprintf(buf, sizeof(buf), "%04d%02d%02d%02d%02d",
             tm->tm_year + 1900, tm->tm_mon + 1, tm->tm_mday,
             tm->tm_hour, tm->tm_min);
    return std::string(buf);
}

// [Phase 3] 계층적 집계 수행 (4h, 1d, 1w)
// source_interval에서 데이터를 읽어 target_interval로 집계
void aggregate_higher_timeframe(
    RdsClient& rds,
    Aggregator& agg,
    const std::string& symbol,
    const std::string& source_interval,
    const std::string& target_interval,
    int target_seconds,
    int64_t target_epoch) {

    int64_t start_epoch = target_epoch - target_seconds;
    int64_t end_epoch = target_epoch;

    // 소스 타임프레임 캔들 조회
    auto source_candles = rds.get_candles_by_interval(
        symbol, source_interval, start_epoch, end_epoch);

    if (source_candles.empty()) {
        Logger::debug("[HIER-AGG] No source candles for", symbol,
                     target_interval, "from", source_interval);
        return;
    }

    // 집계
    std::string aligned_time = epoch_to_ymdhm(target_epoch - target_seconds);
    Candle agg_candle = agg.aggregate_candles(source_candles, aligned_time);

    if (agg_candle.time.empty()) {
        Logger::warn("[HIER-AGG] Failed to aggregate", symbol, target_interval);
        return;
    }

    // 저장
    if (rds.put_candle(symbol, target_interval, agg_candle)) {
        Logger::info("[HIER-AGG]", symbol, target_interval, "@", aligned_time,
                    "aggregated from", source_candles.size(), source_interval, "candles");
    } else {
        Logger::error("[HIER-AGG] Failed to save", symbol, target_interval);
    }
}

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

    // 마지막 저장된 epoch 추적 (중복 저장 방지)
    // key: "symbol:interval", value: last saved epoch
    std::map<std::string, int64_t> last_saved_epochs;

    // [Phase 3] 계층적 집계 상태 추적
    std::set<std::string> known_symbols;           // 알려진 심볼 목록
    int64_t last_4h_check = 0;                     // 마지막 4h 경계 체크 시간
    int64_t last_1d_check = 0;                     // 마지막 1d 경계 체크 시간
    int64_t last_1w_check = 0;                     // 마지막 1w 경계 체크 시간

    const int SECONDS_4H = 4 * 3600;               // 4시간
    const int SECONDS_1D = 24 * 3600;              // 1일
    const int SECONDS_1W = 7 * 24 * 3600;          // 1주
    
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
                
                // 4. RDS 저장 (새 캔들만 저장 - epoch 기반 중복 방지)
                for (const auto& [interval, candles] : aggregated) {
                    if (candles.empty()) continue;
                    
                    // 이미 저장된 캔들 제외 (epoch 기반 필터링)
                    std::string key = symbol + ":" + interval;
                    int64_t last_epoch = 0;
                    if (last_saved_epochs.find(key) != last_saved_epochs.end()) {
                        last_epoch = last_saved_epochs[key];
                    }
                    
                    std::vector<Candle> new_candles;
                    int64_t max_epoch = last_epoch;
                    for (const auto& c : candles) {
                        if (c.epoch() > last_epoch) {
                            new_candles.push_back(c);
                            if (c.epoch() > max_epoch) {
                                max_epoch = c.epoch();
                            }
                        }
                    }
                    
                    if (new_candles.empty()) {
                        Logger::debug("  [SKIP]", interval, "- no new candles (already saved)");
                        continue;
                    }
                    
                    Logger::info("  Saving", new_candles.size(), "new candles for interval", interval, "to RDS...");
                    int saved = rds.batch_put_candles(symbol, interval, new_candles);
                    if (saved > 0) {
                        Logger::info("  [SUCCESS] RDS:", symbol, interval, "-", saved, "candles saved");
                        // 저장 성공 시 마지막 epoch 업데이트
                        last_saved_epochs[key] = max_epoch;
                    } else {
                        Logger::error("  [FAILURE] RDS save failed for", symbol, interval);
                    }
                }
                
                // 5. Valkey 정리 정책 (4h 집계 지원을 위해 240개 유지)
                // [FIX] 기존 60개 → 240개로 변경 (4h = 240분)
                // 1d/1w는 Phase 3의 RDS 기반 집계로 처리
                const size_t VALKEY_TRIM_THRESHOLD = 240;  // 4시간 분량
                const size_t VALKEY_KEEP_COUNT = 120;      // 최소 2시간 분량 유지

                if (closed_candles.size() >= VALKEY_TRIM_THRESHOLD) {
                    // 오래된 캔들만 정리 (최근 KEEP_COUNT개 유지)
                    size_t trim_count = closed_candles.size() - VALKEY_KEEP_COUNT;

                    if (valkey.trim_closed_candles(symbol, trim_count)) {
                        Logger::info("[VALKEY]", symbol, "trimmed", trim_count,
                                    "candles, keeping", VALKEY_KEEP_COUNT);
                    }

                    // 처리 후 상태 업데이트
                    last_processed_counts[symbol] = VALKEY_KEEP_COUNT;
                } else {
                    Logger::debug("Valkey buffer:", closed_candles.size(), "/", VALKEY_TRIM_THRESHOLD);
                }

                // [Phase 3] 심볼 추적
                known_symbols.insert(symbol);
            }

            // [Phase 3] 계층적 집계 - 4h, 1d, 1w
            // 매 타임프레임 경계에서 RDS 저장된 하위 캔들로 상위 집계
            int64_t now = get_current_epoch();

            // 4시간봉 집계 (1h × 4 → 4h)
            int64_t aligned_4h = align_epoch_to_timeframe(now, SECONDS_4H);
            if (aligned_4h > last_4h_check && !known_symbols.empty()) {
                Logger::info("[HIER-AGG] 4h boundary reached, aggregating...");
                for (const auto& sym : known_symbols) {
                    aggregate_higher_timeframe(rds, aggregator, sym, "1h", "4h",
                                              SECONDS_4H, aligned_4h);
                }
                last_4h_check = aligned_4h;
            }

            // 일봉 집계 (1h × 24 → 1d)
            int64_t aligned_1d = align_epoch_to_timeframe(now, SECONDS_1D);
            if (aligned_1d > last_1d_check && !known_symbols.empty()) {
                Logger::info("[HIER-AGG] 1d boundary reached, aggregating...");
                for (const auto& sym : known_symbols) {
                    aggregate_higher_timeframe(rds, aggregator, sym, "1h", "1d",
                                              SECONDS_1D, aligned_1d);
                }
                last_1d_check = aligned_1d;
            }

            // 주봉 집계 (1d × 7 → 1w)
            int64_t aligned_1w = align_epoch_to_timeframe(now, SECONDS_1W);
            if (aligned_1w > last_1w_check && !known_symbols.empty()) {
                Logger::info("[HIER-AGG] 1w boundary reached, aggregating...");
                for (const auto& sym : known_symbols) {
                    aggregate_higher_timeframe(rds, aggregator, sym, "1d", "1w",
                                              SECONDS_1W, aligned_1w);
                }
                last_1w_check = aligned_1w;
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
