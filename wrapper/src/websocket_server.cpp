#include "websocket_server.h"
#include "logger.h"
#include "config.h"

#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <openssl/sha.h>
#include <openssl/bio.h>
#include <openssl/evp.h>
#include <openssl/buffer.h>
#include <sstream>
#include <cstring>
#include <random>
#include <regex>

namespace aws_wrapper {

// WebSocket magic GUID for handshake
static const std::string WS_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Base64 encode helper
static std::string base64Encode(const unsigned char* data, size_t len) {
    BIO* bio = BIO_new(BIO_f_base64());
    BIO* bmem = BIO_new(BIO_s_mem());
    bio = BIO_push(bio, bmem);
    BIO_set_flags(bio, BIO_FLAGS_BASE64_NO_NL);
    BIO_write(bio, data, len);
    BIO_flush(bio);
    
    BUF_MEM* bptr;
    BIO_get_mem_ptr(bio, &bptr);
    std::string result(bptr->data, bptr->length);
    BIO_free_all(bio);
    return result;
}

WebSocketServer::WebSocketServer(int port) : port_(port) {
    Logger::info("WebSocketServer created on port:", port);
}

WebSocketServer::~WebSocketServer() {
    stop();
}

std::string WebSocketServer::generateConnectionId() {
    static std::random_device rd;
    static std::mt19937 gen(rd());
    static std::uniform_int_distribution<> dis(0, 15);
    
    std::stringstream ss;
    ss << std::hex;
    for (int i = 0; i < 16; ++i) {
        ss << dis(gen);
    }
    return ss.str();
}

void WebSocketServer::start() {
    if (running_) return;
    
    // Create socket
    server_fd_ = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd_ < 0) {
        Logger::error("Failed to create socket");
        return;
    }
    
    // Set socket options
    int opt = 1;
    setsockopt(server_fd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    
    // Bind
    struct sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port_);
    
    if (bind(server_fd_, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        Logger::error("Failed to bind to port:", port_);
        close(server_fd_);
        return;
    }
    
    // Listen
    if (listen(server_fd_, 10) < 0) {
        Logger::error("Failed to listen");
        close(server_fd_);
        return;
    }
    
    running_ = true;
    accept_thread_ = std::thread(&WebSocketServer::acceptLoop, this);
    
    Logger::info("WebSocketServer started on port:", port_);
}

void WebSocketServer::stop() {
    if (!running_) return;
    
    running_ = false;
    
    // Close all client connections
    {
        std::lock_guard<std::mutex> lock(mutex_);
        for (auto& [connId, fd] : conn_to_fd_) {
            close(fd);
        }
        conn_to_fd_.clear();
        fd_to_conn_.clear();
    }
    
    // Close server socket
    if (server_fd_ >= 0) {
        close(server_fd_);
        server_fd_ = -1;
    }
    
    if (accept_thread_.joinable()) {
        accept_thread_.join();
    }
    
    Logger::info("WebSocketServer stopped");
}

void WebSocketServer::acceptLoop() {
    while (running_) {
        struct sockaddr_in client_addr;
        socklen_t client_len = sizeof(client_addr);
        
        int client_fd = accept(server_fd_, (struct sockaddr*)&client_addr, &client_len);
        if (client_fd < 0) {
            if (running_) {
                Logger::error("Accept failed");
            }
            continue;
        }
        
        // Handle client in new thread
        std::thread([this, client_fd]() {
            handleClient(client_fd);
        }).detach();
    }
}

bool WebSocketServer::performHandshake(int client_fd, std::string& connId) {
    char buffer[4096];
    ssize_t n = recv(client_fd, buffer, sizeof(buffer) - 1, 0);
    if (n <= 0) return false;
    buffer[n] = '\0';
    
    std::string request(buffer);
    
    // Find Sec-WebSocket-Key
    std::regex key_regex("Sec-WebSocket-Key: ([^\r\n]+)");
    std::smatch match;
    if (!std::regex_search(request, match, key_regex)) {
        return false;
    }
    
    std::string ws_key = match[1].str();
    
    // Generate accept key
    std::string accept_key = ws_key + WS_MAGIC_GUID;
    unsigned char hash[SHA_DIGEST_LENGTH];
    SHA1((unsigned char*)accept_key.c_str(), accept_key.length(), hash);
    std::string accept_value = base64Encode(hash, SHA_DIGEST_LENGTH);
    
    // Send handshake response
    std::ostringstream response;
    response << "HTTP/1.1 101 Switching Protocols\r\n"
             << "Upgrade: websocket\r\n"
             << "Connection: Upgrade\r\n"
             << "Sec-WebSocket-Accept: " << accept_value << "\r\n"
             << "\r\n";
    
    std::string resp_str = response.str();
    send(client_fd, resp_str.c_str(), resp_str.length(), 0);
    
    connId = generateConnectionId();
    return true;
}

void WebSocketServer::handleClient(int client_fd) {
    std::string connId;
    
    if (!performHandshake(client_fd, connId)) {
        close(client_fd);
        return;
    }
    
    // Register connection
    {
        std::lock_guard<std::mutex> lock(mutex_);
        conn_to_fd_[connId] = client_fd;
        fd_to_conn_[client_fd] = connId;
    }
    
    if (on_connect_) {
        on_connect_(connId);
    }
    
    Logger::info("WebSocket client connected:", connId);
    
    // Read loop
    while (running_) {
        unsigned char header[2];
        ssize_t n = recv(client_fd, header, 2, 0);
        if (n <= 0) break;
        
        bool fin = (header[0] & 0x80) != 0;
        int opcode = header[0] & 0x0F;
        bool masked = (header[1] & 0x80) != 0;
        uint64_t payload_len = header[1] & 0x7F;
        
        // Extended payload length
        if (payload_len == 126) {
            unsigned char ext[2];
            recv(client_fd, ext, 2, 0);
            payload_len = (ext[0] << 8) | ext[1];
        } else if (payload_len == 127) {
            unsigned char ext[8];
            recv(client_fd, ext, 8, 0);
            payload_len = 0;
            for (int i = 0; i < 8; ++i) {
                payload_len = (payload_len << 8) | ext[i];
            }
        }
        
        // Masking key
        unsigned char mask[4] = {0};
        if (masked) {
            recv(client_fd, mask, 4, 0);
        }
        
        // Payload
        std::vector<char> payload(payload_len);
        if (payload_len > 0) {
            recv(client_fd, payload.data(), payload_len, 0);
            if (masked) {
                for (size_t i = 0; i < payload_len; ++i) {
                    payload[i] ^= mask[i % 4];
                }
            }
        }
        
        // Handle opcodes
        if (opcode == 0x8) {  // Close
            break;
        } else if (opcode == 0x9) {  // Ping
            // Send pong
            unsigned char pong[2] = {0x8A, 0x00};
            send(client_fd, pong, 2, 0);
        } else if (opcode == 0x1 || opcode == 0x2) {  // Text or Binary
            std::string message(payload.begin(), payload.end());
            
            // Parse message for subscription commands
            try {
                auto j = nlohmann::json::parse(message);
                std::string action = j.value("action", "");
                
                if (action == "subscribe") {
                    std::string symbol = j.value("symbol", "");
                    if (!symbol.empty()) {
                        subscribe(connId, symbol);
                    }
                } else if (action == "unsubscribe") {
                    std::string symbol = j.value("symbol", "");
                    if (!symbol.empty()) {
                        unsubscribe(connId, symbol);
                    }
                } else if (on_message_) {
                    on_message_(connId, message);
                }
            } catch (...) {
                if (on_message_) {
                    on_message_(connId, message);
                }
            }
        }
    }
    
    // Cleanup
    if (on_disconnect_) {
        on_disconnect_(connId);
    }
    
    removeConnection(connId);
    close(client_fd);
    
    Logger::info("WebSocket client disconnected:", connId);
}

void WebSocketServer::sendFrame(int fd, const std::string& data) {
    std::vector<unsigned char> frame;
    
    // Opcode: text frame
    frame.push_back(0x81);
    
    // Payload length
    if (data.length() < 126) {
        frame.push_back(static_cast<unsigned char>(data.length()));
    } else if (data.length() < 65536) {
        frame.push_back(126);
        frame.push_back((data.length() >> 8) & 0xFF);
        frame.push_back(data.length() & 0xFF);
    } else {
        frame.push_back(127);
        for (int i = 7; i >= 0; --i) {
            frame.push_back((data.length() >> (i * 8)) & 0xFF);
        }
    }
    
    // Payload
    frame.insert(frame.end(), data.begin(), data.end());
    
    send(fd, frame.data(), frame.size(), 0);
}

void WebSocketServer::addConnection(const ConnectionId& connId, const std::string& userId) {
    std::lock_guard<std::mutex> lock(mutex_);
    conn_to_user_[connId] = userId;
    user_conns_[userId].insert(connId);
}

void WebSocketServer::removeConnection(const ConnectionId& connId) {
    std::lock_guard<std::mutex> lock(mutex_);
    
    // Remove from user mapping
    auto user_it = conn_to_user_.find(connId);
    if (user_it != conn_to_user_.end()) {
        user_conns_[user_it->second].erase(connId);
        conn_to_user_.erase(user_it);
    }
    
    // Remove subscriptions
    auto sub_it = conn_subscriptions_.find(connId);
    if (sub_it != conn_subscriptions_.end()) {
        for (const auto& symbol : sub_it->second) {
            symbol_subscribers_[symbol].erase(connId);
        }
        conn_subscriptions_.erase(sub_it);
    }
    
    // Remove fd mapping
    auto fd_it = conn_to_fd_.find(connId);
    if (fd_it != conn_to_fd_.end()) {
        fd_to_conn_.erase(fd_it->second);
        conn_to_fd_.erase(fd_it);
    }
}

size_t WebSocketServer::getConnectionCount() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return conn_to_fd_.size();
}

void WebSocketServer::subscribe(const ConnectionId& connId, const std::string& symbol) {
    std::lock_guard<std::mutex> lock(mutex_);
    conn_subscriptions_[connId].insert(symbol);
    symbol_subscribers_[symbol].insert(connId);
    Logger::debug("Connection", connId, "subscribed to", symbol);
}

void WebSocketServer::unsubscribe(const ConnectionId& connId, const std::string& symbol) {
    std::lock_guard<std::mutex> lock(mutex_);
    conn_subscriptions_[connId].erase(symbol);
    symbol_subscribers_[symbol].erase(connId);
}

void WebSocketServer::pushToConnection(const ConnectionId& connId, const nlohmann::json& message) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = conn_to_fd_.find(connId);
    if (it != conn_to_fd_.end()) {
        sendFrame(it->second, message.dump());
    }
}

void WebSocketServer::pushToSymbol(const std::string& symbol, const nlohmann::json& message) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = symbol_subscribers_.find(symbol);
    if (it != symbol_subscribers_.end()) {
        std::string msg_str = message.dump();
        for (const auto& connId : it->second) {
            auto fd_it = conn_to_fd_.find(connId);
            if (fd_it != conn_to_fd_.end()) {
                sendFrame(fd_it->second, msg_str);
            }
        }
    }
}

void WebSocketServer::pushToUser(const std::string& userId, const nlohmann::json& message) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = user_conns_.find(userId);
    if (it != user_conns_.end()) {
        std::string msg_str = message.dump();
        for (const auto& connId : it->second) {
            auto fd_it = conn_to_fd_.find(connId);
            if (fd_it != conn_to_fd_.end()) {
                sendFrame(fd_it->second, msg_str);
            }
        }
    }
}

void WebSocketServer::broadcast(const nlohmann::json& message) {
    std::lock_guard<std::mutex> lock(mutex_);
    std::string msg_str = message.dump();
    for (const auto& [connId, fd] : conn_to_fd_) {
        sendFrame(fd, msg_str);
    }
}

// ============================================================
// API Gateway Pusher (placeholder - requires curl or AWS SDK)
// ============================================================

ApiGatewayPusher::ApiGatewayPusher(const std::string& endpoint, const std::string& region)
    : endpoint_(endpoint), region_(region) {
    Logger::info("ApiGatewayPusher created, endpoint:", endpoint);
}

bool ApiGatewayPusher::pushToConnection(const std::string& connectionId, 
                                         const nlohmann::json& message) {
    // TODO: Implement using libcurl with AWS SigV4 signing
    // POST https://{api-id}.execute-api.{region}.amazonaws.com/{stage}/@connections/{connection_id}
    Logger::debug("ApiGatewayPusher::pushToConnection", connectionId);
    return true;
}

bool ApiGatewayPusher::deleteConnection(const std::string& connectionId) {
    // TODO: Implement using libcurl with AWS SigV4 signing
    // DELETE https://{api-id}.execute-api.{region}.amazonaws.com/{stage}/@connections/{connection_id}
    Logger::debug("ApiGatewayPusher::deleteConnection", connectionId);
    return true;
}

} // namespace aws_wrapper
