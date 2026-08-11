#pragma once

#include <string>
#include <vector>
#include <memory>
#include <functional>

struct redisContext;

namespace aggregator {

struct Candle {
    std::string symbol;
    std::string time;      // YYYYMMDDHHmm 형식 (KST)
    double open;
    double high;
    double low;
    double close;
    double volume;
    int64_t cached_epoch = 0;  // Engine에서 전달된 t_epoch (UTC)

    int64_t epoch() const;  // epoch 초 변환 (UTC)

    // 타임존 독립적 epoch 계산 (static helper)
    static int64_t ymdhm_to_utc_epoch(const std::string& ymdhm_kst);
};

class ValkeyClient {
public:
    ValkeyClient(const std::string& host, int port);
    ~ValkeyClient();
    
    bool connect();
    bool ping();
    
    // 심볼 목록 조회 (candle:closed:1m:* 패턴)
    std::vector<std::string> get_closed_symbols();
    
    // === 진행중 캔들 관리 (증분 업데이트용) ===

    // 진행중 캔들 조회 (candle:{interval}:{symbol})
    Candle get_candle(const std::string& key);

    // 진행중 캔들 저장 + TTL 설정
    bool set_candle(const std::string& key, const Candle& candle, int ttl_seconds);

    // 마감된 1분봉 POP (LPOP - 오래된 순)
    std::vector<Candle> pop_closed_candles(const std::string& symbol, size_t max_count = 100);

    // 리스트 길이 조회
    size_t get_list_length(const std::string& key);

    // TTL 설정
    bool set_expire(const std::string& key, int ttl_seconds);

    // === 전일종가 및 랭킹 관리 ===

    // prev:{symbol} 키에 전일종가 저장
    bool set_prev_close(const std::string& symbol, double close_price);

    // prev:{symbol} 키에서 전일종가 조회
    double get_prev_close(const std::string& symbol);

    // 급등/급락 랭킹 업데이트 (ranking:gainers, ranking:losers)
    bool update_ranking(const std::string& symbol, double change_pct);

    // ticker:{symbol}에서 현재 가격 조회
    double get_ticker_price(const std::string& symbol);

    // 스테일 1m 캔들 마감 (current_minute_kst보다 이전 분의 캔들을 closed 리스트로 이동)
    int close_stale_candles(const std::string& current_minute_kst);

private:
    std::string host_;
    int port_;
    redisContext* ctx_;
};

} // namespace aggregator
