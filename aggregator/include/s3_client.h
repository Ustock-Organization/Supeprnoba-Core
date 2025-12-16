#pragma once

#include "valkey_client.h"
#include <string>
#include <vector>
#include <memory>

namespace Aws { namespace S3 { class S3Client; } }

namespace aggregator {

class S3Client {
public:
    S3Client(const std::string& bucket, const std::string& region);
    ~S3Client();
    
    bool connect();
    
    // S3에 캔들 JSON 저장
    // 경로: candles/timeframe={interval}/symbol={symbol}/year={YYYY}/month={MM}/day={DD}/{HHmm}.json
    bool put_candles(const std::string& symbol, const std::string& interval,
                    const std::vector<Candle>& candles);

private:
    std::string bucket_;
    std::string region_;
    std::unique_ptr<Aws::S3::S3Client> client_;
    bool connected_;
    
    std::string build_s3_key(const std::string& symbol, const std::string& interval,
                            const std::string& ymdhm);
};

} // namespace aggregator
