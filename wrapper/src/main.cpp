#include "config.h"
#include "logger.h"
#include "engine_core.h"
#include "market_data_handler.h"
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
#include <set>
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
    const auto candle_cache_host = Config::get("CANDLE_CACHE_HOST", redis_host);
    const auto candle_cache_port = Config::getInt("CANDLE_CACHE_PORT", redis_port);
    const auto backup_cache_host = Config::get("BACKUP_CACHE_HOST", redis_host);
    const auto backup_cache_port = Config::getInt("BACKUP_CACHE_PORT", redis_port);
    const auto operating_cache_host = Config::get("OPERATING_CACHE_HOST", redis_host);
    const auto operating_cache_port = Config::getInt("OPERATING_CACHE_PORT", redis_port);
    
    // Checkpoint 설정
    const bool checkpoint_enabled = Config::get("KINESIS_CHECKPOINT_ENABLED", "true") == "true";
    const int checkpoint_interval_records = Config::getInt("KINESIS_CHECKPOINT_INTERVAL_RECORDS", 100);
    const int checkpoint_interval_seconds = Config::getInt("KINESIS_CHECKPOINT_INTERVAL_SECONDS", 5);
    const int drain_timeout_seconds = Config::getInt("SHUTDOWN_DRAIN_TIMEOUT_SECONDS", 30);

    Logger::info("=== Configuration ===");
    Logger::info("Kinesis Stream:", stream_name);
    Logger::info("AWS Region:", aws_region);
    Logger::info("gRPC Port:", grpc_port);
    Logger::info("Redis (depth):", depth_cache_host, ":", depth_cache_port);
    Logger::info("Redis (candle):", candle_cache_host, ":", candle_cache_port);
    Logger::info("Redis (backup):", backup_cache_host, ":", backup_cache_port);
    Logger::info("Redis (operating):", operating_cache_host, ":", operating_cache_port);
    Logger::info("Checkpoint enabled:", checkpoint_enabled ? "YES" : "NO");
    Logger::info("Checkpoint interval:", checkpoint_interval_records, "records /", checkpoint_interval_seconds, "seconds");
    Logger::info("Drain timeout:", drain_timeout_seconds, "seconds");
    Logger::info("=====================");
    
    try {
        // 1. Depth cache (실시간 호가/티커)
        RedisClient depth_redis(depth_cache_host, depth_cache_port);
        bool depth_connected = depth_redis.connect();
        if (!depth_connected) Logger::warn("Redis (depth) connection failed");

        // 2. Candle cache (캔들 데이터)
        RedisClient candle_redis(candle_cache_host, candle_cache_port);
        bool candle_connected = candle_redis.connect();
        if (!candle_connected) Logger::warn("Redis (candle) connection failed");

        // 3. Backup cache — main thread (스냅샷/GrpcService)
        RedisClient backup_redis(backup_cache_host, backup_cache_port);
        bool backup_connected = backup_redis.connect();
        if (!backup_connected) Logger::warn("Redis (backup) connection failed");

        // 4. Backup cache — RankingManager writes (main thread, on_fill에서 호출)
        RedisClient ranking_write_redis(backup_cache_host, backup_cache_port);
        bool ranking_write_connected = backup_connected && ranking_write_redis.connect();

        // 5. Backup cache — RankingManager bg thread
        RedisClient ranking_bg_redis(backup_cache_host, backup_cache_port);
        bool ranking_bg_connected = backup_connected && ranking_bg_redis.connect();

        // 6. Backup cache — CheckpointManager bg thread
        RedisClient checkpoint_redis(backup_cache_host, backup_cache_port);
        bool checkpoint_connected = backup_connected && checkpoint_redis.connect();

        // 7. Operating cache (연결 관리/상태)
        RedisClient operating_redis(operating_cache_host, operating_cache_port);
        bool operating_connected = operating_redis.connect();
        if (!operating_connected) Logger::warn("Redis (operating) connection failed");
        
        // Kinesis Producer 생성
        KinesisProducer producer(aws_region);
        
        // Trade history is now saved via Lambda (Kinesis fills stream)
        
        // RankingManager 생성 (백업용 Redis 2개: main thread write + bg thread read)
        // 주의: 스레드 시작은 snapshot 복원 후로 지연 (RedisClient thread-safety 문제 방지)
        RankingManager ranking_manager(
            ranking_write_connected ? &ranking_write_redis : nullptr,
            ranking_bg_connected ? &ranking_bg_redis : nullptr);
        bool ranking_enabled = ranking_write_connected && ranking_bg_connected;
        // ranking_manager.startSnapshotThread()는 나중에 호출됨
        if (ranking_enabled) {
            Logger::info("RankingManager created (thread will start after snapshot restore)");
        } else {
            Logger::warn("RankingManager disabled - Redis (backup) not connected");
        }

        // 핸들러 및 엔진 생성
        MarketDataHandler handler(&producer,
            depth_connected ? &depth_redis : nullptr,
            candle_connected ? &candle_redis : nullptr,
            ranking_enabled ? &ranking_manager : nullptr);
        EngineCore engine(&handler, operating_connected ? &operating_redis : nullptr);
        
        // === 시작 시 Redis에서 스냅샷 복원 ===
        // 먼저 deleted:symbols 로드 (상장폐지된 종목 필터링용)
        std::set<std::string> deleted_symbols;
        if (operating_connected) {
            auto deleted_vec = operating_redis.smembers("deleted:symbols");
            deleted_symbols = std::set<std::string>(deleted_vec.begin(), deleted_vec.end());
            if (!deleted_symbols.empty()) {
                Logger::info("Loaded", deleted_symbols.size(), "deleted symbols to filter");
            }
        }

        if (backup_connected) {
            Logger::info("Restoring snapshots from Redis...");
            auto snapshot_keys = backup_redis.keys("snapshot:*");
            int restored_count = 0;
            int skipped_deleted = 0;
            for (const auto& key : snapshot_keys) {
                // :timestamp 키는 제외 (타임스탬프 메타데이터)
                if (key.find(":timestamp") != std::string::npos) {
                    continue;
                }
                std::string symbol = key.substr(9);  // "snapshot:" 제거

                // 삭제된 종목은 스킵
                if (deleted_symbols.count(symbol) > 0) {
                    Logger::warn("Skipping deleted symbol snapshot:", symbol);
                    ++skipped_deleted;
                    continue;
                }

                auto snapshot_data = backup_redis.get(key);
                if (snapshot_data.has_value()) {
                    engine.restoreOrderBook(symbol, snapshot_data.value());
                    Logger::info("Restored orderbook:", symbol);
                    ++restored_count;
                }
            }
            Logger::info("Restored", restored_count, "orderbooks from Redis (skipped", skipped_deleted, "deleted)");
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
            Logger::info("Loading active orders (ACCEPTED + PARTIAL_FILL) from DynamoDB...");
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

                auto active_orders = dynamodb.loadActiveOrders(orders_table);

                int added_count = 0;
                int skipped_count = 0;
                int skipped_deleted = 0;

                for (const auto& order : active_orders) {
                    // 삭제된 종목의 주문은 스킵
                    if (deleted_symbols.count(order->symbol()) > 0) {
                        ++skipped_deleted;
                        continue;
                    }

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
                            ", skipped (snapshot)=", skipped_count,
                            ", skipped (deleted)=", skipped_deleted);
            } else {
                Logger::warn("DynamoDB client initialization failed - skipping order restore");
            }
        } else {
            Logger::info("LOAD_ORDERS_FROM_DYNAMODB=false - skipping DynamoDB order restore");
        }
        
        // === CheckpointManager 생성 ===
        const bool clear_checkpoints_on_start = Config::get("CLEAR_CHECKPOINTS_ON_START", "true") == "true";

        std::unique_ptr<CheckpointManager> checkpoint_manager;
        if (checkpoint_enabled && checkpoint_connected) {
            CheckpointManager::Config cp_config;
            cp_config.stream_name = stream_name;
            cp_config.flush_interval_records = checkpoint_interval_records;
            cp_config.flush_interval_seconds = checkpoint_interval_seconds;
            cp_config.enable_background_flush = true;

            checkpoint_manager = std::make_unique<CheckpointManager>(&checkpoint_redis, cp_config);

            // === 복구 모드 ===
            // replay(AWS 기본): 스냅샷과 정합한 앵커(engine:snapshot:anchor)에서 Kinesis 재생.
            //   앵커는 스냅샷 저장 직전의 샤드 위치라 anchor ≤ snapshot 커버리지 → 유실 0,
            //   [anchor, snapshot] 중복분은 엔진 dedup(processed_orders_)이 흡수.
            //   이로써 스냅샷~크래시 사이 10초 유실창과 시간우선순위 소실이 원리적으로 닫힘.
            // clear(레거시): 체크포인트 삭제 후 LATEST — 다운타임 유입분 유실.
            const std::string recovery_mode = Config::get("RECOVERY_MODE", "replay");
            if (recovery_mode == "replay") {
                checkpoint_manager->clearAllCheckpoints();  // 스테일 raw 체크포인트 제거
                std::string anchor_json;
                if (backup_connected) {
                    auto a = backup_redis.get("engine:snapshot:anchor");
                    if (a.has_value()) anchor_json = a.value();
                }
                if (!anchor_json.empty()) {
                    try {
                        auto anchor = nlohmann::json::parse(anchor_json);
                        int seeded = 0;
                        for (auto it = anchor.begin(); it != anchor.end(); ++it) {
                            checkpoint_manager->checkpointImmediate(
                                it.key(), it.value().get<std::string>());
                            ++seeded;
                        }
                        Logger::info("RECOVERY=replay: seeded", seeded,
                                     "shard checkpoints from snapshot anchor");
                    } catch (const std::exception& e) {
                        Logger::warn("RECOVERY=replay: anchor parse failed, LATEST fallback:",
                                     e.what());
                    }
                } else {
                    Logger::info("RECOVERY=replay: no anchor (first run) - shards start from LATEST");
                }
            } else if (clear_checkpoints_on_start) {
                checkpoint_manager->clearAllCheckpoints();
                Logger::info("Cleared stale checkpoints - all shards will start from LATEST");
            }

            checkpoint_manager->startBackgroundFlush();
            Logger::info("CheckpointManager initialized for stream:", stream_name, "(background flush enabled)");
        } else {
            Logger::warn("CheckpointManager disabled - checkpoint_enabled:", checkpoint_enabled, "checkpoint_connected:", checkpoint_connected);
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
        GrpcService grpc_service(&engine, backup_connected ? &backup_redis : nullptr);
        grpc_service.start(grpc_port);
        
        // Consumer 시작
        consumer.start();
        
        Logger::info("=== Engine Running ===");
        Logger::info("Listening for orders on:", stream_name);
        Logger::info("gRPC server on port:", grpc_port);
        
        // 메인 루프: 스냅샷 저장 + watchdog
        auto last_snapshot = std::chrono::steady_clock::now();
        auto last_metrics = std::chrono::steady_clock::now();

        while (g_running) {
            std::this_thread::sleep_for(std::chrono::seconds(1));

            auto now = std::chrono::steady_clock::now();

            // Fix 1: Watchdog — consumer 스레드가 60초 이상 진행하지 않으면 재시작
            if (consumer.isRunning()) {
                auto last_progress = consumer.getLastProgressEpochMs();
                if (last_progress > 0) {
                    auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::system_clock::now().time_since_epoch()).count();
                    auto stale_seconds = (now_ms - last_progress) / 1000;
                    if (stale_seconds >= KinesisConsumer::WATCHDOG_TIMEOUT_SECONDS) {
                        Logger::error("WATCHDOG: KinesisConsumer stale for", stale_seconds,
                                      "seconds (threshold:", KinesisConsumer::WATCHDOG_TIMEOUT_SECONDS,
                                      "s) - restarting consumer");
                        consumer.restart();
                    }
                }
            }

            // 10초마다 스냅샷 저장
            if (backup_connected &&
                std::chrono::duration_cast<std::chrono::seconds>(now - last_snapshot).count() >= 10) {

                // 앵커: 스냅샷 "직전"의 샤드 위치를 먼저 캡처.
                // 스냅샷은 이 위치 이후 레코드까지 반영하므로 anchor ≤ snapshot 커버리지가 보장되어,
                // 복구 시 재생이 유실 없이(중복은 dedup 흡수) 이어진다.
                auto positions = consumer.getShardPositions();

                auto symbols = engine.getAllSymbols();
                for (const auto& symbol : symbols) {
                    auto snapshot = engine.snapshotOrderBook(symbol);
                    if (!snapshot.empty()) {
                        backup_redis.saveSnapshot(symbol, snapshot);
                    }
                }

                // 앵커 영속화 (스냅샷 이후 — 스냅샷이 먼저 안전하게 저장된 뒤 앵커 갱신)
                if (!positions.empty()) {
                    nlohmann::json anchor;
                    for (const auto& [shard, seq] : positions) anchor[shard] = seq;
                    backup_redis.set("engine:snapshot:anchor", anchor.dump());
                }

                last_snapshot = now;
                Logger::debug("Snapshots saved for", symbols.size(), "symbols (anchor:",
                              positions.size(), "shards)");
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
        if (backup_connected) {
            Logger::info("Saving final orderbook snapshots...");
            auto symbols = engine.getAllSymbols();
            for (const auto& symbol : symbols) {
                auto snapshot = engine.snapshotOrderBook(symbol);
                if (!snapshot.empty()) {
                    backup_redis.saveSnapshot(symbol, snapshot);
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
