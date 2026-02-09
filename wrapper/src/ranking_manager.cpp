#include "ranking_manager.h"
#include "redis_client.h"
#include "logger.h"
#include <nlohmann/json.hpp>
#include <chrono>
#include <iomanip>
#include <sstream>

namespace aws_wrapper {

// 랭킹 키 상수
static const std::string KEY_MARKETCAP = "ranking:marketcap";
static const std::string KEY_VOLUME = "ranking:volume";
static const std::string KEY_GAINERS = "ranking:gainers";
static const std::string KEY_LOSERS = "ranking:losers";
static const std::string KEY_SNAPSHOT = "rankings:snapshot";
static const std::string CHANNEL_BROADCAST = "rankings:broadcast";

// 급등/급락 상위 100개만 유지
static const long MAX_GAINERS_LOSERS = 100;

// 스냅샷 TTL (초)
static const int SNAPSHOT_TTL_SEC = 15;

// 브로드캐스트 주기 (초)
static const int BROADCAST_INTERVAL_SEC = 10;

RankingManager::RankingManager(RedisClient* backup_redis)
    : backup_redis_(backup_redis) {
    Logger::info("RankingManager created");
}

RankingManager::~RankingManager() {
    stopSnapshotThread();
    Logger::info("RankingManager destroyed");
}

void RankingManager::setTotalShares(const std::string& symbol, uint64_t total_shares) {
    std::lock_guard<std::mutex> lock(shares_mutex_);
    total_shares_cache_[symbol] = total_shares;
}

uint64_t RankingManager::getTotalShares(const std::string& symbol) const {
    std::lock_guard<std::mutex> lock(shares_mutex_);
    auto it = total_shares_cache_.find(symbol);
    if (it != total_shares_cache_.end()) {
        return it->second;
    }
    return 0;
}

void RankingManager::updateOnFill(const std::string& symbol,
                                   uint64_t price,
                                   uint64_t fill_qty,
                                   double change_pct,
                                   uint64_t total_shares) {
    if (!backup_redis_) {
        Logger::warn("RankingManager: backup_redis is null, skipping update");
        return;
    }

    // 총 발행 주식 수 캐시 업데이트
    if (total_shares > 0) {
        setTotalShares(symbol, total_shares);
    }

    // 시가총액 = 현재가 × 총 발행 주식 수
    uint64_t cached_shares = getTotalShares(symbol);
    if (cached_shares == 0) {
        Logger::debug("RankingManager: totalShares not cached for", symbol, ", skipping marketcap update");
    } else {
        double market_cap = static_cast<double>(price) * static_cast<double>(cached_shares);
        backup_redis_->zadd(KEY_MARKETCAP, market_cap, symbol);
    }

    // 거래량 증가 (누적)
    backup_redis_->zincrby(KEY_VOLUME, static_cast<double>(fill_qty), symbol);

    // 급등/급락: Aggregator가 prev_close 기반으로 관리
    // change_pct가 0.0이면 (= 엔진에서 prev_close 없이 호출) Aggregator 데이터 보존을 위해 스킵
    if (change_pct != 0.0) {
        int64_t change_score = static_cast<int64_t>(change_pct * 1000000.0);
        backup_redis_->zadd(KEY_GAINERS, static_cast<double>(change_score), symbol);
        backup_redis_->zadd(KEY_LOSERS, static_cast<double>(-change_score), symbol);
        backup_redis_->zremrangebyrank(KEY_GAINERS, 0, -MAX_GAINERS_LOSERS - 1);
        backup_redis_->zremrangebyrank(KEY_LOSERS, 0, -MAX_GAINERS_LOSERS - 1);
    }

    Logger::debug("RankingManager: updated ranking for", symbol,
                  "price:", price, "qty:", fill_qty, "change:", change_pct, "%");
}

void RankingManager::startSnapshotThread() {
    if (running_.exchange(true)) {
        Logger::warn("RankingManager: snapshot thread already running");
        return;
    }

    snapshot_thread_ = std::thread(&RankingManager::snapshotLoop, this);
    Logger::info("RankingManager: snapshot thread started (interval:", BROADCAST_INTERVAL_SEC, "s)");
}

void RankingManager::stopSnapshotThread() {
    if (!running_.exchange(false)) {
        return;  // 이미 중지됨
    }

    if (snapshot_thread_.joinable()) {
        snapshot_thread_.join();
    }
    Logger::info("RankingManager: snapshot thread stopped");
}

void RankingManager::snapshotLoop() {
    while (running_) {
        auto start = std::chrono::steady_clock::now();

        try {
            computeAndBroadcastSnapshot();
        } catch (const std::exception& e) {
            Logger::error("RankingManager: snapshot error:", e.what());
        }

        // 10초 주기 대기
        auto elapsed = std::chrono::steady_clock::now() - start;
        auto sleep_time = std::chrono::seconds(BROADCAST_INTERVAL_SEC) - elapsed;
        if (sleep_time > std::chrono::milliseconds(0)) {
            std::this_thread::sleep_for(sleep_time);
        }
    }
}

void RankingManager::computeAndBroadcastSnapshot() {
    if (!backup_redis_) return;

    std::string snapshot_json = buildSnapshotJson();

    // 캐시 저장 (TTL 15초)
    backup_redis_->setEx(KEY_SNAPSHOT, snapshot_json, SNAPSHOT_TTL_SEC);

    // Pub/Sub 브로드캐스트
    long long subscribers = backup_redis_->publish(CHANNEL_BROADCAST, snapshot_json);
    Logger::debug("RankingManager: snapshot broadcast to", subscribers, "subscribers");
}

std::string RankingManager::buildSnapshotJson() {
    nlohmann::json snapshot;
    snapshot["timestamp"] = getCurrentISOTime();

    // 시가총액 TOP 100 (내림차순)
    auto top_marketcap = backup_redis_->zrevrange(KEY_MARKETCAP, 0, 99, true);
    nlohmann::json marketcap_arr = nlohmann::json::array();
    int rank = 1;
    for (const auto& [symbol, score] : top_marketcap) {
        marketcap_arr.push_back({
            {"rank", rank++},
            {"symbol", symbol},
            {"marketCap", static_cast<uint64_t>(score)}
        });
    }
    snapshot["marketcap"] = marketcap_arr;

    // 거래량 TOP 100 (내림차순)
    auto top_volume = backup_redis_->zrevrange(KEY_VOLUME, 0, 99, true);
    nlohmann::json volume_arr = nlohmann::json::array();
    rank = 1;
    for (const auto& [symbol, score] : top_volume) {
        volume_arr.push_back({
            {"rank", rank++},
            {"symbol", symbol},
            {"volume", static_cast<uint64_t>(score)}
        });
    }
    snapshot["volume"] = volume_arr;

    // 급등 TOP 100 (내림차순 = 등락률 높은 순)
    auto top_gainers = backup_redis_->zrevrange(KEY_GAINERS, 0, 99, true);
    nlohmann::json gainers_arr = nlohmann::json::array();
    rank = 1;
    for (const auto& [symbol, score] : top_gainers) {
        double change_pct = score / 1000000.0;  // 원래 등락률 복원
        gainers_arr.push_back({
            {"rank", rank++},
            {"symbol", symbol},
            {"change", change_pct}
        });
    }
    snapshot["gainers"] = gainers_arr;

    // 급락 TOP 100 (오름차순 = 등락률 낮은 순)
    // losers는 음수 점수로 저장되어 있으므로 zrange 사용
    auto top_losers = backup_redis_->zrange(KEY_LOSERS, 0, 99, true);
    nlohmann::json losers_arr = nlohmann::json::array();
    rank = 1;
    for (const auto& [symbol, score] : top_losers) {
        double change_pct = -score / 1000000.0;  // 음수 복원
        losers_arr.push_back({
            {"rank", rank++},
            {"symbol", symbol},
            {"change", change_pct}
        });
    }
    snapshot["losers"] = losers_arr;

    return snapshot.dump();
}

std::string RankingManager::getCurrentISOTime() const {
    auto now = std::chrono::system_clock::now();
    auto time_t_now = std::chrono::system_clock::to_time_t(now);
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()) % 1000;

    std::tm tm_utc;
#ifdef _WIN32
    gmtime_s(&tm_utc, &time_t_now);
#else
    gmtime_r(&time_t_now, &tm_utc);
#endif

    std::ostringstream oss;
    oss << std::put_time(&tm_utc, "%Y-%m-%dT%H:%M:%S")
        << '.' << std::setfill('0') << std::setw(3) << ms.count() << 'Z';
    return oss.str();
}

} // namespace aws_wrapper
