#pragma once

#include <string>
#include <map>
#include <set>
#include <mutex>
#include <thread>
#include <atomic>
#include <functional>
#include <nlohmann/json.hpp>

// Simple WebSocket implementation using POSIX sockets
// For production, consider using Boost.Beast or libwebsockets

namespace aws_wrapper {

/**
 * WebSocket Server for real-time client notifications
 * 
 * Clients connect via WebSocket and subscribe to symbols.
 * When trades/fills occur, they receive push notifications.
 * 
 * Also supports API Gateway Management API for pushing to
 * connected WebSocket clients via AWS Lambda.
 */
class WebSocketServer {
public:
    using ConnectionId = std::string;
    using MessageHandler = std::function<void(const ConnectionId&, const std::string&)>;
    
    WebSocketServer(int port = 8080);
    ~WebSocketServer();
    
    // Server lifecycle
    void start();
    void stop();
    bool isRunning() const { return running_; }
    
    // Connection management
    void addConnection(const ConnectionId& connId, const std::string& userId);
    void removeConnection(const ConnectionId& connId);
    size_t getConnectionCount() const;
    
    // Subscription management (symbol-based)
    void subscribe(const ConnectionId& connId, const std::string& symbol);
    void unsubscribe(const ConnectionId& connId, const std::string& symbol);
    
    // Push notifications
    void pushToConnection(const ConnectionId& connId, const nlohmann::json& message);
    void pushToSymbol(const std::string& symbol, const nlohmann::json& message);
    void pushToUser(const std::string& userId, const nlohmann::json& message);
    void broadcast(const nlohmann::json& message);
    
    // Event handlers
    void setOnConnect(std::function<void(const ConnectionId&)> handler) {
        on_connect_ = std::move(handler);
    }
    void setOnDisconnect(std::function<void(const ConnectionId&)> handler) {
        on_disconnect_ = std::move(handler);
    }
    void setOnMessage(MessageHandler handler) {
        on_message_ = std::move(handler);
    }
    
private:
    int port_;
    int server_fd_ = -1;
    std::atomic<bool> running_{false};
    std::thread accept_thread_;
    
    // Connection state
    mutable std::mutex mutex_;
    std::map<ConnectionId, int> conn_to_fd_;          // connectionId -> socket fd
    std::map<int, ConnectionId> fd_to_conn_;          // socket fd -> connectionId
    std::map<ConnectionId, std::string> conn_to_user_; // connectionId -> userId
    std::map<std::string, std::set<ConnectionId>> user_conns_; // userId -> connections
    
    // Subscriptions
    std::map<ConnectionId, std::set<std::string>> conn_subscriptions_; // conn -> symbols
    std::map<std::string, std::set<ConnectionId>> symbol_subscribers_; // symbol -> conns
    
    // Handlers
    std::function<void(const ConnectionId&)> on_connect_;
    std::function<void(const ConnectionId&)> on_disconnect_;
    MessageHandler on_message_;
    
    void acceptLoop();
    void handleClient(int client_fd);
    bool performHandshake(int client_fd, std::string& connId);
    void sendFrame(int fd, const std::string& data);
    std::string generateConnectionId();
};

/**
 * API Gateway Management API Client
 * 
 * For pushing messages to WebSocket connections managed by
 * AWS API Gateway WebSocket API.
 */
class ApiGatewayPusher {
public:
    ApiGatewayPusher(const std::string& endpoint, const std::string& region);
    
    // Push message to a specific connection
    bool pushToConnection(const std::string& connectionId, const nlohmann::json& message);
    
    // Delete a stale connection
    bool deleteConnection(const std::string& connectionId);
    
private:
    std::string endpoint_;  // e.g., "abc123.execute-api.ap-northeast-2.amazonaws.com/prod"
    std::string region_;
    
    std::string signRequest(const std::string& method, 
                            const std::string& path, 
                            const std::string& body);
};

} // namespace aws_wrapper
