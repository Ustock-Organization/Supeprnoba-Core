/**
 * main_local.cpp - 로컬 개발용 매칭 엔진
 * 
 * AWS 의존성 제거:
 * - Kinesis → Redis Pub/Sub
 * - DynamoDB → Redis
 * - Secrets Manager → 환경변수
 */

#include "config.h"
#include "logger.h"
#include "engine_core.h"
#include "market_data_handler.h"
#include "grpc_service.h"
#include "redis_client.h"
#include "metrics.h"
#include "local_consumer.h"
#include "local_producer.h"

#include <iostream>
#include <csignal>
#include <set>
#include <nlohmann/json.hpp>

using namespace aws_wrapper;
using json = nlohmann::json;

std::atomic<bool> g_running{true};

void signalHandler(int sig) {
    Logger::info("Received signal", sig, "- shutting down...");
    g_running = false;
}

void printBanner() {
    std::cout << R"(
╔═══════════════════════════════════════════════════════════╗
║        Supernoba Matching Engine - LOCAL MODE             ║
║              Redis Pub/Sub Backend                        ║
╚═══════════════════════════════════════════════════════════╝
)" << std::endl;
}

int main(int argc, char* argv[]) {
    printBanner();
    
    Logger::info("=== LOCAL MODE: Redis Pub/Sub streaming ===");
    
    // 시그널 핸들러 설정
    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);
    
    // 로그 레벨 설정
    std::string log_level = Config::get(Config::LOG_LEVEL, "INFO");
    if (log_level == "DEBUG") Logger::setLevel(LogLevel::DEBUG);
    else if (log_level == "WARN") Logger::setLevel(LogLevel::WARN);
    else if (log_level == "ERROR") Logger::setLevel(LogLevel::ERROR);
    
    // 환경변수에서 설정 로드
    const auto redis_host = Config::get(Config::REDIS_HOST, "localhost");
    const auto redis_port = Config::getInt(Config::REDIS_PORT, 6379);
    const auto grpc_port = Config::getInt(Config::GRPC_PORT, 50051);
    const auto orders_channel = Config::get("ORDERS_CHANNEL", "supernoba:orders");

    Logger::info("=== Configuration ===");
    Logger::info("Mode: LOCAL (Redis Pub/Sub)");
    Logger::info("Redis Host:", redis_host, ":", redis_port);
    Logger::info("Orders Channel:", orders_channel);
    Logger::info("gRPC Port:", grpc_port);
    Logger::info("=====================");
    
    try {
        // Redis 연결 (스냅샷/depth 캐시)
        RedisClient redis(redis_host, redis_port);
        bool redis_connected = redis.connect();
        if (!redis_connected) {
            Logger::error("Redis connection failed!");
            return 1;
        }
        Logger::info("Redis connected");
        
        // Local Producer (이벤트 발행)
        LocalProducer producer(redis_host, redis_port);
        if (!producer.connect()) {
            Logger::error("LocalProducer connection failed!");
            return 1;
        }
        
        // 핸들러 및 엔진 생성
        MarketDataHandler handler(&producer, &redis);
        EngineCore engine(&handler);
        
        // === 시작 시 Redis에서 스냅샷 복원 ===
        Logger::info("Restoring snapshots from Redis...");
        auto snapshot_keys = redis.keys("snapshot:*");
        int restored = 0;
        for (const auto& key : snapshot_keys) {
            std::string symbol = key.substr(9);  // "snapshot:" 제거
            auto data = redis.get(key);
            if (data.has_value() && !data.value().empty()) {
                if (engine.restoreOrderBook(symbol, data.value())) {
                    Logger::info("Restored orderbook:", symbol);
                    restored++;
                }
            }
        }
        Logger::info("Restored", restored, "orderbooks from Redis");
        
        // === active:symbols에서 종목 로드 ===
        auto active_symbols = redis.smembers("active:symbols");
        for (const auto& symbol : active_symbols) {
            engine.getOrCreateBook(symbol);
            Logger::info("Created orderbook for active symbol:", symbol);
        }
        
        // === Redis Pub/Sub 주문 수신 ===
        LocalConsumer consumer(redis_host, redis_port, orders_channel);
        
        consumer.start([&engine, &redis](const std::string& message) {
            try {
                json order = json::parse(message);
                
                std::string action = order.value("action", "ADD");
                std::string symbol = order.value("symbol", "");
                
                if (symbol.empty()) {
                    Logger::warn("Order missing symbol");
                    return;
                }
                
                // 오더북 없으면 생성
                engine.getOrCreateBook(symbol);
                // redis.zadd로 대체 (score=0)
                // redis.zadd("active:symbols", 0, symbol);
                
                if (action == "ADD") {
                    auto orderPtr = Order::fromJson(order);
                    if (orderPtr) {
                        engine.addOrder(orderPtr);
                        Logger::debug("Added order:", orderPtr->order_id(), symbol, orderPtr->is_buy() ? "BUY" : "SELL", orderPtr->price(), "x", orderPtr->order_qty());
                    }
                    
                } else if (action == "CANCEL") {
                    std::string order_id = order.value("order_id", "");
                    engine.cancelOrder(symbol, order_id);
                    Logger::debug("Cancelled order:", order_id);
                }
                
            } catch (const std::exception& e) {
                Logger::error("Order processing error:", e.what());
            }
        });
        
        // === gRPC 서버 시작 (옵션) ===
        // GrpcService grpc_service(&engine, grpc_port);
        // grpc_service.start();
        
        Logger::info("=== Matching Engine Running ===");
        Logger::info("Listening for orders on:", orders_channel);
        
        // 메인 루프
        while (g_running.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            
            // 주기적 스냅샷 저장 (60초마다)
            static auto last_snapshot = std::chrono::steady_clock::now();
            auto now = std::chrono::steady_clock::now();
            if (std::chrono::duration_cast<std::chrono::seconds>(now - last_snapshot).count() >= 60) {
                for (const auto& symbol : engine.getAllSymbols()) {
                    auto snapshot = engine.snapshotOrderBook(symbol);
                    if (!snapshot.empty()) {
                        redis.set("snapshot:" + symbol, snapshot);
                    }
                }
                last_snapshot = now;
                Logger::debug("Snapshots saved");
            }
        }
        
        // 종료 전 스냅샷 저장
        Logger::info("Saving final snapshots...");
        for (const auto& symbol : engine.getAllSymbols()) {
            auto snapshot = engine.snapshotOrderBook(symbol);
            if (!snapshot.empty()) {
                redis.set("snapshot:" + symbol, snapshot);
            }
        }
        
        consumer.stop();
        Logger::info("Matching Engine stopped");
        
    } catch (const std::exception& e) {
        Logger::error("Fatal error:", e.what());
        return 1;
    }
    
    return 0;
}
