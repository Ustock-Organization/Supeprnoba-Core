#include "s3_client.h"
#include "logger.h"

#include <aws/core/Aws.h>
#include <aws/s3/S3Client.h>
#include <aws/s3/model/PutObjectRequest.h>
#include <nlohmann/json.hpp>
#include <sstream>

using json = nlohmann::json;

namespace aggregator {

S3Client::S3Client(const std::string& bucket, const std::string& region)
    : bucket_(bucket), region_(region), connected_(false) {}

S3Client::~S3Client() = default;

bool S3Client::connect() {
    try {
        Aws::Client::ClientConfiguration config;
        config.region = region_;
        
        client_ = std::make_unique<Aws::S3::S3Client>(config);
        connected_ = true;
        return true;
    } catch (const std::exception& e) {
        Logger::error("S3 client init error:", e.what());
        return false;
    }
}

std::string S3Client::build_s3_key(const std::string& symbol, const std::string& interval,
                                   const std::string& ymdhm) {
    // candles/timeframe=1m/symbol=TEST/year=2025/month=12/day=16/1423.json
    std::string year = ymdhm.substr(0, 4);
    std::string month = ymdhm.substr(4, 2);
    std::string day = ymdhm.substr(6, 2);
    std::string hhmm = ymdhm.substr(8, 4);
    
    std::ostringstream oss;
    oss << "candles/timeframe=" << interval
        << "/symbol=" << symbol
        << "/year=" << year
        << "/month=" << month
        << "/day=" << day
        << "/" << hhmm << ".json";
    
    return oss.str();
}

bool S3Client::put_candles(const std::string& symbol, const std::string& interval,
                          const std::vector<Candle>& candles) {
    if (!connected_ || !client_ || candles.empty()) return false;
    
    try {
        // 첫 캔들의 시간으로 파일명 결정
        std::string key = build_s3_key(symbol, interval, candles[0].time);
        
        // JSON 생성
        json j;
        j["symbol"] = symbol;
        j["interval"] = interval;
        json candles_arr = json::array();
        
        for (const auto& c : candles) {
            json candle_obj;
            candle_obj["t"] = c.time;
            candle_obj["o"] = std::to_string(c.open);
            candle_obj["h"] = std::to_string(c.high);
            candle_obj["l"] = std::to_string(c.low);
            candle_obj["c"] = std::to_string(c.close);
            candle_obj["v"] = std::to_string(c.volume);
            candles_arr.push_back(candle_obj);
        }
        j["candles"] = candles_arr;
        
        std::string body = j.dump(2);
        
        // S3 업로드
        Aws::S3::Model::PutObjectRequest request;
        request.SetBucket(bucket_);
        request.SetKey(key);
        request.SetContentType("application/json");
        
        auto stream = Aws::MakeShared<std::stringstream>("S3Upload");
        *stream << body;
        request.SetBody(stream);
        
        auto outcome = client_->PutObject(request);
        
        if (!outcome.IsSuccess()) {
            Logger::error("S3 put failed:", key, "-", outcome.GetError().GetMessage());
            return false;
        }
        
        Logger::debug("S3 uploaded:", key, "(", body.size(), "bytes)");
        return true;
        
    } catch (const std::exception& e) {
        Logger::error("S3 put exception:", e.what());
        return false;
    }
}

} // namespace aggregator
