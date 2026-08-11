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

class Aggregator {
public:
    Aggregator();
    
    // YYYYMMDDHHmm → 타임프레임 시작 시간 정렬
    static std::string align_to_timeframe(const std::string& ymdhm, int minutes);

    // N개의 캔들을 1개의 캔들로 집계 (public for hierarchical aggregation)
    Candle aggregate_candles(const std::vector<Candle>& candles,
                            const std::string& aligned_time);

    // 증분 업데이트 (1분봉으로 상위 타임프레임 업데이트)
    struct UpdateResult {
        bool is_closed;      // 기존 구간이 마감되었나?
        Candle closed_candle; // 마감된 캔들 (is_closed=true일 때만 유효)
        Candle current_candle; // 업데이트된 현재 캔들
    };

    UpdateResult update_candle_incremental(
        const Candle& source,      // 1분봉 (소스)
        const Candle& current,     // 현재 진행중인 캔들
        const Timeframe& tf        // 타겟 타임프레임
    );

    // epoch → 타임프레임 시작 epoch 정렬
    static int64_t align_epoch_to_timeframe(int64_t epoch, int seconds);

    // epoch → YYYYMMDDHHmm 변환 (KST)
    static std::string epoch_to_ymdhm(int64_t epoch);
};

// 상위 타임프레임 목록 (1분 제외)
const std::vector<Timeframe> HIGHER_TIMEFRAMES = {
    {"3m", 180, 3},
    {"5m", 300, 5},
    {"15m", 900, 15},
    {"30m", 1800, 30},
    {"1h", 3600, 60},
    {"4h", 14400, 240}
};

} // namespace aggregator
