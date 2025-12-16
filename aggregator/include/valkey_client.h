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
    
    // 처리 완료 후 삭제
    bool delete_closed_candles(const std::string& symbol);
    
private:
    std::string host_;
    int port_;
    redisContext* ctx_;
};

} // namespace aggregator
