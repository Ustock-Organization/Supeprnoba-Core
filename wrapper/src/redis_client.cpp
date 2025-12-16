#include "redis_client.h"
#include "logger.h"
#include <chrono>

namespace aws_wrapper {

RedisClient::RedisClient(const std::string& host, int port)
    : host_(host), port_(port) {
    Logger::info("RedisClient created, host:", host, "port:", port);
}

RedisClient::~RedisClient() {
    if (context_) {
        redisFree(context_);
    }
}

bool RedisClient::connect() {
    if (context_) {
        redisFree(context_);
    }
    
    struct timeval timeout = {1, 500000};  // 1.5초
    context_ = redisConnectWithTimeout(host_.c_str(), port_, timeout);
    
    if (context_ == nullptr || context_->err) {
        if (context_) {
            Logger::error("Redis connection failed:", context_->errstr);
            redisFree(context_);
            context_ = nullptr;
        } else {
            Logger::error("Redis connection failed: can't allocate context");
        }
        return false;
    }
    
    Logger::info("Redis connected to:", host_, ":", port_);
    return true;
}

bool RedisClient::set(const std::string& key, const std::string& value) {
    if (!context_) return false;
    
    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "SET %s %s", key.c_str(), value.c_str()));
    
    if (!reply) {
        Logger::error("Redis SET failed:", context_->errstr);
        return false;
    }
    
    bool success = (reply->type != REDIS_REPLY_ERROR);
    freeReplyObject(reply);
    return success;
}

bool RedisClient::setEx(const std::string& key, const std::string& value, 
                         int ttl_seconds) {
    if (!context_) return false;
    
    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "SETEX %s %d %s", 
                     key.c_str(), ttl_seconds, value.c_str()));
    
    if (!reply) return false;
    
    bool success = (reply->type != REDIS_REPLY_ERROR);
    freeReplyObject(reply);
    return success;
}

std::optional<std::string> RedisClient::get(const std::string& key) {
    if (!context_) return std::nullopt;
    
    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "GET %s", key.c_str()));
    
    if (!reply) return std::nullopt;
    
    std::optional<std::string> result;
    if (reply->type == REDIS_REPLY_STRING) {
        result = std::string(reply->str, reply->len);
    }
    
    freeReplyObject(reply);
    return result;
}

bool RedisClient::del(const std::string& key) {
    if (!context_) return false;
    
    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "DEL %s", key.c_str()));
    
    if (!reply) return false;
    
    freeReplyObject(reply);
    return true;
}

bool RedisClient::exists(const std::string& key) {
    if (!context_) return false;
    
    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "EXISTS %s", key.c_str()));
    
    if (!reply) return false;
    
    bool result = (reply->type == REDIS_REPLY_INTEGER && reply->integer > 0);
    freeReplyObject(reply);
    return result;
}

bool RedisClient::saveSnapshot(const std::string& symbol, 
                                const std::string& data) {
    std::string key = "snapshot:" + symbol;
    std::string ts_key = "snapshot:" + symbol + ":timestamp";
    
    auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    
    if (!set(key, data)) return false;
    if (!set(ts_key, std::to_string(now))) return false;
    
    Logger::info("Snapshot saved to Redis:", symbol);
    return true;
}

std::optional<std::string> RedisClient::loadSnapshot(const std::string& symbol) {
    std::string key = "snapshot:" + symbol;
    return get(key);
}

std::vector<std::string> RedisClient::keys(const std::string& pattern) {
    std::vector<std::string> result;
    if (!context_) return result;
    
    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "KEYS %s", pattern.c_str()));
    
    if (!reply) return result;
    
    if (reply->type == REDIS_REPLY_ARRAY) {
        for (size_t i = 0; i < reply->elements; ++i) {
            if (reply->element[i]->type == REDIS_REPLY_STRING) {
                result.emplace_back(reply->element[i]->str, reply->element[i]->len);
            }
        }
    }
    
    freeReplyObject(reply);
    return result;
}

bool RedisClient::lpush(const std::string& key, const std::string& value) {
    if (!context_) return false;
    
    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "LPUSH %s %s", key.c_str(), value.c_str()));
    
    if (!reply) {
        Logger::error("Redis LPUSH failed:", context_->errstr);
        return false;
    }
    
    bool success = (reply->type != REDIS_REPLY_ERROR);
    freeReplyObject(reply);
    return success;
}

bool RedisClient::ltrim(const std::string& key, long start, long stop) {
    if (!context_) return false;
    
    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "LTRIM %s %ld %ld", key.c_str(), start, stop));
    
    if (!reply) {
        Logger::error("Redis LTRIM failed:", context_->errstr);
        return false;
    }
    
    bool success = (reply->type != REDIS_REPLY_ERROR);
    freeReplyObject(reply);
    return success;
}

std::vector<std::string> RedisClient::lrange(const std::string& key, long start, long stop) {
    std::vector<std::string> result;
    if (!context_) return result;
    
    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "LRANGE %s %ld %ld", key.c_str(), start, stop));
    
    if (!reply) return result;
    
    if (reply->type == REDIS_REPLY_ARRAY) {
        for (size_t i = 0; i < reply->elements; ++i) {
            if (reply->element[i]->type == REDIS_REPLY_STRING) {
                result.emplace_back(reply->element[i]->str, reply->element[i]->len);
            }
        }
    }
    
    freeReplyObject(reply);
    return result;
}

// === Hash 연산 (캔들용) ===

bool RedisClient::hset(const std::string& key, const std::string& field, const std::string& value) {
    if (!context_) return false;
    
    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "HSET %s %s %s", key.c_str(), field.c_str(), value.c_str()));
    
    if (!reply) return false;
    
    bool success = (reply->type != REDIS_REPLY_ERROR);
    freeReplyObject(reply);
    return success;
}

std::optional<std::string> RedisClient::hget(const std::string& key, const std::string& field) {
    if (!context_) return std::nullopt;
    
    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "HGET %s %s", key.c_str(), field.c_str()));
    
    if (!reply) return std::nullopt;
    
    std::optional<std::string> result;
    if (reply->type == REDIS_REPLY_STRING) {
        result = std::string(reply->str, reply->len);
    }
    
    freeReplyObject(reply);
    return result;
}

std::map<std::string, std::string> RedisClient::hgetall(const std::string& key) {
    std::map<std::string, std::string> result;
    if (!context_) return result;
    
    auto reply = static_cast<redisReply*>(
        redisCommand(context_, "HGETALL %s", key.c_str()));
    
    if (!reply) return result;
    
    if (reply->type == REDIS_REPLY_ARRAY && reply->elements % 2 == 0) {
        for (size_t i = 0; i < reply->elements; i += 2) {
            std::string field(reply->element[i]->str, reply->element[i]->len);
            std::string value(reply->element[i+1]->str, reply->element[i+1]->len);
            result[field] = value;
        }
    }
    
    freeReplyObject(reply);
    return result;
}

// === Lua Script EVAL ===

std::string RedisClient::eval(const std::string& script, int numKeys,
                               const std::vector<std::string>& keys,
                               const std::vector<std::string>& args) {
    if (!context_) return "";
    
    // 명령어 구성: EVAL script numkeys key1 key2 ... arg1 arg2 ...
    std::vector<const char*> argv;
    std::vector<size_t> argvlen;
    
    std::string cmd = "EVAL";
    argv.push_back(cmd.c_str());
    argvlen.push_back(cmd.size());
    
    argv.push_back(script.c_str());
    argvlen.push_back(script.size());
    
    std::string numKeysStr = std::to_string(numKeys);
    argv.push_back(numKeysStr.c_str());
    argvlen.push_back(numKeysStr.size());
    
    for (const auto& key : keys) {
        argv.push_back(key.c_str());
        argvlen.push_back(key.size());
    }
    
    for (const auto& arg : args) {
        argv.push_back(arg.c_str());
        argvlen.push_back(arg.size());
    }
    
    auto reply = static_cast<redisReply*>(
        redisCommandArgv(context_, static_cast<int>(argv.size()), argv.data(), argvlen.data()));
    
    if (!reply) {
        Logger::error("Redis EVAL failed:", context_->errstr);
        return "";
    }
    
    std::string result;
    if (reply->type == REDIS_REPLY_STRING) {
        result = std::string(reply->str, reply->len);
    } else if (reply->type == REDIS_REPLY_INTEGER) {
        result = std::to_string(reply->integer);
    } else if (reply->type == REDIS_REPLY_ERROR) {
        Logger::error("Redis EVAL error:", reply->str);
    }
    
    freeReplyObject(reply);
    return result;
}

// === Unix epoch → YYYYMMDDHHmm 형식 변환 (KST 기준) ===
std::string epochToYMDHM(int64_t epoch) {
    time_t time = static_cast<time_t>(epoch);
    struct tm* tm_info = localtime(&time);  // 로컬 시간대 (KST)
    
    char buffer[13];  // YYYYMMDDHHmm + null
    snprintf(buffer, sizeof(buffer), "%04d%02d%02d%02d%02d",
        tm_info->tm_year + 1900,
        tm_info->tm_mon + 1,
        tm_info->tm_mday,
        tm_info->tm_hour,
        tm_info->tm_min);
    
    return std::string(buffer);
}

// === 캔들 집계 (Lua Script) ===

bool RedisClient::updateCandle(const std::string& symbol, uint64_t price, uint64_t qty, int64_t timestamp) {
    if (!context_) return false;
    
    // Lua Script: 원자적 캔들 업데이트 (YYYYMMDDHHmm 형식 사용)
    static const std::string luaScript = R"(
        local key = KEYS[1]
        local closedKey = KEYS[2]
        local price = tonumber(ARGV[1])
        local qty = tonumber(ARGV[2])
        local ts = ARGV[3]      -- Unix epoch (참조용)
        local minute = ARGV[4]  -- YYYYMMDDHHmm 형식 (C++에서 변환됨)
        
        local current_t = redis.call("HGET", key, "t")
        
        -- 현재 분과 이전 캔들의 분이 다르면 이전 캔들을 닫고 새 캔들을 시작
        -- 문자열 비교: "202512161403" < "202512161404"
        if current_t and current_t < minute then
            -- 이전 캔들 데이터 가져오기 (HGETALL은 flat array 반환)
            local oldArr = redis.call("HGETALL", key)
            if #oldArr > 0 then
                -- flat array를 객체로 변환: {"o", "145", "h", "147"} -> {o=145, h=147}
                local oldObj = {}
                for i = 1, #oldArr, 2 do
                    oldObj[oldArr[i]] = oldArr[i + 1]
                end
                local json = cjson.encode(oldObj)
                redis.call("LPUSH", closedKey, json)
                redis.call("LTRIM", closedKey, 0, 999)  -- 닫힌 캔들은 최대 1000개 유지
            end
            -- 이전 캔들을 덮어쓰기 (DEL 없이 바로 HMSET으로 새 캔들 생성)
            redis.call("HMSET", key, "o", price, "h", price, "l", price, "c", price, "v", qty, "t", minute)
        elseif not current_t then
            -- 새 캔들 생성 (처음 또는 만료 후)
            redis.call("HMSET", key, "o", price, "h", price, "l", price, "c", price, "v", qty, "t", minute)
        else
            -- 기존 캔들 데이터 갱신 (같은 분 내)
            local h = tonumber(redis.call("HGET", key, "h")) -- 현재 고가
            local l = tonumber(redis.call("HGET", key, "l")) -- 현재 저가
            if price > h then redis.call("HSET", key, "h", price) end -- 고가 갱신
            if price < l then redis.call("HSET", key, "l", price) end -- 저가 갱신
            redis.call("HSET", key, "c", price) -- 종가 갱신
            redis.call("HINCRBY", key, "v", qty) -- 거래량 증가 (정수 사용)
        end
        
        -- 현재 캔들과 닫힌 캔들 버퍼에 만료 시간 설정
        redis.call("EXPIRE", key, 300) -- 현재 캔들은 5분 후 만료
        redis.call("EXPIRE", closedKey, 3600) -- 닫힌 캔들 버퍼는 1시간 후 만료
        
        return "OK"
    )";
    
    std::string key = "candle:1m:" + symbol;
    std::string closedKey = "candle:closed:1m:" + symbol;
    
    // YYYYMMDDHHmm 형식으로 변환
    std::string minuteStr = epochToYMDHM(timestamp);
    
    std::vector<std::string> keys = {key, closedKey};
    std::vector<std::string> args = {
        std::to_string(price),
        std::to_string(qty),
        std::to_string(timestamp),  // epoch (참조용)
        minuteStr                   // YYYYMMDDHHmm (실제 사용)
    };
    
    std::string result = eval(luaScript, 2, keys, args);
    
    if (result == "OK") {
        Logger::debug("Candle updated:", symbol, "price:", price, "qty:", qty);
        return true;
    } else {
        Logger::warn("Candle update failed:", symbol);
        return false;
    }
}

} // namespace aws_wrapper
