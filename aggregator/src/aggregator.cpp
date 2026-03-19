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
