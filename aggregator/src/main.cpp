// Candle Aggregator - Main Entry Point
// 실시간 타임프레임 집계 서비스 (RDS PostgreSQL 저장)

#include "config.h"
#include "logger.h"
#include "valkey_client.h"
#include "aggregator.h"
#include "rds_client.h"
#include "secrets_manager.h"

#include <aws/core/Aws.h>
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

// epoch → YYYY-MM-DD 문자열 변환 (KST 기준, RDS용)
std::string epoch_to_date(int64_t epoch) {
    const int64_t KST_OFFSET = 9 * 3600;  // UTC+9
    time_t kst_time = static_cast<time_t>(epoch + KST_OFFSET);
    struct tm* tm = gmtime(&kst_time);

    char buf[16];
    snprintf(buf, sizeof(buf), "%04d-%02d-%02d",
             tm->tm_year + 1900, tm->tm_mon + 1, tm->tm_mday);
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

    // AWS SDK 초기화
    Aws::SDKOptions options;
    options.loggingOptions.logLevel = Aws::Utils::Logging::LogLevel::Warn;
    Aws::InitAPI(options);

    int exit_code = 0;

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
    Logger::info("AWS Region:", cfg.aws_region);
    Logger::info("DB Secret:", cfg.db_credentials_secret_name);
    Logger::info("Poll Interval:", cfg.poll_interval_ms, "ms");
    Logger::info("=====================");

    // Secrets Manager에서 DB credentials 가져오기
    SecretsManager secrets(cfg);
    auto db_creds = secrets.getDbCredentials();
    if (!db_creds.has_value()) {
        Logger::error("Failed to get database credentials from Secrets Manager");
        Logger::error("Please ensure the secret", cfg.db_credentials_secret_name, "exists");
        Aws::ShutdownAPI(options);
        return 1;
    }

    Logger::info("DB credentials loaded from Secrets Manager");
    Logger::info("RDS Host:", db_creds->host);
    Logger::info("RDS Port:", db_creds->port);
    Logger::info("RDS DB:", db_creds->database);

    // 클라이언트 초기화
    ValkeyClient valkey(cfg.valkey_host, cfg.valkey_port);
    if (!valkey.connect()) {
        Logger::error("Failed to connect to Valkey");
        Aws::ShutdownAPI(options);
        return 1;
    }
    Logger::info("Connected to Valkey");

    RdsClient rds(db_creds->host, db_creds->port, db_creds->database,
                  db_creds->username, db_creds->password);
    bool rds_connected = rds.connect();
    if (!rds_connected) {
        Logger::warn("Failed to connect to RDS - running in Valkey-only mode");
        Logger::warn("RDS operations will be skipped");
    } else {
        Logger::info("Connected to RDS PostgreSQL");
    }
    
    Aggregator aggregator;
    
    Logger::info("=== Aggregator Running ===");
    Logger::info("Polling for closed candles every", cfg.poll_interval_ms, "ms");
    
    // === 증분 업데이트용 상태 ===
    std::set<std::string> known_symbols;           // 알려진 심볼 목록
    std::map<std::string, int64_t> symbol_last_seen;  // 심볼별 마지막 활동 시간

    // 1d/1w 계층적 집계 상태 추적
    int64_t last_1d_check = 0;
    int64_t last_1w_check = 0;
    int64_t last_stats_time = 0;  // 통계 로깅 시간
    int64_t last_cleanup_time = 0;  // 정리 시간

    const int SECONDS_1D = 24 * 3600;
    const int SECONDS_1W = 7 * 24 * 3600;

    // 타임프레임별 TTL 헬퍼
    auto get_ttl_for_interval = [](const std::string& interval) -> int {
        if (interval == "3m") return 360;       // 6분
        if (interval == "5m") return 600;       // 10분
        if (interval == "15m") return 1800;     // 30분
        if (interval == "30m") return 3600;     // 1시간
        if (interval == "1h") return 7200;      // 2시간
        if (interval == "4h") return 28800;     // 8시간
        return 3600;  // 기본 1시간
    };

    Logger::info("=== Incremental Aggregation Mode ===");

    while (running) {
        try {
            int64_t now = get_current_epoch();

            // 1. closed 캔들이 있는 심볼 목록 조회
            auto symbols = valkey.get_closed_symbols();

            for (const auto& symbol : symbols) {
                // 2. 마감된 1분봉 POP (RPOP - 오래된 순)
                auto closed_1m = valkey.pop_closed_candles(symbol, 60);  // 최대 60개씩 처리

                if (closed_1m.empty()) continue;

                Logger::info("[INC]", symbol, "- processing", closed_1m.size(), "closed 1m candles");

                // 심볼 활동 기록
                symbol_last_seen[symbol] = now;
                known_symbols.insert(symbol);

                // 3. 각 1분봉에 대해 상위 타임프레임 증분 업데이트
                for (const auto& candle_1m : closed_1m) {
                    // 1분봉은 직접 RDS에 저장 (연결된 경우만)
                    if (rds_connected && rds.put_candle(symbol, "1m", candle_1m)) {
                        Logger::debug("[RDS] 1m saved:", symbol, "@", candle_1m.time);
                    }

                    // 상위 타임프레임 업데이트
                    for (const auto& tf : HIGHER_TIMEFRAMES) {
                        std::string key = "candle:" + tf.interval + ":" + symbol;

                        // 현재 진행중인 캔들 조회
                        Candle current = valkey.get_candle(key);

                        // 증분 업데이트
                        auto result = aggregator.update_candle_incremental(
                            candle_1m, current, tf);

                        // 구간 마감 시 RDS 저장 (연결된 경우만)
                        if (result.is_closed) {
                            if (rds_connected && rds.put_candle(symbol, tf.interval, result.closed_candle)) {
                                Logger::info("[CLOSED]", symbol, tf.interval, "@",
                                            result.closed_candle.time,
                                            "O:", result.closed_candle.open,
                                            "H:", result.closed_candle.high,
                                            "L:", result.closed_candle.low,
                                            "C:", result.closed_candle.close);
                            } else if (!rds_connected) {
                                Logger::info("[CLOSED-VALKEY]", symbol, tf.interval, "@",
                                            result.closed_candle.time,
                                            "O:", result.closed_candle.open,
                                            "H:", result.closed_candle.high,
                                            "L:", result.closed_candle.low,
                                            "C:", result.closed_candle.close);
                            }
                        }

                        // 업데이트된 캔들 Valkey에 저장 + TTL
                        int ttl = get_ttl_for_interval(tf.interval);
                        valkey.set_candle(key, result.current_candle, ttl);
                    }
                }

                // 4. 리스트 길이 체크 및 정리 (안전장치)
                size_t list_len = valkey.get_list_length("candle:closed:1m:" + symbol);
                if (list_len > 300) {
                    // 300개 초과 시 경고
                    Logger::warn("[WARN]", symbol, "closed list has", list_len, "candles");
                }
            }

            // 5. 1d/1w 계층적 집계 (RDS 기반 - 연결된 경우만)
            if (rds_connected) {
                // 1d 경계: KST 자정 기준 (UTC 15:00 = KST 00:00)
                const int64_t KST_OFFSET = 9 * 3600;
                int64_t now_kst = now + KST_OFFSET;
                int64_t aligned_1d_kst = (now_kst / SECONDS_1D) * SECONDS_1D;
                int64_t aligned_1d = aligned_1d_kst - KST_OFFSET;  // UTC epoch으로 변환

                if (aligned_1d > last_1d_check && !known_symbols.empty()) {
                    Logger::info("[HIER-AGG] 1d boundary reached (KST midnight), aggregating...");

                    // 마감 일자 계산 (전일 KST 기준)
                    std::string trading_date = epoch_to_date(aligned_1d - SECONDS_1D);

                    for (const auto& sym : known_symbols) {
                        // 1. 1d 캔들 집계
                        aggregate_higher_timeframe(rds, aggregator, sym, "1h", "1d",
                                                  SECONDS_1D, aligned_1d);

                        // 2. 방금 저장된 1d 캔들 조회
                        auto candles_1d = rds.get_candles_by_interval(
                            sym, "1d", aligned_1d - SECONDS_1D, aligned_1d);

                        if (!candles_1d.empty()) {
                            double close_price = candles_1d.back().close;

                            // 3. 이전 prev_close 조회 (변동률 계산용)
                            double old_prev_close = valkey.get_prev_close(sym);

                            // 4. Valkey prev:{symbol} 업데이트
                            valkey.set_prev_close(sym, close_price);

                            // 5. RDS symbol_prev_close 업데이트
                            rds.update_prev_close(sym, close_price, trading_date);

                            // 6. 변동률 계산 및 ranking 업데이트
                            if (old_prev_close > 0) {
                                double change_pct = (close_price - old_prev_close) / old_prev_close * 100.0;
                                valkey.update_ranking(sym, change_pct);
                                Logger::info("[DAILY-CLOSE]", sym, "close:", close_price,
                                            "prev:", old_prev_close, "change:", change_pct, "%");
                            } else {
                                Logger::info("[DAILY-CLOSE]", sym, "close:", close_price, "(no prev)");
                            }
                        }
                    }
                    last_1d_check = aligned_1d;
                }

                int64_t aligned_1w = align_epoch_to_timeframe(now, SECONDS_1W);
                if (aligned_1w > last_1w_check && !known_symbols.empty()) {
                    Logger::info("[HIER-AGG] 1w boundary reached, aggregating...");
                    for (const auto& sym : known_symbols) {
                        aggregate_higher_timeframe(rds, aggregator, sym, "1d", "1w",
                                                  SECONDS_1W, aligned_1w);
                    }
                    last_1w_check = aligned_1w;
                }
            }

            // 6. 주기적 통계 로깅 (5분마다)
            if (now - last_stats_time > 300) {
                Logger::info("[STATS] Symbols:", known_symbols.size(),
                            "Active:", symbol_last_seen.size());
                last_stats_time = now;
            }

            // 7. 비활성 심볼 정리 (10분마다, 1시간 이상 비활성)
            if (now - last_cleanup_time > 600) {
                const int64_t INACTIVE_THRESHOLD = 3600;  // 1시간
                for (auto it = symbol_last_seen.begin(); it != symbol_last_seen.end();) {
                    if (now - it->second > INACTIVE_THRESHOLD) {
                        Logger::info("[CLEANUP] Removing inactive symbol:", it->first);
                        known_symbols.erase(it->first);
                        it = symbol_last_seen.erase(it);
                    } else {
                        ++it;
                    }
                }
                last_cleanup_time = now;
            }

        } catch (const std::exception& e) {
            Logger::error("Processing error:", e.what());
        }

        // 폴링 간격 대기
        std::this_thread::sleep_for(std::chrono::milliseconds(cfg.poll_interval_ms));
    }
    
    Logger::info("Aggregator stopped");
    rds.disconnect();

    // AWS SDK 종료
    Aws::ShutdownAPI(options);

    return exit_code;
}
