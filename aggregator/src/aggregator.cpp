#include "aggregator.h"
#include "logger.h"
#include <algorithm>
#include <ctime>
#include <sstream>
#include <iomanip>

namespace aggregator {

Aggregator::Aggregator() {}

std::string Aggregator::align_to_timeframe(const std::string& ymdhm, int minutes) {
    // "202512161423" → 분을 타임프레임 경계로 정렬
    int year = std::stoi(ymdhm.substr(0, 4));
    int month = std::stoi(ymdhm.substr(4, 2));
    int day = std::stoi(ymdhm.substr(6, 2));
    int hour = std::stoi(ymdhm.substr(8, 2));
    int min = std::stoi(ymdhm.substr(10, 2));
    
    // 타임프레임 경계로 정렬 (내림)
    // [FIX] 60분 이상 타임프레임(4h 등) 지원을 위해 시+분 통합 계산
    int total_min = hour * 60 + min;
    int aligned_total = (total_min / minutes) * minutes;
    
    int aligned_hour = aligned_total / 60;
    int aligned_min = aligned_total % 60;
    
    std::ostringstream oss;
    oss << std::setfill('0') << std::setw(4) << year
        << std::setw(2) << month
        << std::setw(2) << day
        << std::setw(2) << aligned_hour
        << std::setw(2) << aligned_min;
    return oss.str();
}

bool Aggregator::is_timeframe_boundary(const std::string& ymdhm, const Timeframe& tf) {
    int min = std::stoi(ymdhm.substr(10, 2));
    return (min % tf.minutes == 0);
}

Candle Aggregator::aggregate_candles(const std::vector<Candle>& candles, 
                                    const std::string& aligned_time) {
    Candle result;
    if (candles.empty()) return result;
    
    // 시간순 정렬 (오래된 것 먼저)
    std::vector<Candle> sorted = candles;
    std::sort(sorted.begin(), sorted.end(), [](const Candle& a, const Candle& b) {
        return a.time < b.time;
    });
    
    result.symbol = sorted[0].symbol;
    result.time = aligned_time;
    result.open = sorted[0].open;          // 첫 캔들의 시가
    result.close = sorted.back().close;    // 마지막 캔들의 종가
    result.high = sorted[0].high;
    result.low = sorted[0].low;
    result.volume = 0;
    
    for (const auto& c : sorted) {
        if (c.high > result.high) result.high = c.high;
        if (c.low < result.low) result.low = c.low;
        result.volume += c.volume;
    }
    
    return result;
}

// 타임프레임 종료 시간 계산 (aligned_time + minutes)
// [FIX] epoch 변환으로 월/년 경계 오버플로 방지
std::string Aggregator::get_timeframe_end(const std::string& aligned_time, int minutes) {
    // KST 시간 문자열 → UTC epoch → 분 추가 → KST 시간 문자열
    int64_t utc_epoch = Candle::ymdhm_to_utc_epoch(aligned_time);
    if (utc_epoch == 0) return aligned_time;  // 파싱 실패 시 원본 반환

    utc_epoch += static_cast<int64_t>(minutes) * 60;
    return epoch_to_ymdhm(utc_epoch);
}

std::map<std::string, std::vector<Candle>> Aggregator::aggregate(
    const std::vector<Candle>& one_min_candles) {

    std::map<std::string, std::vector<Candle>> result;

    if (one_min_candles.empty()) return result;

    // 1분봉은 그대로 추가
    result["1m"] = one_min_candles;

    // [FIX] 가장 최근 1분봉 시간을 "현재 시간"으로 사용
    // 이 시간 이전에 종료된 타임프레임만 집계
    std::string latest_time = one_min_candles[0].time;
    for (const auto& c : one_min_candles) {
        if (c.time > latest_time) latest_time = c.time;
    }

    // 각 타임프레임별로 집계
    for (const auto& tf : TIMEFRAMES) {
        if (tf.minutes <= 1) continue;  // 1분봉은 스킵

        // 1분봉들을 타임프레임 경계로 그룹화
        std::map<std::string, std::vector<Candle>> groups;

        for (const auto& candle : one_min_candles) {
            std::string aligned = align_to_timeframe(candle.time, tf.minutes);
            groups[aligned].push_back(candle);
        }

        // 각 그룹을 하나의 캔들로 집계
        std::vector<Candle> aggregated;
        for (const auto& [aligned_time, group_candles] : groups) {
            // [FIX] 타임프레임이 완전히 종료된 경우만 저장
            // 예: 3분봉 09:18은 09:21이 되어야 저장
            std::string tf_end = get_timeframe_end(aligned_time, tf.minutes);

            if (tf_end > latest_time) {
                // 아직 진행중인 타임프레임 - 저장하지 않음
                Logger::debug("[AGG-SKIP]", tf.interval, "@", aligned_time,
                             "not closed yet (ends at", tf_end, ", latest:", latest_time, ")");
                continue;
            }

            // [FIX] 최소 50% 캔들이 있으면 집계 허용
            size_t min_required = std::max(static_cast<size_t>(1),
                                           static_cast<size_t>(tf.minutes) / 2);

            if (group_candles.size() >= min_required) {
                Candle agg = aggregate_candles(group_candles, aligned_time);
                aggregated.push_back(agg);

                // 부분 집계인 경우 경고 로그
                if (group_candles.size() < static_cast<size_t>(tf.minutes)) {
                    Logger::debug("[AGG-PARTIAL]", agg.symbol, tf.interval, "@", aligned_time,
                                 "candles:", group_candles.size(), "/", tf.minutes,
                                 "O:", agg.open, "H:", agg.high, "L:", agg.low, "C:", agg.close);
                } else {
                    Logger::debug("[AGG]", agg.symbol, tf.interval, "@", aligned_time,
                                 "O:", agg.open, "H:", agg.high, "L:", agg.low, "C:", agg.close);
                }
            }
        }

        if (!aggregated.empty()) {
            result[tf.interval] = aggregated;
        }
    }

    return result;
}

// epoch → 타임프레임 시작 epoch 정렬
int64_t Aggregator::align_epoch_to_timeframe(int64_t epoch, int seconds) {
    return (epoch / seconds) * seconds;
}

// epoch → YYYYMMDDHHmm 변환 (KST)
std::string Aggregator::epoch_to_ymdhm(int64_t epoch) {
    const int64_t KST_OFFSET = 9 * 3600;  // UTC+9
    time_t kst_time = static_cast<time_t>(epoch + KST_OFFSET);
    struct tm* tm = gmtime(&kst_time);

    std::ostringstream oss;
    oss << std::setfill('0')
        << std::setw(4) << (tm->tm_year + 1900)
        << std::setw(2) << (tm->tm_mon + 1)
        << std::setw(2) << tm->tm_mday
        << std::setw(2) << tm->tm_hour
        << std::setw(2) << tm->tm_min;
    return oss.str();
}

Aggregator::UpdateResult Aggregator::update_candle_incremental(
    const Candle& source,
    const Candle& current,
    const Timeframe& tf)
{
    UpdateResult result;
    result.is_closed = false;

    // 소스 캔들의 epoch을 타임프레임 경계로 정렬
    int64_t source_epoch = source.epoch();
    int64_t aligned_epoch = align_epoch_to_timeframe(source_epoch, tf.seconds);
    std::string aligned_time = epoch_to_ymdhm(aligned_epoch);

    // 현재 진행중인 캔들의 epoch
    int64_t current_epoch = current.epoch();

    // 새 구간 시작인지 체크
    if (current.time.empty() || current_epoch != aligned_epoch) {
        // 기존 캔들 마감
        if (!current.time.empty()) {
            result.is_closed = true;
            result.closed_candle = current;
        }

        // 새 캔들 시작
        result.current_candle.symbol = source.symbol;
        result.current_candle.time = aligned_time;
        result.current_candle.open = source.open;
        result.current_candle.high = source.high;
        result.current_candle.low = source.low;
        result.current_candle.close = source.close;
        result.current_candle.volume = source.volume;

        Logger::debug("[INC-NEW]", source.symbol, tf.interval, "@", aligned_time,
                     "O:", source.open, "H:", source.high, "L:", source.low, "C:", source.close);
    } else {
        // 기존 캔들 업데이트
        result.current_candle = current;
        result.current_candle.high = std::max(current.high, source.high);
        result.current_candle.low = std::min(current.low, source.low);
        result.current_candle.close = source.close;
        result.current_candle.volume = current.volume + source.volume;

        Logger::debug("[INC-UPD]", source.symbol, tf.interval, "@", aligned_time,
                     "H:", result.current_candle.high, "L:", result.current_candle.low,
                     "C:", result.current_candle.close);
    }

    return result;
}

} // namespace aggregator
