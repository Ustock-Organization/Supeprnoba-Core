#include "websocket_server.h"
#include <boost/beast/core.hpp>
#include <boost/beast/websocket.hpp>
#include <boost/asio/strand.hpp>
#include <iostream>
#include <map>
#include <mutex>
#include <thread>
#include <atomic>

namespace beast = boost::beast;
namespace http = beast::http;
namespace websocket = beast::websocket;
namespace net = boost::asio;
using tcp = boost::asio::ip::tcp;

struct WebSocketServer::Impl {
    int port;
    MessageCallback callback;
    net::io_context ioc{1};
    std::thread worker;
    std::atomic<bool> running{false};
    
    std::map<std::string, std::shared_ptr<websocket::stream<beast::tcp_stream>>> connections;
    std::mutex connections_mutex;
    int connection_counter{0};
    
    Impl(int p) : port(p) {}
};

WebSocketServer::WebSocketServer(int port) 
    : impl_(std::make_unique<Impl>(port)) {}

WebSocketServer::~WebSocketServer() {
    stop();
}

void WebSocketServer::setMessageCallback(MessageCallback callback) {
    impl_->callback = std::move(callback);
}

void WebSocketServer::start() {
    impl_->running = true;
    
    impl_->worker = std::thread([this]() {
        try {
            tcp::acceptor acceptor(impl_->ioc, {tcp::v4(), static_cast<unsigned short>(impl_->port)});
            
            std::cout << "WebSocket server listening on port " << impl_->port << std::endl;
            
            while (impl_->running) {
                tcp::socket socket(impl_->ioc);
                acceptor.accept(socket);
                
                auto ws = std::make_shared<websocket::stream<beast::tcp_stream>>(std::move(socket));
                ws->accept();
                
                std::string conn_id = "conn_" + std::to_string(++impl_->connection_counter);
                
                {
                    std::lock_guard<std::mutex> lock(impl_->connections_mutex);
                    impl_->connections[conn_id] = ws;
                }
                
                std::cout << "New connection: " << conn_id << std::endl;
                
                // 읽기 스레드 시작
                std::thread([this, ws, conn_id]() {
                    try {
                        while (impl_->running) {
                            beast::flat_buffer buffer;
                            ws->read(buffer);
                            
                            std::string msg = beast::buffers_to_string(buffer.data());
                            if (impl_->callback) {
                                impl_->callback(conn_id, msg);
                            }
                        }
                    } catch (const std::exception& e) {
                        std::cout << "Connection closed: " << conn_id << std::endl;
                        std::lock_guard<std::mutex> lock(impl_->connections_mutex);
                        impl_->connections.erase(conn_id);
                    }
                }).detach();
            }
        } catch (const std::exception& e) {
            std::cerr << "Server error: " << e.what() << std::endl;
        }
    });
}

void WebSocketServer::stop() {
    impl_->running = false;
    impl_->ioc.stop();
    if (impl_->worker.joinable()) {
        impl_->worker.join();
    }
}

bool WebSocketServer::sendToConnection(const std::string& connection_id, const std::string& message) {
    std::lock_guard<std::mutex> lock(impl_->connections_mutex);
    
    auto it = impl_->connections.find(connection_id);
    if (it == impl_->connections.end()) {
        return false;
    }
    
    try {
        it->second->write(net::buffer(message));
        return true;
    } catch (const std::exception& e) {
        std::cerr << "Send error to " << connection_id << ": " << e.what() << std::endl;
        impl_->connections.erase(it);
        return false;
    }
}

void WebSocketServer::broadcast(const std::set<std::string>& connection_ids, const std::string& message) {
    for (const auto& id : connection_ids) {
        sendToConnection(id, message);
    }
}

size_t WebSocketServer::connectionCount() const {
    std::lock_guard<std::mutex> lock(impl_->connections_mutex);
    return impl_->connections.size();
}
