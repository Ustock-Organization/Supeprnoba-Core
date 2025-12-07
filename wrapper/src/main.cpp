#include "config.h"
#include "logger.h"
#include "engine_core.h"
#include "kafka_consumer.h"
#include "kafka_producer.h"
#include "market_data_handler.h"
#include "grpc_service.h"
#include "redis_client.h"
#include "metrics.h"
#include <iostream>
#include <csignal>
#include <nlohmann/json.hpp>

using namespace aws_wrapper;

std::atomic<bool> g_running{true};

void signalHandler(int sig) {
    Logger::info("Received signal", sig, "- shutting down...");
    g_running = false;
}

void printBanner() {
    std::cout << R"(
╔═══════════════════════════════════════════════════════════╗
║           Liquibook AWS Matching Engine                   ║
║                    C++ Native Wrapper                     ║
╚═══════════════════════════════════════════════════════════╝
)" << std::endl;
}

int main(int argc, char* argv[]) {
    printBanner();
    
    // 시그널 핸들러 설정
    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);
    
    // 로그 레벨 설정
    std::string log_level = Config::get(Config::LOG_LEVEL, "INFO");
    if (log_level == "DEBUG") Logger::setLevel(LogLevel::DEBUG);
    else if (log_level == "WARN") Logger::setLevel(LogLevel::WARN);
    else if (log_level == "ERROR") Logger::setLevel(LogLevel::ERROR);
    
    // 환경변수에서 설정 로드
    const auto kafka_brokers = Config::get(Config::KAFKA_BROKERS, "localhost:9092");
    const auto kafka_topic = Config::get(Config::KAFKA_ORDER_TOPIC, "orders");
    const auto kafka_group = Config::get(Config::KAFKA_GROUP_ID, "matching-engine");
    const auto grpc_port = Config::getInt(Config::GRPC_PORT, 50051);
    const auto redis_host = Config::get(Config::REDIS_HOST, "localhost");
    const auto redis_port = Config::getInt(Config::REDIS_PORT, 6379);
    
    Logger::info("=== Configuration ===");
    Logger::info("Kafka Brokers:", kafka_brokers);
    Logger::info("Order Topic:", kafka_topic);
    Logger::info("Group ID:", kafka_group);
    Logger::info("gRPC Port:", grpc_port);
    Logger::info("Redis:", redis_host, ":", redis_port);
    Logger::info("=====================");
    
    try {
        // Redis 연결
        RedisClient redis(redis_host, redis_port);
        bool redis_connected = redis.connect();
        if (!redis_connected) {
            Logger::warn("Redis connection failed - continuing without cache");
        }
        
        // Kafka Producer 생성
        KafkaProducer producer(kafka_brokers);
        
        // 핸들러 및 엔진 생성
        MarketDataHandler handler(&producer);
        EngineCore engine(&handler);
        
        // === 시작 시 Redis에서 스냅샷 복원 ===
        if (redis_connected) {
            Logger::info("Restoring snapshots from Redis...");
            auto snapshot_keys = redis.keys("snapshot:*");
            for (const auto& key : snapshot_keys) {
                std::string symbol = key.substr(9);  // "snapshot:" 제거
                auto snapshot_data = redis.get(key);
                if (snapshot_data.has_value()) {
                    engine.restoreOrderBook(symbol, snapshot_data.value());
                    Logger::info("Restored orderbook:", symbol);
                }
            }
            Logger::info("Restored", snapshot_keys.size(), "orderbooks from Redis");
        }
        
        // Kafka Consumer 시작
        KafkaConsumer consumer(kafka_brokers, kafka_topic, kafka_group);
        consumer.setCallback([&engine](const std::string& key,
                                        const std::string& value) {
            Metrics::instance().incrementOrdersReceived();
            
            try {
                auto j = nlohmann::json::parse(value);
                auto order = Order::fromJson(j);
                
                std::string action = j.value("action", "ADD");
                
                if (action == "ADD") {
                    engine.addOrder(order);
                } else if (action == "CANCEL") {
                    engine.cancelOrder(order->symbol(), order->order_id());
                } else if (action == "REPLACE") {
                    int64_t qty_delta = j.value("qty_delta", 0);
                    uint64_t new_price = j.value("new_price", 0);
                    engine.replaceOrder(order->symbol(), order->order_id(), 
                                        qty_delta, new_price);
                }
            } catch (const std::exception& e) {
                Logger::error("Error processing message:", e.what());
            }
        });
        consumer.start();
        
        // gRPC 서버 시작
        GrpcService grpc_service(&engine, &redis);
        grpc_service.start(grpc_port);
        
        Logger::info("=== Engine Running ===");
        Logger::info("Press Ctrl+C to stop");
        
        // 타이머 변수
        auto last_report = std::chrono::steady_clock::now();
        auto last_snapshot = std::chrono::steady_clock::now();
        const int SNAPSHOT_INTERVAL_SECONDS = 10;
        const int METRICS_INTERVAL_SECONDS = 30;
        
        // 메인 루프
        while (g_running) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
            
            auto now = std::chrono::steady_clock::now();
            
            // 10초마다 자동 스냅샷 저장
            if (redis_connected && 
                std::chrono::duration_cast<std::chrono::seconds>(
                    now - last_snapshot).count() >= SNAPSHOT_INTERVAL_SECONDS) {
                
                auto symbols = engine.getAllSymbols();
                for (const auto& symbol : symbols) {
                    auto snapshot = engine.snapshotOrderBook(symbol);
                    if (!snapshot.empty()) {
                        redis.set("snapshot:" + symbol, snapshot);
                    }
                }
                if (!symbols.empty()) {
                    Logger::debug("Auto-saved", symbols.size(), "orderbook snapshots to Redis");
                }
                last_snapshot = now;
            }
            
            // 30초마다 메트릭 리포트
            if (std::chrono::duration_cast<std::chrono::seconds>(
                    now - last_report).count() >= METRICS_INTERVAL_SECONDS) {
                Metrics::instance().setSymbolCount(engine.getSymbolCount());
                Logger::info("Metrics:", Metrics::instance().toJson());
                last_report = now;
            }
        }
        
        // === 종료 전 최종 스냅샷 저장 ===
        if (redis_connected) {
            Logger::info("Saving final snapshots before shutdown...");
            auto symbols = engine.getAllSymbols();
            for (const auto& symbol : symbols) {
                auto snapshot = engine.snapshotOrderBook(symbol);
                if (!snapshot.empty()) {
                    redis.set("snapshot:" + symbol, snapshot);
                }
            }
            Logger::info("Saved", symbols.size(), "snapshots");
        }
        
        // 정리
        Logger::info("Shutting down...");
        consumer.stop();
        grpc_service.stop();
        producer.flush(5000);
        
        Logger::info("=== Shutdown Complete ===");
        return 0;
        
    } catch (const std::exception& e) {
        Logger::error("Fatal error:", e.what());
        return 1;
    }
}
