#include "valkey_client.h"
#include "logger.h"
#include <hiredis/hiredis.h>
#include <nlohmann/json.hpp>
#include <ctime>
#include <sstream>
#include <iomanip>

using json = nlohmann::json;

namespace aggregator {

// YYYYMMDDHHmm → epoch 초 변환 (KST 기준)
int64_t Candle::epoch() const {
    if (time.empty() || time.length() < 12) return 0;
    
    struct tm tm = {};
    tm.tm_year = std::stoi(time.substr(0, 4)) - 1900;
    tm.tm_mon = std::stoi(time.substr(4, 2)) - 1;
    tm.tm_mday = std::stoi(time.substr(6, 2));
    tm.tm_hour = std::stoi(time.substr(8, 2));
    tm.tm_min = std::stoi(time.substr(10, 2));
    tm.tm_sec = 0;
    tm.tm_isdst = -1;  // DST 정보 없음
    
    // mktime()은 시스템 로컬 타임존을 사용하므로,
    // 서버가 UTC라면 KST 시간을 UTC로 잘못 해석함
    // 따라서 9시간을 빼서 올바른 UTC epoch를 얻음
    // 예: KST "202512171700" → mktime()은 UTC 17:00로 해석 → 9시간 빼면 UTC 08:00 (정확)
    time_t local_epoch = mktime(&tm);
    
    // KST = UTC + 9시간이므로, KST 시간에서 9시간을 빼야 UTC epoch가 됨
    const int64_t KST_OFFSET = 9 * 3600;  // 9시간 (초)
    return static_cast<int64_t>(local_epoch) - KST_OFFSET;
}

ValkeyClient::ValkeyClient(const std::string& host, int port)
    : host_(host), port_(port), ctx_(nullptr) {}

ValkeyClient::~ValkeyClient() {
    if (ctx_) {
        redisFree(ctx_);
    }
}

bool ValkeyClient::connect() {
    struct timeval timeout = {5, 0};  // 5초 타임아웃
    ctx_ = redisConnectWithTimeout(host_.c_str(), port_, timeout);
    
    if (ctx_ == nullptr || ctx_->err) {
        if (ctx_) {
            Logger::error("Valkey connection error:", ctx_->errstr);
            redisFree(ctx_);
            ctx_ = nullptr;
        }
        return false;
    }
    return true;
}

bool ValkeyClient::ping() {
    if (!ctx_) return false;
    
    redisReply* reply = (redisReply*)redisCommand(ctx_, "PING");
    if (!reply) return false;
    
    bool ok = (reply->type == REDIS_REPLY_STATUS && 
               std::string(reply->str) == "PONG");
    freeReplyObject(reply);
    return ok;
}

std::vector<std::string> ValkeyClient::get_closed_symbols() {
    std::vector<std::string> symbols;
    if (!ctx_) return symbols;
    
    redisReply* reply = (redisReply*)redisCommand(ctx_, "KEYS candle:closed:1m:*");
    if (!reply) return symbols;
    
    if (reply->type == REDIS_REPLY_ARRAY) {
        for (size_t i = 0; i < reply->elements; i++) {
            std::string key = reply->element[i]->str;
            // "candle:closed:1m:TEST" → "TEST"
            std::string symbol = key.substr(17);  // "candle:closed:1m:" = 17자
            symbols.push_back(symbol);
        }
    }
    freeReplyObject(reply);
    return symbols;
}

std::vector<Candle> ValkeyClient::get_closed_candles(const std::string& symbol) {
    std::vector<Candle> candles;
    if (!ctx_) return candles;
    
    std::string key = "candle:closed:1m:" + symbol;
    redisReply* reply = (redisReply*)redisCommand(ctx_, "LRANGE %s 0 -1", key.c_str());
    if (!reply) return candles;
    
    if (reply->type == REDIS_REPLY_ARRAY) {
        for (size_t i = 0; i < reply->elements; i++) {
            try {
                json j = json::parse(reply->element[i]->str);
                Candle c;
                c.symbol = symbol;
                c.time = j.value("t", "");
                c.open = std::stod(j.value("o", "0"));
                c.high = std::stod(j.value("h", "0"));
                c.low = std::stod(j.value("l", "0"));
                c.close = std::stod(j.value("c", "0"));
                c.volume = std::stod(j.value("v", "0"));
                
                // t_epoch 필드가 있으면 사용 (성능 최적화)
                // 없으면 epoch() 메서드로 변환 (하위 호환성)
                // 현재는 epoch() 메서드 사용하므로 t_epoch는 무시해도 됨
                // 하지만 나중에 Candle 구조체에 epoch 필드 추가 시 활용 가능
                
                if (!c.time.empty()) {
                    candles.push_back(c);
                }
            } catch (const std::exception& e) {
                Logger::warn("Failed to parse candle JSON:", e.what());
            }
        }
    }
    freeReplyObject(reply);
    return candles;
}

Candle ValkeyClient::get_active_candle(const std::string& symbol) {
    Candle c;
    if (!ctx_) return c;
    
    std::string key = "candle:1m:" + symbol;
    redisReply* reply = (redisReply*)redisCommand(ctx_, "HGETALL %s", key.c_str());
    if (!reply) return c;
    
    if (reply->type == REDIS_REPLY_ARRAY && reply->elements >= 2 && reply->elements % 2 == 0) {
        c.symbol = symbol;
        for (size_t i = 0; i < reply->elements; i += 2) {
            // 배열 인덱스 범위 체크
            if (i + 1 >= reply->elements) break;
            
            std::string field = reply->element[i]->str;
            std::string value = reply->element[i+1]->str;
            
            if (field == "t") c.time = value;
            else if (field == "o") c.open = std::stod(value);
            else if (field == "h") c.high = std::stod(value);
            else if (field == "l") c.low = std::stod(value);
            else if (field == "c") c.close = std::stod(value);
            else if (field == "v") c.volume = std::stod(value);
            // t_epoch 필드는 현재 Candle 구조체에 없으므로 무시
            // 나중에 구조체에 epoch 필드 추가 시 활용 가능
        }
    }
    freeReplyObject(reply);
    return c;
}

bool ValkeyClient::delete_closed_candles(const std::string& symbol) {
    if (!ctx_) return false;
    
    std::string key = "candle:closed:1m:" + symbol;
    redisReply* reply = (redisReply*)redisCommand(ctx_, "DEL %s", key.c_str());
    if (!reply) return false;
    
    bool ok = (reply->type == REDIS_REPLY_INTEGER);
    freeReplyObject(reply);
    return ok;
}

} // namespace aggregator
