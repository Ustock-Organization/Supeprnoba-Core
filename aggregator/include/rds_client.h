#pragma once

#include "valkey_client.h"
#include <string>
#include <vector>
#include <memory>

// Forward declaration
struct pg_conn;
typedef struct pg_conn PGconn;

namespace aggregator {

class RdsClient {
public:
    RdsClient(const std::string& host, int port, const std::string& dbname,
              const std::string& user, const std::string& password);
    ~RdsClient();
    
    bool connect();
    void disconnect();
    
    // 캔들 저장
    bool put_candle(const std::string& symbol, const std::string& interval, 
                   const Candle& candle);
    
    // 배치 저장 (INSERT ... ON CONFLICT)
    int batch_put_candles(const std::string& symbol, const std::string& interval,
                         const std::vector<Candle>& candles);

    // 심볼 파티션 생성
    bool ensure_partition(const std::string& symbol);

    // [Phase 3] 캔들 조회 (계층적 집계용)
    // start_epoch 이상, end_epoch 미만 범위의 캔들 조회
    std::vector<Candle> get_candles_by_interval(
        const std::string& symbol,
        const std::string& interval,
        int64_t start_epoch,
        int64_t end_epoch);

private:
    std::string host_;
    int port_;
    std::string dbname_;
    std::string user_;
    std::string password_;
    PGconn* conn_;
    bool connected_;
};

} // namespace aggregator
