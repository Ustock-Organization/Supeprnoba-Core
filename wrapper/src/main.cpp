#include "config.h"
#include "logger.h"
#include "engine_core.h"
#include "market_data_handler.h"
#include "grpc_service.h"
#include "redis_client.h"
#include "metrics.h"
#include "kinesis_consumer.h"
#include "kinesis_producer.h"
#include "dynamodb_client.h"
#include <iostream>
#include <csignal>
#include <nlohmann/json.hpp>
#include <aws/core/Aws.h>

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
║                 Kinesis + DynamoDB                        ║
╚═══════════════════════════════════════════════════════════╝
)" << std::endl;
}

int main(int argc, char* argv[]) {
    printBanner();
    
    // AWS SDK 초기화
    Aws::SDKOptions options;
    Aws::InitAPI(options);
    Logger::info("AWS SDK initialized - Using Kinesis");
    
    // 시그널 핸들러 설정
    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);
    
    // 로그 레벨 설정
    std::string log_level = Config::get(Config::LOG_LEVEL, "INFO");
    if (log_level == "DEBUG") Logger::setLevel(LogLevel::DEBUG);
    else if (log_level == "WARN") Logger::setLevel(LogLevel::WARN);
    else if (log_level == "ERROR") Logger::setLevel(LogLevel::ERROR);
    
    // 환경변수에서 설정 로드
    const auto stream_name = Config::get("KINESIS_ORDERS_STREAM", "supernoba-orders");
    const auto aws_region = Config::get("AWS_REGION", "ap-northeast-2");
    const auto grpc_port = Config::getInt(Config::GRPC_PORT, 50051);
    const auto redis_host = Config::get(Config::REDIS_HOST, "localhost");
    const auto redis_port = Config::getInt(Config::REDIS_PORT, 6379);
    const auto depth_cache_host = Config::get("DEPTH_CACHE_HOST", redis_host);
    const auto depth_cache_port = Config::getInt("DEPTH_CACHE_PORT", redis_port);
    const auto dynamodb_table = Config::get("DYNAMODB_TRADE_TABLE", "trade_history");
    
    Logger::info("=== Configuration ===");
    Logger::info("Kinesis Stream:", stream_name);
    Logger::info("AWS Region:", aws_region);
    Logger::info("DynamoDB Table:", dynamodb_table);
    Logger::info("gRPC Port:", grpc_port);
    Logger::info("Redis (snapshot):", redis_host, ":", redis_port);
    Logger::info("Redis (depth):", depth_cache_host, ":", depth_cache_port);
    Logger::info("=====================");
    
    try {
        // Redis 연결 (스냅샷 백업용)
        RedisClient redis(redis_host, redis_port);
        bool redis_connected = redis.connect();
        if (!redis_connected) {
            Logger::warn("Redis (snapshot) connection failed - continuing without cache");
        }
        
        // Depth 캐시 연결 (실시간 호가용)
        RedisClient depth_cache(depth_cache_host, depth_cache_port);
        bool depth_connected = depth_cache.connect();
        if (!depth_connected) {
            Logger::warn("Redis (depth) connection failed - continuing without depth cache");
        }
        
        // Kinesis Producer 생성
        KinesisProducer producer(aws_region);
        
        // DynamoDB Client 생성 (체결 내역 저장용)
        DynamoDBClient dynamodb(aws_region, dynamodb_table);
        bool dynamodb_connected = dynamodb.connect();
        if (!dynamodb_connected) {
            Logger::warn("DynamoDB connection failed - continuing without trade history");
        } else {
            Logger::info("DynamoDB connected:", dynamodb_table);
        }
        
        // 핸들러 및 엔진 생성
        MarketDataHandler handler(&producer, depth_connected ? &depth_cache : nullptr, 
                                  dynamodb_connected ? &dynamodb : nullptr);
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
        
        // Kinesis Consumer 시작
        KinesisConsumer consumer(stream_name, aws_region);
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
                Logger::error("Failed to process order:", e.what());
                Metrics::instance().incrementOrdersRejected();
            }
        });
        
        // gRPC 서비스 시작
        GrpcService grpc_service(&engine, redis_connected ? &redis : nullptr);
        grpc_service.start(grpc_port);
        
        // Consumer 시작
        consumer.start();
        
        Logger::info("=== Engine Running ===");
        Logger::info("Listening for orders on:", stream_name);
        Logger::info("gRPC server on port:", grpc_port);
        
        // 메인 루프: 스냅샷 저장
        auto last_snapshot = std::chrono::steady_clock::now();
        auto last_metrics = std::chrono::steady_clock::now();
        
        while (g_running) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
            
            auto now = std::chrono::steady_clock::now();
            
            // 10초마다 스냅샷 저장
            if (redis_connected && 
                std::chrono::duration_cast<std::chrono::seconds>(now - last_snapshot).count() >= 10) {
                
                auto symbols = engine.getAllSymbols();
                for (const auto& symbol : symbols) {
                    auto snapshot = engine.snapshotOrderBook(symbol);
                    if (!snapshot.empty()) {
                        redis.saveSnapshot(symbol, snapshot);
                    }
                }
                last_snapshot = now;
                Logger::debug("Snapshots saved for", symbols.size(), "symbols");
            }
            
            // 30초마다 메트릭 로깅
            if (std::chrono::duration_cast<std::chrono::seconds>(now - last_metrics).count() >= 30) {
                auto& m = Metrics::instance();
                Logger::info("=== Metrics ===");
                Logger::info("Orders received:", m.getOrdersReceived());
                Logger::info("Orders accepted:", m.getOrdersAccepted());
                Logger::info("Trades executed:", m.getTradesExecuted());
                Logger::info("===============");
                last_metrics = now;
            }
        }
        
        // 정리
        Logger::info("Shutting down...");
        consumer.stop();
        grpc_service.stop();
        producer.flush(5000);
        
        Logger::info("=== Shutdown Complete ===");
        
    } catch (const std::exception& e) {
        Logger::error("Fatal error:", e.what());
        Aws::ShutdownAPI(options);
        return 1;
    }
    
    Aws::ShutdownAPI(options);
    return 0;
}
