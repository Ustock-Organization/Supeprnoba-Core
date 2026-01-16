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
    
    // 숫자와 문자열 모두 처리하는 헬퍼 함수
    auto get_double = [](const json& j, const std::string& key) -> double {
        if (!j.contains(key)) return 0.0;
        if (j[key].is_number()) return j[key].get<double>();
        if (j[key].is_string()) return std::stod(j[key].get<std::string>());
        return 0.0;
    };
    auto get_string = [](const json& j, const std::string& key) -> std::string {
        if (!j.contains(key)) return "";
        if (j[key].is_string()) return j[key].get<std::string>();
        if (j[key].is_number()) return std::to_string(static_cast<long long>(j[key].get<double>()));
        return "";
    };

    if (reply->type == REDIS_REPLY_ARRAY) {
        for (size_t i = 0; i < reply->elements; i++) {
            try {
                json j = json::parse(reply->element[i]->str);
                Candle c;
                c.symbol = symbol;
                c.time = get_string(j, "t");
                c.open = get_double(j, "o");
                c.high = get_double(j, "h");
                c.low = get_double(j, "l");
                c.close = get_double(j, "c");
                c.volume = get_double(j, "v");
                
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

bool ValkeyClient::trim_closed_candles(const std::string& symbol, size_t count) {
    if (!ctx_ || count == 0) return false;
    
    std::string key = "candle:closed:1m:" + symbol;
    // LTRIM key 0 -(count + 1) : 오래된 count개 삭제 (뒤에서부터 자름)
    // Newest(0) ... Oldest(N-1) 구조에서 Oldest 쪽 삭제
    std::string count_str = std::to_string(count + 1);
    redisReply* reply = (redisReply*)redisCommand(ctx_, "LTRIM %s 0 -%s", key.c_str(), count_str.c_str());
    
    if (!reply) return false;
    
    bool ok = (reply->type == REDIS_REPLY_STATUS && std::string(reply->str) == "OK");
    freeReplyObject(reply);
    return ok;
}

// === 진행중 캔들 관리 (증분 업데이트용) ===

Candle ValkeyClient::get_candle(const std::string& key) {
    Candle c;
    if (!ctx_) return c;

    redisReply* reply = (redisReply*)redisCommand(ctx_, "HGETALL %s", key.c_str());
    if (!reply) return c;

    if (reply->type == REDIS_REPLY_ARRAY && reply->elements >= 2 && reply->elements % 2 == 0) {
        for (size_t i = 0; i < reply->elements; i += 2) {
            if (i + 1 >= reply->elements) break;

            std::string field = reply->element[i]->str;
            std::string value = reply->element[i+1]->str;

            if (field == "s") c.symbol = value;
            else if (field == "t") c.time = value;
            else if (field == "o") c.open = std::stod(value);
            else if (field == "h") c.high = std::stod(value);
            else if (field == "l") c.low = std::stod(value);
            else if (field == "c") c.close = std::stod(value);
            else if (field == "v") c.volume = std::stod(value);
        }
    }
    freeReplyObject(reply);
    return c;
}

bool ValkeyClient::set_candle(const std::string& key, const Candle& candle, int ttl_seconds) {
    if (!ctx_) return false;

    // HMSET으로 캔들 데이터 저장
    redisReply* reply = (redisReply*)redisCommand(ctx_,
        "HMSET %s s %s t %s o %.8f h %.8f l %.8f c %.8f v %.8f",
        key.c_str(),
        candle.symbol.c_str(),
        candle.time.c_str(),
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume);

    if (!reply) return false;
    bool ok = (reply->type == REDIS_REPLY_STATUS && std::string(reply->str) == "OK");
    freeReplyObject(reply);

    if (!ok) return false;

    // TTL 설정
    return set_expire(key, ttl_seconds);
}

std::vector<Candle> ValkeyClient::pop_closed_candles(const std::string& symbol, size_t max_count) {
    std::vector<Candle> candles;
    if (!ctx_) return candles;

    std::string key = "candle:closed:1m:" + symbol;

    // 숫자와 문자열 모두 처리하는 헬퍼 함수
    auto get_double = [](const json& j, const std::string& key) -> double {
        if (!j.contains(key)) return 0.0;
        if (j[key].is_number()) return j[key].get<double>();
        if (j[key].is_string()) return std::stod(j[key].get<std::string>());
        return 0.0;
    };
    auto get_string = [](const json& j, const std::string& key) -> std::string {
        if (!j.contains(key)) return "";
        if (j[key].is_string()) return j[key].get<std::string>();
        if (j[key].is_number()) return std::to_string(static_cast<long long>(j[key].get<double>()));
        return "";
    };

    // RPOP으로 오래된 순서로 가져오기 (리스트 끝에서 pop)
    for (size_t i = 0; i < max_count; i++) {
        redisReply* reply = (redisReply*)redisCommand(ctx_, "RPOP %s", key.c_str());
        if (!reply) break;

        if (reply->type == REDIS_REPLY_NIL) {
            freeReplyObject(reply);
            break;  // 리스트 비어있음
        }

        if (reply->type == REDIS_REPLY_STRING) {
            try {
                json j = json::parse(reply->str);
                Candle c;
                c.symbol = symbol;
                c.time = get_string(j, "t");
                c.open = get_double(j, "o");
                c.high = get_double(j, "h");
                c.low = get_double(j, "l");
                c.close = get_double(j, "c");
                c.volume = get_double(j, "v");

                if (!c.time.empty()) {
                    candles.push_back(c);
                }
            } catch (const std::exception& e) {
                Logger::warn("Failed to parse candle JSON:", e.what());
            }
        }
        freeReplyObject(reply);
    }

    return candles;
}

size_t ValkeyClient::get_list_length(const std::string& key) {
    if (!ctx_) return 0;

    redisReply* reply = (redisReply*)redisCommand(ctx_, "LLEN %s", key.c_str());
    if (!reply) return 0;

    size_t len = 0;
    if (reply->type == REDIS_REPLY_INTEGER) {
        len = static_cast<size_t>(reply->integer);
    }
    freeReplyObject(reply);
    return len;
}

bool ValkeyClient::set_expire(const std::string& key, int ttl_seconds) {
    if (!ctx_ || ttl_seconds <= 0) return false;

    redisReply* reply = (redisReply*)redisCommand(ctx_, "EXPIRE %s %d", key.c_str(), ttl_seconds);
    if (!reply) return false;

    bool ok = (reply->type == REDIS_REPLY_INTEGER && reply->integer == 1);
    freeReplyObject(reply);
    return ok;
}

} // namespace aggregator
