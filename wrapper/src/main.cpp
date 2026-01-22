#include "config.h"
#include "logger.h"
#include "engine_core.h"
#include "market_data_handler.h"
#include "notification_client.h"
#include "ranking_manager.h"
#include "grpc_service.h"
#include "redis_client.h"
#include "metrics.h"
#include "kinesis_consumer.h"
#include "kinesis_producer.h"
#include "dynamodb_client.h"
#include "checkpoint_manager.h"

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
║                    Kinesis + Valkey                       ║
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
    
    // Checkpoint 설정
    const bool checkpoint_enabled = Config::get("KINESIS_CHECKPOINT_ENABLED", "true") == "true";
    const int checkpoint_interval_records = Config::getInt("KINESIS_CHECKPOINT_INTERVAL_RECORDS", 100);
    const int checkpoint_interval_seconds = Config::getInt("KINESIS_CHECKPOINT_INTERVAL_SECONDS", 5);
    const int drain_timeout_seconds = Config::getInt("SHUTDOWN_DRAIN_TIMEOUT_SECONDS", 30);

    Logger::info("=== Configuration ===");
    Logger::info("Kinesis Stream:", stream_name);
    Logger::info("AWS Region:", aws_region);
    Logger::info("gRPC Port:", grpc_port);
    Logger::info("Redis (snapshot):", redis_host, ":", redis_port);
    Logger::info("Redis (depth):", depth_cache_host, ":", depth_cache_port);
    Logger::info("Checkpoint enabled:", checkpoint_enabled ? "YES" : "NO");
    Logger::info("Checkpoint interval:", checkpoint_interval_records, "records /", checkpoint_interval_seconds, "seconds");
    Logger::info("Drain timeout:", drain_timeout_seconds, "seconds");
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
        
        // Trade history is now saved via Lambda (Kinesis fills stream)
        
        // NotificationClient 생성 (WebSocket 직접 알림)
        // 중요: RedisClient는 Thread-safe하지 않으므로, 백그라운드 스레드용으로 별도 연결 생성
        RedisClient notification_redis(depth_cache_host, depth_cache_port);
        bool notification_redis_connected = false;
        if (depth_connected) {
             notification_redis_connected = notification_redis.connect();
             if (notification_redis_connected) {
                 Logger::info("Redis (notification) connected");
             }
        }

        std::string ws_endpoint = Config::get("WEBSOCKET_ENDPOINT", "");
        NotificationClient notifier(notification_redis_connected ? &notification_redis : nullptr);
        bool notifier_enabled = false;
        if (!ws_endpoint.empty()) {
            notifier_enabled = notifier.initialize(ws_endpoint, aws_region);
            if (notifier_enabled) {
                Logger::info("NotificationClient enabled:", ws_endpoint);
            } else {
                Logger::warn("NotificationClient initialization failed");
            }
        } else {
            Logger::warn("WEBSOCKET_ENDPOINT not set - notifications disabled");
        }

        // RankingManager 생성 (백업용 Redis 사용)
        // 주의: 스레드 시작은 snapshot 복원 후로 지연 (RedisClient thread-safety 문제 방지)
        RankingManager ranking_manager(redis_connected ? &redis : nullptr);
        bool ranking_enabled = redis_connected;
        // ranking_manager.startSnapshotThread()는 나중에 호출됨
        if (ranking_enabled) {
            Logger::info("RankingManager created (thread will start after snapshot restore)");
        } else {
            Logger::warn("RankingManager disabled - Redis (backup) not connected");
        }

        // 핸들러 및 엔진 생성
        MarketDataHandler handler(&producer, depth_connected ? &depth_cache : nullptr,
                                  notifier_enabled ? &notifier : nullptr,
                                  ranking_enabled ? &ranking_manager : nullptr);
        EngineCore engine(&handler);
        
        // === 시작 시 Redis에서 스냅샷 복원 ===
        if (redis_connected) {
            Logger::info("Restoring snapshots from Redis...");
            auto snapshot_keys = redis.keys("snapshot:*");
            int restored_count = 0;
            for (const auto& key : snapshot_keys) {
                // :timestamp 키는 제외 (타임스탬프 메타데이터)
                if (key.find(":timestamp") != std::string::npos) {
                    continue;
                }
                std::string symbol = key.substr(9);  // "snapshot:" 제거
                auto snapshot_data = redis.get(key);
                if (snapshot_data.has_value()) {
                    engine.restoreOrderBook(symbol, snapshot_data.value());
                    Logger::info("Restored orderbook:", symbol);
                    ++restored_count;
                }
            }
            Logger::info("Restored", restored_count, "orderbooks from Redis");
        }

        // Snapshot 복원 완료 후 RankingManager 스레드 시작 (Redis 동시 접근 방지)
        if (ranking_enabled) {
            ranking_manager.startSnapshotThread();
            Logger::info("RankingManager snapshot thread started (10s interval)");
        }

        // === DynamoDB에서 ACCEPTED 주문 복원 ===
        // 스냅샷에 없는 주문들(엔진 재시작 중 생성된 주문 등)을 복원
        const auto orders_table = Config::get("DYNAMODB_ORDERS_TABLE", "supernoba-orders");
        const bool load_from_dynamodb = Config::get("LOAD_ORDERS_FROM_DYNAMODB", "true") == "true";

        if (load_from_dynamodb) {
            Logger::info("Loading ACCEPTED orders from DynamoDB...");
            DynamoDBClient dynamodb(aws_region);

            if (dynamodb.initialize()) {
                // === totalShares 로드 (RankingManager용) ===
                if (ranking_enabled) {
                    const auto stocks_table = Config::get("DYNAMODB_STOCKS_TABLE", "supernoba-stocks");
                    auto total_shares_map = dynamodb.loadSymbolsTotalShares(stocks_table);
                    for (const auto& [symbol, shares] : total_shares_map) {
                        ranking_manager.setTotalShares(symbol, shares);
                    }
                    Logger::info("Loaded totalShares for", total_shares_map.size(), "symbols into RankingManager");
                }

                auto accepted_orders = dynamodb.loadAcceptedOrders(orders_table);

                int added_count = 0;
                int skipped_count = 0;

                for (const auto& order : accepted_orders) {
                    // 이미 오더북에 있는 주문은 스킵 (스냅샷에서 복원된 경우)
                    if (engine.hasOrder(order->symbol(), order->order_id())) {
                        ++skipped_count;
                        continue;
                    }

                    // 오더북에 주문 추가
                    engine.addOrder(order);
                    ++added_count;

                    Logger::debug("Added order from DynamoDB:", order->order_id(),
                                 "symbol:", order->symbol(),
                                 "side:", (order->is_buy() ? "BUY" : "SELL"),
                                 "price:", order->price(),
                                 "qty:", order->order_qty());
                }

                Logger::info("DynamoDB order restore complete: added=", added_count,
                            ", skipped (already in snapshot)=", skipped_count);
            } else {
                Logger::warn("DynamoDB client initialization failed - skipping order restore");
            }
        } else {
            Logger::info("LOAD_ORDERS_FROM_DYNAMODB=false - skipping DynamoDB order restore");
        }
        
        // === CheckpointManager 생성 ===
        std::unique_ptr<CheckpointManager> checkpoint_manager;
        if (checkpoint_enabled && redis_connected) {
            CheckpointManager::Config cp_config;
            cp_config.stream_name = stream_name;
            cp_config.flush_interval_records = checkpoint_interval_records;
            cp_config.flush_interval_seconds = checkpoint_interval_seconds;
            cp_config.enable_background_flush = false;  // 동기식 체크포인팅

            checkpoint_manager = std::make_unique<CheckpointManager>(&redis, cp_config);
            Logger::info("CheckpointManager initialized for stream:", stream_name);
        } else {
            Logger::warn("CheckpointManager disabled - checkpoint_enabled:", checkpoint_enabled, "redis_connected:", redis_connected);
        }

        // Kinesis Consumer 시작
        KinesisConsumer consumer(stream_name, aws_region);

        // Checkpoint 설정
        if (checkpoint_manager) {
            consumer.setCheckpointManager(checkpoint_manager.get());
            consumer.setCheckpointEnabled(true);
        } else {
            consumer.setCheckpointEnabled(false);
        }
        consumer.setDrainTimeoutSeconds(drain_timeout_seconds);

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
        
        // 정리 (Graceful Shutdown)
        Logger::info("=== Initiating Graceful Shutdown ===");

        // 1. RankingManager 스레드 종료
        if (ranking_enabled) {
            Logger::info("Stopping RankingManager...");
            ranking_manager.stopSnapshotThread();
        }

        // 2. Kinesis Consumer 종료 (Graceful: drain + checkpoint)
        Logger::info("Stopping KinesisConsumer (drain timeout:", drain_timeout_seconds, "s)...");
        consumer.stop();
        Logger::info("KinesisConsumer stopped, records processed:", consumer.getRecordsProcessed());

        // 3. 최종 스냅샷 저장
        if (redis_connected) {
            Logger::info("Saving final orderbook snapshots...");
            auto symbols = engine.getAllSymbols();
            for (const auto& symbol : symbols) {
                auto snapshot = engine.snapshotOrderBook(symbol);
                if (!snapshot.empty()) {
                    redis.saveSnapshot(symbol, snapshot);
                }
            }
            Logger::info("Final snapshots saved for", symbols.size(), "symbols");
        }

        // 4. gRPC 서버 종료
        Logger::info("Stopping gRPC server...");
        grpc_service.stop();

        // 5. Kinesis Producer flush
        Logger::info("Flushing Kinesis Producer...");
        producer.flush(5000);

        // 6. Checkpoint 메트릭 로깅
        if (checkpoint_manager) {
            Logger::info("Checkpoint stats - saved:", checkpoint_manager->getCheckpointCount(),
                        "flushed:", checkpoint_manager->getFlushCount());
        }

        Logger::info("=== Shutdown Complete ===");
        
    } catch (const std::exception& e) {
        Logger::error("Fatal error:", e.what());
        Aws::ShutdownAPI(options);
        return 1;
    }
    
    Aws::ShutdownAPI(options);
    return 0;
}
