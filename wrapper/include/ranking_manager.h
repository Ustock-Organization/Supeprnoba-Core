#pragma once

#include <string>
#include <memory>
#include <thread>
#include <atomic>
#include <unordered_map>
#include <mutex>
#include <cstdint>

namespace aws_wrapper {

class RedisClient;  // forward declaration

/**
 * RankingManager: 시장 랭킹 관리
 *
 * - 체결 시 실시간으로 랭킹 업데이트 (ZADD)
 * - 10초 주기로 스냅샷 생성 및 Pub/Sub 브로드캐스트
 * - 백업용 Valkey에 저장:
 *   - ranking:marketcap   시가총액 순위 (전체 종목)
 *   - ranking:volume      거래량 순위 (전체 종목)
 *   - ranking:gainers     급등 순위 (상위 100)
 *   - ranking:losers      급락 순위 (상위 100)
 *   - rankings:snapshot   JSON 스냅샷 (TTL 15초)
 */
class RankingManager {
public:
    /**
     * @param backup_redis 백업용 Valkey 클라이언트
     */
    explicit RankingManager(RedisClient* write_redis, RedisClient* read_redis);
    ~RankingManager();

    // 복사/이동 금지 (스레드 소유)
    RankingManager(const RankingManager&) = delete;
    RankingManager& operator=(const RankingManager&) = delete;

    /**
     * 체결 시 랭킹 업데이트
     *
     * @param symbol        종목 심볼
     * @param price         체결가
     * @param fill_qty      체결 수량
     * @param change_pct    등락률 (%)
     * @param total_shares  총 발행 주식 수 (시가총액 계산용)
     */
    void updateOnFill(const std::string& symbol,
                      uint64_t price,
                      uint64_t fill_qty,
                      double change_pct,
                      uint64_t total_shares);

    /**
     * 종목의 총 발행 주식 수 캐시 설정
     * (엔진 시작 시 DynamoDB에서 로드하여 설정)
     */
    void setTotalShares(const std::string& symbol, uint64_t total_shares);
    uint64_t getTotalShares(const std::string& symbol) const;

    /**
     * 스냅샷 스레드 시작 (10초 주기)
     */
    void startSnapshotThread();

    /**
     * 스냅샷 스레드 중지
     */
    void stopSnapshotThread();

    /**
     * 즉시 스냅샷 생성 및 브로드캐스트
     */
    void computeAndBroadcastSnapshot();

private:
    RedisClient* write_redis_;  // main thread (on_fill → zadd/zincrby)
    RedisClient* read_redis_;   // bg thread (zrevrange/setEx/publish/del)

    // 총 발행 주식 수 캐시 (symbol -> totalShares)
    mutable std::mutex shares_mutex_;
    std::unordered_map<std::string, uint64_t> total_shares_cache_;

    // 스냅샷 스레드
    std::atomic<bool> running_{false};
    std::thread snapshot_thread_;

    // 일일 거래량 리셋 추적 (KST 기준 YYYYMMDD)
    int last_volume_reset_kst_day_ = 0;

    // 스냅샷 생성 루프
    void snapshotLoop();

    // JSON 스냅샷 빌드
    std::string buildSnapshotJson();

    // ISO 8601 타임스탬프 생성
    std::string getCurrentISOTime() const;

    // KST 기준 현재 날짜 (YYYYMMDD)
    int getCurrentKSTDay() const;

    // 일일 거래량 리셋 (KST 자정)
    void resetDailyVolumeIfNeeded();
};

} // namespace aws_wrapper
