#include "redis_pool.h"
#include "logger.h"
#include <stdexcept>

namespace aws_wrapper {

// ==================== Handle Implementation ====================

RedisConnectionPool::Handle::Handle(RedisConnectionPool* pool, RedisConnection* conn)
    : pool_(pool), conn_(conn) {
    if (conn_) {
        conn_->in_use.store(true, std::memory_order_release);
        conn_->markUsed();
    }
}

RedisConnectionPool::Handle::~Handle() {
    if (pool_ && conn_) {
        pool_->releaseConnection(conn_);
    }
}

RedisConnectionPool::Handle::Handle(Handle&& other) noexcept
    : pool_(other.pool_), conn_(other.conn_) {
    other.pool_ = nullptr;
    other.conn_ = nullptr;
}

RedisConnectionPool::Handle& RedisConnectionPool::Handle::operator=(Handle&& other) noexcept {
    if (this != &other) {
        // Release current connection
        if (pool_ && conn_) {
            pool_->releaseConnection(conn_);
        }

        // Move from other
        pool_ = other.pool_;
        conn_ = other.conn_;
        other.pool_ = nullptr;
        other.conn_ = nullptr;
    }
    return *this;
}

// ==================== Pool Implementation ====================

RedisConnectionPool::RedisConnectionPool(const Config& config)
    : config_(config) {

    if (config_.pool_size == 0) {
        throw std::invalid_argument("pool_size must be > 0");
    }

    if (config_.max_pool_size < config_.pool_size) {
        throw std::invalid_argument("max_pool_size must be >= pool_size");
    }

    Logger::info("RedisConnectionPool initializing:",
                 "host:", config_.host,
                 "port:", config_.port,
                 "initial_size:", config_.pool_size,
                 "max_size:", config_.max_pool_size);

    // Pre-create initial pool
    connections_.reserve(config_.max_pool_size);

    for (size_t i = 0; i < config_.pool_size; ++i) {
        auto conn = createConnection();
        if (conn) {
            connections_.emplace_back(conn);
            available_queue_.push(conn);
        } else {
            Logger::error("Failed to create connection", i, "during pool initialization");
            // Continue - partial pool is better than nothing
        }
    }

    Logger::info("RedisConnectionPool initialized with", connections_.size(), "connections");
}

RedisConnectionPool::~RedisConnectionPool() {
    Logger::info("RedisConnectionPool shutting down...");

    // Stop health check first
    stopHealthCheck();

    // Mark as not running
    running_.store(false, std::memory_order_release);

    // Wake up any waiting threads
    cv_.notify_all();

    // Close all connections
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& conn_ptr : connections_) {
        if (conn_ptr && conn_ptr->ctx) {
            redisFree(conn_ptr->ctx);
            conn_ptr->ctx = nullptr;
        }
    }
    connections_.clear();

    Logger::info("RedisConnectionPool shutdown complete");
}

RedisConnection* RedisConnectionPool::createConnection() {
    struct timeval connect_tv = {
        config_.connect_timeout_ms / 1000,
        (config_.connect_timeout_ms % 1000) * 1000
    };

    redisContext* ctx = redisConnectWithTimeout(config_.host.c_str(),
                                                 config_.port,
                                                 connect_tv);

    if (!ctx) {
        Logger::error("Redis connection failed: unable to allocate context");
        return nullptr;
    }

    if (ctx->err) {
        Logger::error("Redis connection failed:", ctx->errstr);
        redisFree(ctx);
        return nullptr;
    }

    // Set command timeout
    struct timeval cmd_tv = {
        config_.command_timeout_ms / 1000,
        (config_.command_timeout_ms % 1000) * 1000
    };

    if (redisSetTimeout(ctx, cmd_tv) != REDIS_OK) {
        Logger::warn("Failed to set command timeout");
    }

    // Enable TCP keepalive
    if (config_.enable_keepalive) {
        if (redisEnableKeepAlive(ctx) != REDIS_OK) {
            Logger::warn("Failed to enable keepalive");
        }
    }

    // Allocate new connection
    auto conn = new RedisConnection();
    conn->ctx = ctx;
    conn->markUsed();
    conn->consecutive_errors = 0;

    Logger::debug("Created new Redis connection:", ctx);
    return conn;
}

RedisConnectionPool::Handle RedisConnectionPool::acquire(std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lock(mutex_);

    auto deadline = std::chrono::steady_clock::now() + timeout;

    while (true) {
        // Check if pool is shut down
        if (!running_.load(std::memory_order_acquire)) {
            Logger::warn("acquire() called on stopped pool");
            return Handle(this, nullptr);
        }

        // Check if connection available
        if (!available_queue_.empty()) {
            auto conn = available_queue_.front();
            available_queue_.pop();

            // Verify connection health before returning
            if (conn->isHealthy()) {
                Logger::debug("Acquired connection from pool, available:", available_queue_.size());
                return Handle(this, conn);
            } else {
                // Connection unhealthy, try to reconnect
                Logger::warn("Acquired unhealthy connection, attempting reconnect");
                lock.unlock();
                bool reconnected = reconnectIfNeeded(conn);
                lock.lock();

                if (reconnected) {
                    Logger::info("Successfully reconnected unhealthy connection");
                    return Handle(this, conn);
                } else {
                    // Reconnect failed, remove from pool and retry
                    Logger::error("Failed to reconnect, removing from pool");
                    auto it = std::find_if(connections_.begin(), connections_.end(),
                        [conn](const std::unique_ptr<RedisConnection>& p) { return p.get() == conn; });
                    if (it != connections_.end()) {
                        connections_.erase(it);
                    }
                    // Continue loop to try next connection
                    continue;
                }
            }
        }

        // No connections available - try to grow pool
        if (connections_.size() < config_.max_pool_size) {
            Logger::info("Pool exhausted, growing pool:", connections_.size(), "->", connections_.size() + 1);
            lock.unlock();

            auto new_conn = createConnection();

            lock.lock();
            if (new_conn) {
                connections_.emplace_back(new_conn);
                Logger::info("Successfully grew pool to", connections_.size(), "connections");
                return Handle(this, new_conn);
            } else {
                Logger::error("Failed to create new connection during pool growth");
                // Fall through to wait
            }
        }

        // Pool exhausted and can't grow - wait for release
        Logger::warn("Pool exhausted (", connections_.size(), "/", config_.max_pool_size, "), waiting...");

        if (cv_.wait_until(lock, deadline) == std::cv_status::timeout) {
            Logger::error("acquire() timed out after", timeout.count(), "ms");
            return Handle(this, nullptr);  // Invalid handle
        }
    }
}

void RedisConnectionPool::releaseConnection(RedisConnection* conn) {
    if (!conn) return;

    conn->in_use.store(false, std::memory_order_release);
    conn->markUsed();

    std::lock_guard<std::mutex> lock(mutex_);
    available_queue_.push(conn);

    Logger::debug("Released connection to pool, available:", available_queue_.size());

    // Notify one waiting thread
    cv_.notify_one();
}

bool RedisConnectionPool::reconnectIfNeeded(RedisConnection* conn) {
    if (!conn) return false;

    // Already healthy
    if (conn->isHealthy()) return true;

    Logger::info("Reconnecting Redis connection...");

    // Close old connection
    if (conn->ctx) {
        redisFree(conn->ctx);
        conn->ctx = nullptr;
    }

    // Create new connection
    struct timeval connect_tv = {
        config_.connect_timeout_ms / 1000,
        (config_.connect_timeout_ms % 1000) * 1000
    };

    conn->ctx = redisConnectWithTimeout(config_.host.c_str(),
                                         config_.port,
                                         connect_tv);

    if (!conn->ctx || conn->ctx->err) {
        Logger::error("Reconnect failed:", conn->ctx ? conn->ctx->errstr : "null context");
        conn->consecutive_errors++;
        return false;
    }

    // Set timeouts
    struct timeval cmd_tv = {
        config_.command_timeout_ms / 1000,
        (config_.command_timeout_ms % 1000) * 1000
    };
    redisSetTimeout(conn->ctx, cmd_tv);

    if (config_.enable_keepalive) {
        redisEnableKeepAlive(conn->ctx);
    }

    conn->consecutive_errors = 0;
    conn->markUsed();

    Logger::info("Reconnect successful");
    return true;
}

void RedisConnectionPool::startHealthCheck(std::chrono::seconds interval) {
    if (health_check_running_.exchange(true)) {
        Logger::warn("Health check already running");
        return;
    }

    Logger::info("Starting health check thread, interval:", interval.count(), "seconds");

    health_thread_ = std::thread([this, interval]() {
        healthCheckLoop(interval);
    });
}

void RedisConnectionPool::stopHealthCheck() {
    if (!health_check_running_.exchange(false)) {
        return;  // Already stopped
    }

    Logger::info("Stopping health check thread...");

    if (health_thread_.joinable()) {
        health_thread_.join();
    }

    Logger::info("Health check thread stopped");
}

void RedisConnectionPool::healthCheckLoop(std::chrono::seconds interval) {
    Logger::info("Health check loop started");

    while (health_check_running_.load(std::memory_order_acquire) &&
           running_.load(std::memory_order_acquire)) {

        std::this_thread::sleep_for(interval);

        std::unique_lock<std::mutex> lock(mutex_);

        Logger::debug("Health check: checking", connections_.size(), "connections");

        int healthy = 0;
        int unhealthy = 0;
        int reconnected = 0;

        for (auto& conn_ptr : connections_) {
            auto conn = conn_ptr.get();

            // Skip connections in use
            if (conn->in_use.load(std::memory_order_acquire)) {
                continue;
            }

            // PING to check health
            lock.unlock();
            redisReply* reply = static_cast<redisReply*>(
                redisCommand(conn->ctx, "PING"));
            lock.lock();

            if (!reply || conn->ctx->err) {
                Logger::warn("Health check failed for connection, attempting reconnect");
                unhealthy++;

                lock.unlock();
                bool ok = reconnectIfNeeded(conn);
                lock.lock();

                if (ok) {
                    reconnected++;
                } else {
                    Logger::error("Reconnect failed during health check");
                }
            } else {
                healthy++;
                conn->consecutive_errors = 0;  // Reset error counter
            }

            if (reply) {
                freeReplyObject(reply);
            }
        }

        if (unhealthy > 0) {
            Logger::info("Health check complete: healthy:", healthy,
                        "unhealthy:", unhealthy,
                        "reconnected:", reconnected);
        } else {
            Logger::debug("Health check complete: all", healthy, "connections healthy");
        }

        // Close idle connections if configured
        if (config_.idle_timeout_sec > 0) {
            lock.unlock();
            closeIdleConnections();
            lock.lock();
        }
    }

    Logger::info("Health check loop exited");
}

void RedisConnectionPool::closeIdleConnections() {
    std::lock_guard<std::mutex> lock(mutex_);

    // Don't shrink below initial pool size
    if (connections_.size() <= config_.pool_size) {
        return;
    }

    int closed = 0;

    auto it = connections_.begin();
    while (it != connections_.end() && connections_.size() > config_.pool_size) {
        auto conn = it->get();

        if (!conn->in_use.load(std::memory_order_acquire) &&
            conn->isIdle(config_.idle_timeout_sec)) {

            Logger::info("Closing idle connection");

            if (conn->ctx) {
                redisFree(conn->ctx);
                conn->ctx = nullptr;
            }

            it = connections_.erase(it);
            closed++;
        } else {
            ++it;
        }
    }

    if (closed > 0) {
        Logger::info("Closed", closed, "idle connections, pool size:", connections_.size());
    }
}

bool RedisConnectionPool::addConnection() {
    std::lock_guard<std::mutex> lock(mutex_);

    if (connections_.size() >= config_.max_pool_size) {
        Logger::warn("Cannot add connection: max_pool_size reached");
        return false;
    }

    auto conn = createConnection();
    if (!conn) {
        Logger::error("Failed to add connection");
        return false;
    }

    connections_.emplace_back(conn);
    available_queue_.push(conn);

    Logger::info("Added connection to pool, new size:", connections_.size());
    cv_.notify_one();

    return true;
}

size_t RedisConnectionPool::size() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return connections_.size();
}

size_t RedisConnectionPool::available() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return available_queue_.size();
}

} // namespace aws_wrapper
