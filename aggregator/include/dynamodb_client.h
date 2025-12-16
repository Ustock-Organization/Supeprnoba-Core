#pragma once

#include "valkey_client.h"
#include <string>
#include <vector>
#include <memory>

namespace Aws { namespace DynamoDB { class DynamoDBClient; } }

namespace aggregator {

class DynamoDBClient {
public:
    DynamoDBClient(const std::string& table_name, const std::string& region);
    ~DynamoDBClient();
    
    bool connect();
    
    // 캔들 저장 (pk: CANDLE#SYMBOL#INTERVAL, sk: YYYYMMDDHHmm)
    bool put_candle(const std::string& symbol, const std::string& interval, 
                   const Candle& candle);
    
    // 배치 저장 (최대 25개씩)
    int batch_put_candles(const std::string& symbol, const std::string& interval,
                         const std::vector<Candle>& candles);

private:
    std::string table_name_;
    std::string region_;
    std::unique_ptr<Aws::DynamoDB::DynamoDBClient> client_;
    bool connected_;
};

} // namespace aggregator
