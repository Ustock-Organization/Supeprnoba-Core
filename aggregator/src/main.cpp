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

// KST 오프셋 (UTC+9)
static const int64_t KST_OFFSET = 9 * 3600;

// UTC epoch → 해당 주 월요일 00:00 KST (UTC epoch 반환)
static int64_t get_monday_kst(int64_t utc_epoch) {
    const int SECONDS_1D = 86400;
    int64_t kst_days = (utc_epoch + KST_OFFSET) / SECONDS_1D;
    int kst_dow = (kst_days + 4) % 7;  // 0=일, 1=월, ..., 6=토
    int days_since_monday = (kst_dow == 0) ? 6 : (kst_dow - 1);
    return (kst_days - days_since_monday) * SECONDS_1D - KST_OFFSET;
}

// [Phase 3] YYYYMMDDHHmm 형식으로 변환 (KST 기준)
std::string epoch_to_ymdhm(int64_t epoch) {
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
    time_t kst_time = static_cast<time_t>(epoch + KST_OFFSET);
    struct tm* tm = gmtime(&kst_time);

    char buf[16];
    snprintf(buf, sizeof(buf), "%04d-%02d-%02d",
             tm->tm_year + 1900, tm->tm_mon + 1, tm->tm_mday);
    return std::string(buf);
}

// [Phase 3] 계층적 집계 수행 (4h, 1d, 1w)
// source_interval에서 데이터를 읽어 target_interval로 집계
// replace=true: progressive 재집계 시 전체 덮어쓰기 (volume 이중 계산 방지)
void aggregate_higher_timeframe(
    RdsClient& rds,
    Aggregator& agg,
    const std::string& symbol,
    const std::string& source_interval,
    const std::string& target_interval,
    int target_seconds,
    int64_t target_epoch,
    bool replace = false) {

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

    // 저장 (replace=true면 전체 덮어쓰기)
    bool saved = replace
        ? rds.put_candle_replace(symbol, target_interval, agg_candle)
        : rds.put_candle(symbol, target_interval, agg_candle);

    if (saved) {
        Logger::info("[HIER-AGG]", symbol, target_interval, "@", aligned_time,
                    "aggregated from", source_candles.size(), source_interval, "candles",
                    replace ? "(replace)" : "");
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
    Logger::info("Depth Cache:", cfg.depth_host, ":", cfg.depth_port);
    Logger::info("Candle Cache:", cfg.candle_host, ":", cfg.candle_port);
    Logger::info("Backup Cache:", cfg.backup_host, ":", cfg.backup_port);
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

    // 클라이언트 초기화 — 3-Cache 아키텍처
    ValkeyClient candle_valkey(cfg.candle_host, cfg.candle_port);
    if (!candle_valkey.connect()) {
        Logger::error("Failed to connect to Candle Cache");
        Aws::ShutdownAPI(options);
        return 1;
    }
    Logger::info("Connected to Candle Cache:", cfg.candle_host, ":", cfg.candle_port);

    ValkeyClient depth_valkey(cfg.depth_host, cfg.depth_port);
    if (!depth_valkey.connect()) {
        Logger::error("Failed to connect to Depth Cache");
        Aws::ShutdownAPI(options);
        return 1;
    }
    Logger::info("Connected to Depth Cache:", cfg.depth_host, ":", cfg.depth_port);

    ValkeyClient backup_valkey(cfg.backup_host, cfg.backup_port);
    if (!backup_valkey.connect()) {
        Logger::error("Failed to connect to Backup Cache");
        Aws::ShutdownAPI(options);
        return 1;
    }
    Logger::info("Connected to Backup Cache:", cfg.backup_host, ":", cfg.backup_port);

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

    // 주기적 작업 상태 추적
    int64_t last_ranking_check = 0;  // 시간별 랭킹 업데이트
    int64_t last_stats_time = 0;  // 통계 로깅 시간
    int64_t last_cleanup_time = 0;  // 정리 시간
    int64_t last_stale_check = 0;   // 스테일 캔들 체크 시간

    const int SECONDS_1H = 3600;
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

    // 연결 헬스체크 주기(초). 매 루프(10ms)마다 PING하면 캐시에 부하가 크다.
    int64_t last_health_check = 0;
    int consecutive_health_failures = 0;

    while (running) {
        try {
            int64_t now = get_current_epoch();

            // -1. 연결 헬스체크 — 재연결이 없으면 Valkey 블립 한 번에 좀비가 된다.
            //     redisCommand는 nullptr을 반환하지만 프로세스는 살아 있어
            //     systemd Restart=on-failure가 발동하지 않고 캔들 집계만 조용히 멈춘다.
            if (now - last_health_check >= 5) {
                last_health_check = now;
                bool ok = candle_valkey.ensureConnected() && depth_valkey.ensureConnected();
                if (!ok) {
                    if (++consecutive_health_failures >= 12) {   // 약 1분
                        Logger::error("Valkey 재연결 1분 이상 실패 — 프로세스를 종료해 "
                                      "systemd 재시작에 위임합니다");
                        return 1;
                    }
                    Logger::warn("Valkey 재연결 실패(", consecutive_health_failures, "회) — 재시도");
                    std::this_thread::sleep_for(std::chrono::seconds(1));
                    continue;
                }
                consecutive_health_failures = 0;
            }

            // 0. Close stale 1m candles (every 10s)
            if (now - last_stale_check > 10) {
                std::string current_minute_kst = Aggregator::epoch_to_ymdhm(now);
                int closed = candle_valkey.close_stale_candles(current_minute_kst);
                if (closed > 0) {
                    Logger::info("[STALE] Closed", closed, "stale 1m candles");
                }
                last_stale_check = now;
            }

            // 1. closed 캔들이 있는 심볼 목록 조회
            auto symbols = candle_valkey.get_closed_symbols();

            for (const auto& symbol : symbols) {
                // 2. 마감된 1분봉 POP (RPOP - 오래된 순)
                auto closed_1m = candle_valkey.pop_closed_candles(symbol, 60);  // 최대 60개씩 처리

                if (closed_1m.empty()) continue;

                Logger::info("[INC]", symbol, "- processing", closed_1m.size(), "closed 1m candles");

                // 새 심볼 발견 시 RDS 파티션 확인/생성
                if (known_symbols.find(symbol) == known_symbols.end()) {
                    if (rds_connected) {
                        rds.ensure_partition(symbol);
                        Logger::info("[PARTITION] Ensured partition for new symbol:", symbol);
                    }
                }

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
                        Candle current = candle_valkey.get_candle(key);

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

                            // === EVENT-DRIVEN 1d + 1w AGGREGATION ===
                            // 1h 마감 시 KST 일 경계 통과 확인 → 1d 집계 트리거
                            if (tf.interval == "1h" && rds_connected) {
                                int64_t closed_kst_day = (result.closed_candle.epoch() + KST_OFFSET) / SECONDS_1D;
                                int64_t new_kst_day = (result.current_candle.epoch() + KST_OFFSET) / SECONDS_1D;

                                if (closed_kst_day != new_kst_day) {
                                    // KST 일 경계 통과 — 전일 1d 집계
                                    int64_t day_end = new_kst_day * SECONDS_1D - KST_OFFSET;
                                    int64_t day_start = day_end - SECONDS_1D;

                                    Logger::info("[EVENT-1D]", symbol, "day boundary crossed, aggregating 1d...");

                                    aggregate_higher_timeframe(rds, aggregator, symbol, "1h", "1d",
                                                              SECONDS_1D, day_end, /*replace=*/true);

                                    // prevClose 갱신
                                    auto candles_1d = rds.get_candles_by_interval(symbol, "1d", day_start, day_end);
                                    if (!candles_1d.empty()) {
                                        double close_price = candles_1d.back().close;
                                        double old_prev = depth_valkey.get_prev_close(symbol);
                                        depth_valkey.set_prev_close(symbol, close_price);

                                        std::string trading_date = epoch_to_date(day_start);
                                        rds.update_prev_close(symbol, close_price, trading_date);

                                        if (old_prev > 0) {
                                            double pct = (close_price - old_prev) / old_prev * 100.0;
                                            backup_valkey.update_ranking(symbol, pct);
                                        }
                                        Logger::info("[EVENT-1D]", symbol, "close:", close_price,
                                                    "prev:", old_prev, "date:", trading_date);
                                    }

                                    // === Progressive 1w ===
                                    int64_t closed_monday = get_monday_kst(day_start);
                                    int64_t new_monday = get_monday_kst(day_end);
                                    if (closed_monday != new_monday) {
                                        // 주 경계 통과 — 이전 주 확정
                                        Logger::info("[EVENT-1W]", symbol, "week boundary crossed, finalizing previous week");
                                        aggregate_higher_timeframe(rds, aggregator, symbol, "1d", "1w",
                                                                  SECONDS_1W, new_monday, /*replace=*/true);
                                    }
                                    // 현재 주 진행중 업데이트
                                    Logger::info("[PROGRESSIVE-1W]", symbol, "updating current week candle");
                                    aggregate_higher_timeframe(rds, aggregator, symbol, "1d", "1w",
                                                              SECONDS_1W, new_monday + SECONDS_1W, /*replace=*/true);
                                }
                            }
                        }

                        // 업데이트된 캔들 Valkey에 저장 + TTL
                        int ttl = get_ttl_for_interval(tf.interval);
                        candle_valkey.set_candle(key, result.current_candle, ttl);
                    }
                }

                // 4. 리스트 길이 체크 및 정리 (안전장치)
                size_t list_len = candle_valkey.get_list_length("candle:closed:1m:" + symbol);
                if (list_len > 300) {
                    // 300개 초과 시 경고
                    Logger::warn("[WARN]", symbol, "closed list has", list_len, "candles");
                }
            }

            // 5. 시간별 랭킹 업데이트 (gainers/losers)
            {
                int64_t aligned_1h = (now / SECONDS_1H) * SECONDS_1H;
                if (aligned_1h > last_ranking_check && !known_symbols.empty()) {
                    Logger::info("[RANKING] Hourly ranking update, symbols:", known_symbols.size());

                    for (const auto& sym : known_symbols) {
                        // 현재 가격: ticker:SYMBOL에서 조회
                        double current_price = depth_valkey.get_ticker_price(sym);
                        if (current_price <= 0) continue;

                        // 전일종가: prev:SYMBOL에서 조회
                        double prev_close = depth_valkey.get_prev_close(sym);
                        if (prev_close <= 0) continue;

                        // 변동률 계산 + 랭킹 업데이트
                        double change_pct = (current_price - prev_close) / prev_close * 100.0;
                        backup_valkey.update_ranking(sym, change_pct);
                        Logger::debug("[RANKING-1H]", sym, "price:", current_price,
                                     "prev:", prev_close, "change:", change_pct, "%");
                    }
                    last_ranking_check = aligned_1h;
                    Logger::info("[RANKING] Hourly ranking update complete");
                }
            }

            // 6. (REMOVED — 1d/1w는 이제 1h 마감 이벤트 기반으로 처리됨)

            // 7. 주기적 통계 로깅 (5분마다)
            if (now - last_stats_time > 300) {
                Logger::info("[STATS] Symbols:", known_symbols.size(),
                            "Active:", symbol_last_seen.size());
                last_stats_time = now;
            }

            // 8. 비활성 심볼 정리 (10분마다, 1시간 이상 비활성)
            // [FIX] known_symbols는 보존 (1d/1w 계층적 집계에 필요)
            //       symbol_last_seen만 정리하여 통계 정확도 유지
            if (now - last_cleanup_time > 600) {
                const int64_t INACTIVE_THRESHOLD = 3600;  // 1시간
                int cleaned = 0;
                for (auto it = symbol_last_seen.begin(); it != symbol_last_seen.end();) {
                    if (now - it->second > INACTIVE_THRESHOLD) {
                        Logger::debug("[CLEANUP] Symbol inactive (stats only):", it->first);
                        it = symbol_last_seen.erase(it);
                        cleaned++;
                    } else {
                        ++it;
                    }
                }
                if (cleaned > 0) {
                    Logger::info("[CLEANUP] Cleared", cleaned, "inactive from stats.",
                                "known_symbols preserved:", known_symbols.size());
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
