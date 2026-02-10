#include "local_consumer.h"
#include "logger.h"
#include <hiredis/hiredis.h>
#include <cstring>

namespace aws_wrapper {

LocalConsumer::LocalConsumer(const std::string& redis_host, int redis_port, const std::string& channel)
    : redis_host_(redis_host), redis_port_(redis_port), channel_(channel) {}

LocalConsumer::~LocalConsumer() {
    stop();
}

bool LocalConsumer::start(MessageCallback callback) {
    if (running_.load()) {
        Logger::warn("LocalConsumer already running");
        return false;
    }

    callback_ = callback;
    running_.store(true);

    subscribe_thread_ = std::thread(&LocalConsumer::subscribeLoop, this);
    Logger::info("LocalConsumer started on channel:", channel_);
    return true;
}

void LocalConsumer::stop() {
    if (!running_.load()) return;

    running_.store(false);

    // Redis 연결 끊기 (블로킹 해제)
    if (redis_ctx_) {
        redisContext* ctx = static_cast<redisContext*>(redis_ctx_);
        redisFree(ctx);
        redis_ctx_ = nullptr;
    }

    if (subscribe_thread_.joinable()) {
        subscribe_thread_.join();
    }

    Logger::info("LocalConsumer stopped");
}

void LocalConsumer::subscribeLoop() {
    while (running_.load()) {
        // Redis 연결
        redisContext* ctx = redisConnect(redis_host_.c_str(), redis_port_);
        if (ctx == nullptr || ctx->err) {
            if (ctx) {
                Logger::error("Redis connect error:", ctx->errstr);
                redisFree(ctx);
            } else {
                Logger::error("Redis connect error: can't allocate context");
            }
            std::this_thread::sleep_for(std::chrono::seconds(1));
            continue;
        }

        redis_ctx_ = ctx;
        Logger::info("LocalConsumer connected to Redis");

        // SUBSCRIBE
        redisReply* reply = static_cast<redisReply*>(
            redisCommand(ctx, "SUBSCRIBE %s", channel_.c_str())
        );
        if (reply) freeReplyObject(reply);

        // 메시지 수신 루프
        while (running_.load()) {
            redisReply* msg = nullptr;
            int status = redisGetReply(ctx, reinterpret_cast<void**>(&msg));

            if (status != REDIS_OK || msg == nullptr) {
                Logger::error("Redis subscribe error");
                break;
            }

            // SUBSCRIBE 응답: [type, channel, message]
            if (msg->type == REDIS_REPLY_ARRAY && msg->elements >= 3) {
                if (strcmp(msg->element[0]->str, "message") == 0) {
                    std::string message(msg->element[2]->str, msg->element[2]->len);
                    if (callback_) {
                        callback_(message);
                    }
                }
            }

            freeReplyObject(msg);
        }

        if (redis_ctx_) {
            redisFree(ctx);
            redis_ctx_ = nullptr;
        }

        if (running_.load()) {
            Logger::warn("Redis connection lost, reconnecting...");
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
    }
}

} // namespace aws_wrapper
