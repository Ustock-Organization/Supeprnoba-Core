#include "valkey_client.h"
#include "logger.h"
#include <hiredis/hiredis.h>
#include <nlohmann/json.hpp>
#include <ctime>
#include <sstream>
#include <iomanip>

using json = nlohmann::json;

namespace aggregator {

// 타임존 독립적 YYYYMMDDHHmm (KST) → UTC epoch 변환
// mktime()은 시스템 타임존에 의존하므로 수동 계산
int64_t Candle::ymdhm_to_utc_epoch(const std::string& ymdhm_kst) {
    if (ymdhm_kst.empty() || ymdhm_kst.length() < 12) return 0;

    try {
        int year = std::stoi(ymdhm_kst.substr(0, 4));
        int month = std::stoi(ymdhm_kst.substr(4, 2));
        int day = std::stoi(ymdhm_kst.substr(6, 2));
        int hour = std::stoi(ymdhm_kst.substr(8, 2));
        int min = std::stoi(ymdhm_kst.substr(10, 2));

        // 1970년부터 일수 계산 (타임존 독립)
        int64_t days = 0;
        for (int y = 1970; y < year; ++y) {
            bool leap = (y % 4 == 0 && (y % 100 != 0 || y % 400 == 0));
            days += leap ? 366 : 365;
        }

        // 해당 년도의 월까지 일수
        static const int days_in_month[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
        bool leap = (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0));
        for (int m = 1; m < month; ++m) {
            days += days_in_month[m - 1];
            if (m == 2 && leap) days += 1;
        }

        // 해당 월의 일수
        days += day - 1;

        // 초로 변환 (KST 기준)
        int64_t kst_epoch = days * 86400 + hour * 3600 + min * 60;

        // KST → UTC 변환 (9시간 차감)
        const int64_t KST_OFFSET = 9 * 3600;
        return kst_epoch - KST_OFFSET;
    } catch (const std::exception& e) {
        Logger::warn("ymdhm_to_utc_epoch parse error:", e.what(), "input:", ymdhm_kst);
        return 0;
    }
}

// epoch 반환 (cached_epoch 우선, 없으면 수동 계산)
int64_t Candle::epoch() const {
    // Engine에서 전달된 t_epoch 우선 사용
    if (cached_epoch > 0) {
        return cached_epoch;
    }

    // 폴백: 타임존 독립 수동 계산
    return ymdhm_to_utc_epoch(time);
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

                // t_epoch 필드 파싱 (Engine에서 전달된 UTC epoch)
                if (j.contains("t_epoch")) {
                    if (j["t_epoch"].is_number()) {
                        c.cached_epoch = j["t_epoch"].get<int64_t>();
                    } else if (j["t_epoch"].is_string()) {
                        c.cached_epoch = std::stoll(j["t_epoch"].get<std::string>());
                    }
                }

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
            else if (field == "t_epoch") c.cached_epoch = std::stoll(value);
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

                // t_epoch 필드 파싱 (Engine에서 전달된 UTC epoch)
                if (j.contains("t_epoch")) {
                    if (j["t_epoch"].is_number()) {
                        c.cached_epoch = j["t_epoch"].get<int64_t>();
                    } else if (j["t_epoch"].is_string()) {
                        c.cached_epoch = std::stoll(j["t_epoch"].get<std::string>());
                    }
                }

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

// === 전일종가 및 랭킹 관리 ===

bool ValkeyClient::set_prev_close(const std::string& symbol, double close_price) {
    if (!ctx_) return false;

    // prev:{symbol} 키에 JSON 형태로 저장
    json prev;
    prev["close"] = static_cast<uint64_t>(close_price);

    std::string key = "prev:" + symbol;
    std::string value = prev.dump();

    redisReply* reply = (redisReply*)redisCommand(ctx_, "SET %s %s", key.c_str(), value.c_str());
    if (!reply) return false;

    bool ok = (reply->type == REDIS_REPLY_STATUS && std::string(reply->str) == "OK");
    freeReplyObject(reply);

    if (ok) {
        Logger::info("[PREV-CLOSE] Set prev:", symbol, "=", close_price);
    }
    return ok;
}

double ValkeyClient::get_prev_close(const std::string& symbol) {
    if (!ctx_) return 0.0;

    std::string key = "prev:" + symbol;
    redisReply* reply = (redisReply*)redisCommand(ctx_, "GET %s", key.c_str());
    if (!reply) return 0.0;

    double close_price = 0.0;
    if (reply->type == REDIS_REPLY_STRING && reply->str) {
        try {
            json j = json::parse(reply->str);
            if (j.contains("close")) {
                if (j["close"].is_number()) {
                    close_price = j["close"].get<double>();
                } else if (j["close"].is_string()) {
                    close_price = std::stod(j["close"].get<std::string>());
                }
            }
        } catch (const std::exception& e) {
            Logger::warn("Failed to parse prev close for", symbol, ":", e.what());
        }
    }
    freeReplyObject(reply);
    return close_price;
}

bool ValkeyClient::update_ranking(const std::string& symbol, double change_pct) {
    if (!ctx_) return false;

    // 급등/급락 점수 = 등락률 × 1,000,000 (정밀도 유지)
    int64_t change_score = static_cast<int64_t>(change_pct * 1000000.0);

    // gainers: 등락률 내림차순 (높은 순)
    redisReply* reply1 = (redisReply*)redisCommand(ctx_,
        "ZADD ranking:gainers %lld %s", change_score, symbol.c_str());
    if (reply1) freeReplyObject(reply1);

    // losers: 등락률 오름차순 (낮은 순, 음수 점수로 저장)
    redisReply* reply2 = (redisReply*)redisCommand(ctx_,
        "ZADD ranking:losers %lld %s", -change_score, symbol.c_str());
    if (reply2) freeReplyObject(reply2);

    // 급등/급락은 상위 100개만 유지
    const int MAX_GAINERS_LOSERS = 100;
    redisReply* reply3 = (redisReply*)redisCommand(ctx_,
        "ZREMRANGEBYRANK ranking:gainers 0 %d", -MAX_GAINERS_LOSERS - 1);
    if (reply3) freeReplyObject(reply3);

    redisReply* reply4 = (redisReply*)redisCommand(ctx_,
        "ZREMRANGEBYRANK ranking:losers 0 %d", -MAX_GAINERS_LOSERS - 1);
    if (reply4) freeReplyObject(reply4);

    Logger::debug("[RANKING] Updated ranking for", symbol, "change:", change_pct, "%");
    return true;
}

double ValkeyClient::get_ticker_price(const std::string& symbol) {
    if (!ctx_) return 0.0;

    std::string key = "ticker:" + symbol;
    redisReply* reply = (redisReply*)redisCommand(ctx_, "GET %s", key.c_str());
    if (!reply) return 0.0;

    double price = 0.0;
    if (reply->type == REDIS_REPLY_STRING && reply->str) {
        try {
            json j = json::parse(reply->str);
            if (j.contains("p")) {
                if (j["p"].is_number()) {
                    price = j["p"].get<double>();
                } else if (j["p"].is_string()) {
                    price = std::stod(j["p"].get<std::string>());
                }
            }
        } catch (const std::exception& e) {
            Logger::warn("Failed to parse ticker price for", symbol, ":", e.what());
        }
    }
    freeReplyObject(reply);
    return price;
}

int ValkeyClient::close_stale_candles(const std::string& current_minute_kst) {
    if (!ctx_) return 0;

    static const std::string lua_script = R"(
        local current_minute = ARGV[1]
        local keys = redis.call("KEYS", "candle:1m:*")
        local closed = 0
        for _, key in ipairs(keys) do
            local t = redis.call("HGET", key, "t")
            if t and t < current_minute then
                local arr = redis.call("HGETALL", key)
                if #arr > 0 then
                    local obj = {}
                    for i = 1, #arr, 2 do
                        obj[arr[i]] = arr[i + 1]
                    end
                    local symbol = string.sub(key, 11)
                    local closedKey = "candle:closed:1m:" .. symbol
                    redis.call("LPUSH", closedKey, cjson.encode(obj))
                    redis.call("LTRIM", closedKey, 0, 999)
                    redis.call("DEL", key)
                    redis.call("EXPIRE", closedKey, 21600)
                    closed = closed + 1
                end
            end
        end
        return closed
    )";

    redisReply* reply = (redisReply*)redisCommand(ctx_,
        "EVAL %s 0 %s", lua_script.c_str(), current_minute_kst.c_str());

    if (!reply) return 0;

    int closed = 0;
    if (reply->type == REDIS_REPLY_INTEGER) {
        closed = static_cast<int>(reply->integer);
    }
    freeReplyObject(reply);
    return closed;
}

} // namespace aggregator
