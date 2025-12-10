#pragma once

#include <string>
#include <functional>
#include <memory>
#include <set>

class WebSocketServer {
public:
    using MessageCallback = std::function<void(const std::string& connection_id, 
                                                const std::string& message)>;

    WebSocketServer(int port = 8080);
    ~WebSocketServer();

    void setMessageCallback(MessageCallback callback);
    
    void start();
    void stop();
    
    // 특정 연결에 메시지 전송
    bool sendToConnection(const std::string& connection_id, const std::string& message);
    
    // 여러 연결에 브로드캐스트
    void broadcast(const std::set<std::string>& connection_ids, const std::string& message);
    
    // 연결된 클라이언트 수
    size_t connectionCount() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
