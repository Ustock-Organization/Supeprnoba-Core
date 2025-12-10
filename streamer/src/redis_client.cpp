#include "redis_client.h"
#include <hiredis/hiredis.h>
#include <hiredis/hiredis_ssl.h>
#include <iostream>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

struct RedisClient::Impl {
    redisContext* ctx = nullptr;
    std::string host;
    int port;
    bool use_tls;
    
    Impl(const std::string& h, int p, bool tls) 
        : host(h), port(p), use_tls(tls) {}
    
    ~Impl() {
        if (ctx) {
            redisFree(ctx);
        }
    }
};

RedisClient::RedisClient(const std::string& host, int port, bool use_tls)
    : impl_(std::make_unique<Impl>(host, port, use_tls)) {}

RedisClient::~RedisClient() = default;

bool RedisClient::connect() {
    if (impl_->use_tls) {
        redisInitOpenSSL();
        redisSSLContext* ssl_ctx = redisCreateSSLContext(nullptr, nullptr, nullptr, nullptr, nullptr, nullptr);
        if (!ssl_ctx) {
            std::cerr << "Failed to create SSL context" << std::endl;
            return false;
        }
        
        impl_->ctx = redisConnect(impl_->host.c_str(), impl_->port);
        if (impl_->ctx && !impl_->ctx->err) {
            if (redisInitiateSSLWithContext(impl_->ctx, ssl_ctx) != REDIS_OK) {
                std::cerr << "Failed to initiate SSL" << std::endl;
                return false;
            }
        }
        redisFreeSSLContext(ssl_ctx);
    } else {
        impl_->ctx = redisConnect(impl_->host.c_str(), impl_->port);
    }
    
    if (!impl_->ctx || impl_->ctx->err) {
        std::cerr << "Redis connection error: " 
                  << (impl_->ctx ? impl_->ctx->errstr : "can't allocate context") << std::endl;
        return false;
    }
    
    return true;
}

void RedisClient::disconnect() {
    if (impl_->ctx) {
        redisFree(impl_->ctx);
        impl_->ctx = nullptr;
    }
}

bool RedisClient::isConnected() const {
    return impl_->ctx && !impl_->ctx->err;
}

std::optional<DepthData> RedisClient::getDepth(const std::string& symbol) {
    if (!impl_->ctx) return std::nullopt;
    
    std::string key = "depth:" + symbol;
    redisReply* reply = static_cast<redisReply*>(
        redisCommand(impl_->ctx, "GET %s", key.c_str())
    );
    
    if (!reply) return std::nullopt;
    
    if (reply->type == REDIS_REPLY_NIL) {
        freeReplyObject(reply);
        return std::nullopt;
    }
    
    if (reply->type != REDIS_REPLY_STRING) {
        freeReplyObject(reply);
        return std::nullopt;
    }
    
    try {
        json data = json::parse(reply->str, reply->str + reply->len);
        freeReplyObject(reply);
        
        DepthData depth;
        depth.symbol = data.value("symbol", symbol);
        depth.timestamp = data.value("timestamp", 0);
        
        for (const auto& bid : data["bids"]) {
            depth.bids.push_back({
                bid["price"].get<double>(),
                bid["quantity"].get<double>()
            });
        }
        
        for (const auto& ask : data["asks"]) {
            depth.asks.push_back({
                ask["price"].get<double>(),
                ask["quantity"].get<double>()
            });
        }
        
        return depth;
        
    } catch (const std::exception& e) {
        std::cerr << "Failed to parse depth data: " << e.what() << std::endl;
        return std::nullopt;
    }
}

std::vector<std::string> RedisClient::getSubscribers(const std::string& symbol) {
    std::vector<std::string> result;
    if (!impl_->ctx) return result;
    
    std::string key = "symbol:" + symbol + ":subscribers";
    redisReply* reply = static_cast<redisReply*>(
        redisCommand(impl_->ctx, "SMEMBERS %s", key.c_str())
    );
    
    if (!reply || reply->type != REDIS_REPLY_ARRAY) {
        if (reply) freeReplyObject(reply);
        return result;
    }
    
    for (size_t i = 0; i < reply->elements; ++i) {
        if (reply->element[i]->type == REDIS_REPLY_STRING) {
            result.emplace_back(reply->element[i]->str, reply->element[i]->len);
        }
    }
    
    freeReplyObject(reply);
    return result;
}
