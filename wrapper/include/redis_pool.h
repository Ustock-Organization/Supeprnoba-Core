#pragma once

#include <hiredis/hiredis.h>
#include <string>
#include <vector>
#include <queue>
#include <mutex>
#include <condition_variable>
#include <memory>
#include <atomic>
#include <thread>
#include <chrono>

namespace aws_wrapper {

// Forward declarations
class RedisConnectionPool;

// Individual connection wrapper with health tracking
struct RedisConnection {
    redisContext* ctx = nullptr;
    std::chrono::steady_clock::time_point last_used;
    std::atomic<bool> in_use{false};
    int consecutive_errors = 0;

    bool isHealthy() const {
        return ctx && !ctx->err && consecutive_errors < 3;
    }

    void markUsed() {
        last_used = std::chrono::steady_clock::now();
    }

    bool isIdle(int timeout_sec) const {
        auto now = std::chrono::steady_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - last_used);
        return elapsed.count() > timeout_sec;
    }
};

/**
 * Thread-safe Redis connection pool using RAII handles
 *
 * Features:
 * - Automatic connection lifecycle management
 * - RAII handles ensure connections are always returned
 * - Background health checks with auto-reconnect
 * - Configurable pool size with dynamic growth
 * - Connection timeout and idle connection cleanup
 *
 * Usage:
 *   RedisConnectionPool pool(config);
 *   pool.startHealthCheck();
 *
 *   {
 *     auto handle = pool.acquire();
 *     redisReply* r = redisCommand(handle.get(), "SET key value");
 *     freeReplyObject(r);
 *   } // Connection auto-released here
 */
class RedisConnectionPool {
public:
    struct Config {
        std::string host = "localhost";
        int port = 6379;
        size_t pool_size = 10;           // Initial pool size
        size_t max_pool_size = 50;       // Max connections (dynamic growth limit)
        int connect_timeout_ms = 1500;   // Connection timeout
        int command_timeout_ms = 1000;   // Command timeout
        int idle_timeout_sec = 60;       // Close idle connections after N seconds
        bool enable_keepalive = true;    // TCP keepalive
    };

    /**
     * RAII handle for automatic connection release
     *
     * Non-copyable but movable to support transfer semantics
     */
    class Handle {
    public:
        Handle(RedisConnectionPool* pool, RedisConnection* conn);
        ~Handle();

        // Non-copyable
        Handle(const Handle&) = delete;
        Handle& operator=(const Handle&) = delete;

        // Movable
        Handle(Handle&& other) noexcept;
        Handle& operator=(Handle&& other) noexcept;

        // Access underlying redisContext
        redisContext* get() const { return conn_ ? conn_->ctx : nullptr; }

        // Check if handle is valid and healthy
        bool isValid() const { return conn_ && conn_->isHealthy(); }

        // Get raw connection (for advanced use cases)
        RedisConnection* connection() { return conn_; }

    private:
        RedisConnectionPool* pool_;
        RedisConnection* conn_;
    };

    explicit RedisConnectionPool(const Config& config);
    ~RedisConnectionPool();

    // Non-copyable, non-movable (resource manager)
    RedisConnectionPool(const RedisConnectionPool&) = delete;
    RedisConnectionPool& operator=(const RedisConnectionPool&) = delete;

    /**
     * Acquire a connection from the pool
     *
     * Blocks if pool is exhausted, with configurable timeout.
     * Returns invalid handle on timeout.
     *
     * @param timeout Max wait time for available connection
     * @return RAII handle (automatically releases on destruction)
     */
    Handle acquire(std::chrono::milliseconds timeout = std::chrono::seconds(5));

    // Pool statistics
    size_t size() const;
    size_t available() const;
    size_t inUse() const { return size() - available(); }

    // Health management
    void startHealthCheck(std::chrono::seconds interval = std::chrono::seconds(30));
    void stopHealthCheck();

    // Manual pool control (advanced)
    void closeIdleConnections();
    bool addConnection();  // Returns false if max_pool_size reached

private:
    Config config_;

    // Connection storage
    std::vector<std::unique_ptr<RedisConnection>> connections_;
    std::queue<RedisConnection*> available_queue_;

    // Thread synchronization
    mutable std::mutex mutex_;
    std::condition_variable cv_;
    std::atomic<bool> running_{true};

    // Background health check thread
    std::thread health_thread_;
    std::atomic<bool> health_check_running_{false};

    // Internal methods
    RedisConnection* createConnection();
    void releaseConnection(RedisConnection* conn);
    void healthCheckLoop(std::chrono::seconds interval);
    void closeConnection(RedisConnection* conn);
    bool reconnectIfNeeded(RedisConnection* conn);

    friend class Handle;
};

} // namespace aws_wrapper
