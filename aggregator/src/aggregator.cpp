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
    int aligned_min = (min / minutes) * minutes;
    
    std::ostringstream oss;
    oss << std::setfill('0') << std::setw(4) << year
        << std::setw(2) << month
        << std::setw(2) << day
        << std::setw(2) << hour
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

std::map<std::string, std::vector<Candle>> Aggregator::aggregate(
    const std::vector<Candle>& one_min_candles) {
    
    std::map<std::string, std::vector<Candle>> result;
    
    if (one_min_candles.empty()) return result;
    
    // 1분봉은 그대로 추가
    result["1m"] = one_min_candles;
    
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
            // 완성된 캔들만 추가 (분 수가 맞는지 확인)
            if (group_candles.size() >= static_cast<size_t>(tf.minutes)) {
                Candle agg = aggregate_candles(group_candles, aligned_time);
                aggregated.push_back(agg);
                Logger::debug("[AGG]", agg.symbol, tf.interval, "@", aligned_time,
                             "O:", agg.open, "H:", agg.high, "L:", agg.low, "C:", agg.close);
            }
        }
        
        if (!aggregated.empty()) {
            result[tf.interval] = aggregated;
        }
    }
    
    return result;
}

} // namespace aggregator
