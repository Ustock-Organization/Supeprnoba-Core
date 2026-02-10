#include "local_producer.h"
#include "logger.h"
#include <hiredis/hiredis.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace aws_wrapper {

LocalProducer::LocalProducer(const std::string& redis_host, int redis_port)
    : redis_host_(redis_host), redis_port_(redis_port) {}

LocalProducer::~LocalProducer() {
    if (redis_ctx_) {
        redisContext* ctx = static_cast<redisContext*>(redis_ctx_);
        redisFree(ctx);
        redis_ctx_ = nullptr;
    }
}

bool LocalProducer::connect() {
    if (connected_) return true;

    redisContext* ctx = redisConnect(redis_host_.c_str(), redis_port_);
    if (ctx == nullptr || ctx->err) {
        if (ctx) {
            Logger::error("LocalProducer connect error:", ctx->errstr);
            redisFree(ctx);
        } else {
            Logger::error("LocalProducer connect error: can't allocate context");
        }
        return false;
    }

    redis_ctx_ = ctx;
    connected_ = true;
    Logger::info("LocalProducer connected to Redis");
    return true;
}

bool LocalProducer::publish(const std::string& channel, const std::string& data) {
    if (!connected_ || !redis_ctx_) {
        Logger::error("LocalProducer not connected");
        return false;
    }

    redisContext* ctx = static_cast<redisContext*>(redis_ctx_);
    redisReply* reply = static_cast<redisReply*>(
        redisCommand(ctx, "PUBLISH %s %b", channel.c_str(), data.c_str(), data.size())
    );

    if (reply == nullptr) {
        Logger::error("Redis PUBLISH failed:", ctx->errstr);
        connected_ = false;
        return false;
    }

    freeReplyObject(reply);
    return true;
}

bool LocalProducer::setWithExpiry(const std::string& key, const std::string& data, int ttl_seconds) {
    if (!connected_ || !redis_ctx_) return false;

    redisContext* ctx = static_cast<redisContext*>(redis_ctx_);
    redisReply* reply = static_cast<redisReply*>(
        redisCommand(ctx, "SETEX %s %d %b", key.c_str(), ttl_seconds, data.c_str(), data.size())
    );
    
    if (reply) {
        freeReplyObject(reply);
        return true;
    }
    return false;
}

void LocalProducer::publishFill(const std::string& symbol,
                                 const std::string& order_id,
                                 const std::string& matched_order_id,
                                 const std::string& buyer_id,
                                 const std::string& seller_id,
                                 uint64_t qty,
                                 uint64_t price,
                                 bool buyer_fully_filled,
                                 bool seller_fully_filled,
                                 bool buyer_is_maker) {
    json fill = {
        {"e", "fill"},
        {"s", symbol},
        {"order_id", order_id},
        {"matched_order_id", matched_order_id},
        {"buyer_id", buyer_id},
        {"seller_id", seller_id},
        {"q", qty},
        {"p", price},
        {"buyer_fully_filled", buyer_fully_filled},
        {"seller_fully_filled", seller_fully_filled},
        {"buyer_is_maker", buyer_is_maker},
        {"t", std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count()}
    };
    
    publish("supernoba:fills", fill.dump());
}

void LocalProducer::publishTrade(const std::string& symbol,
                                  uint64_t qty,
                                  uint64_t price) {
    json trade = {
        {"e", "trade"},
        {"s", symbol},
        {"q", qty},
        {"p", price},
        {"t", std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count()}
    };
    
    publish("supernoba:trades", trade.dump());
    
    // ticker 업데이트 (Redis SET)
    json ticker = {
        {"e", "t"},
        {"s", symbol},
        {"c", price},  // close/current price
        {"v", qty},
        {"t", std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count()}
    };
    setWithExpiry("ticker:" + symbol, ticker.dump(), 300);
}

void LocalProducer::publishDepth(const std::string& symbol,
                                  const nlohmann::json& depth) {
    json msg = depth;
    msg["e"] = "d";
    msg["s"] = symbol;
    msg["t"] = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    
    std::string data = msg.dump();
    
    // Redis SET + PUBLISH
    setWithExpiry("depth:" + symbol, data, 300);
    publish("supernoba:depth", data);
}

void LocalProducer::publishOrderStatus(const std::string& symbol,
                                        const std::string& order_id,
                                        const std::string& user_id,
                                        const std::string& status,
                                        const std::string& reason,
                                        uint64_t price,
                                        uint64_t quantity,
                                        bool is_buy,
                                        const std::string& order_type) {
    json msg = {
        {"e", "order_status"},
        {"s", symbol},
        {"order_id", order_id},
        {"user_id", user_id},
        {"status", status},
        {"side", is_buy ? "BUY" : "SELL"},
        {"t", std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count()}
    };
    
    if (!reason.empty()) msg["reason"] = reason;
    if (price > 0) msg["p"] = price;
    if (quantity > 0) msg["q"] = quantity;
    if (!order_type.empty()) msg["type"] = order_type;
    
    publish("supernoba:status", msg.dump());
}

void LocalProducer::flush(int timeout_ms) {
    // Redis는 동기식이므로 flush 불필요
}

} // namespace aws_wrapper
