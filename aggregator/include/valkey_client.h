#pragma once

#include <string>
#include <vector>
#include <memory>
#include <functional>

struct redisContext;

namespace aggregator {

struct Candle {
    std::string symbol;
    std::string time;      // YYYYMMDDHHmm 형식
    double open;
    double high;
    double low;
    double close;
    double volume;
    
    int64_t epoch() const;  // epoch 초 변환
};

class ValkeyClient {
public:
    ValkeyClient(const std::string& host, int port);
    ~ValkeyClient();
    
    bool connect();
    bool ping();
    
    // 마감된 1분봉 리스트 조회
    std::vector<Candle> get_closed_candles(const std::string& symbol);
    
    // 활성 1분봉 조회
    Candle get_active_candle(const std::string& symbol);
    
    // 심볼 목록 조회 (candle:closed:1m:* 패턴)
    std::vector<std::string> get_closed_symbols();
    
    // 처리 완료 후 삭제 (전체)
    bool delete_closed_candles(const std::string& symbol);
    
    // 처리 완료 후 삭제 (부분 - 오래된 순)
    bool trim_closed_candles(const std::string& symbol, size_t count);

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

private:
    std::string host_;
    int port_;
    redisContext* ctx_;
};

} // namespace aggregator
