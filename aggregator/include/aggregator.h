#pragma once

#include "valkey_client.h"
#include <vector>
#include <map>
#include <string>

namespace aggregator {

// 타임프레임 정의
struct Timeframe {
    std::string interval;  // "1m", "3m", "5m", ...
    int seconds;           // 60, 180, 300, ...
    int minutes;           // 1, 3, 5, ...
};

// 미리 정의된 타임프레임 목록
const std::vector<Timeframe> TIMEFRAMES = {
    {"1m", 60, 1},
    {"3m", 180, 3},
    {"5m", 300, 5},
    {"15m", 900, 15},
    {"30m", 1800, 30},
    {"1h", 3600, 60},
    {"4h", 14400, 240},
    {"1d", 86400, 1440},
    {"1w", 604800, 10080}
};

class Aggregator {
public:
    Aggregator();
    
    // 1분봉 리스트를 상위 타임프레임으로 집계
    std::map<std::string, std::vector<Candle>> aggregate(
        const std::vector<Candle>& one_min_candles);
    
    // 현재 시간이 타임프레임 경계인지 확인
    static bool is_timeframe_boundary(const std::string& ymdhm, const Timeframe& tf);
    
    // YYYYMMDDHHmm → 타임프레임 시작 시간 정렬
    static std::string align_to_timeframe(const std::string& ymdhm, int minutes);
    
private:
    // N개의 1분봉을 1개의 캔들로 집계
    Candle aggregate_candles(const std::vector<Candle>& candles, 
                            const std::string& aligned_time);
};

} // namespace aggregator
