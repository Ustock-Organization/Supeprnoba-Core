#include "notification_client.h"
#include "redis_client.h"
#include "logger.h"
#include "config.h"

#include <aws/core/utils/json/JsonSerializer.h>
#include <aws/apigatewaymanagementapi/model/PostToConnectionRequest.h>

namespace aws_wrapper {

NotificationClient::NotificationClient(RedisClient* redis)
    : redis_(redis) {
}

NotificationClient::~NotificationClient() {
    shutdown();
}

bool NotificationClient::initialize(const std::string& websocket_endpoint, const std::string& region) {
    websocket_endpoint_ = websocket_endpoint;
    
    if (websocket_endpoint_.empty()) {
        Logger::warn("NotificationClient: WebSocket endpoint not configured, notifications disabled");
        return false;
    }
    
    // wss:// -> https:// 변환
    std::string https_endpoint = websocket_endpoint_;
    if (https_endpoint.find("wss://") == 0) {
        https_endpoint = "https://" + https_endpoint.substr(6);
    } else if (https_endpoint.find("ws://") == 0) {
        https_endpoint = "http://" + https_endpoint.substr(5);
    }
    
    // 끝에 슬래시 제거
    if (!https_endpoint.empty() && https_endpoint.back() == '/') {
        https_endpoint.pop_back();
    }
    
    Logger::info("NotificationClient: Initializing with endpoint:", https_endpoint);
    
    // AWS 클라이언트 설정
    Aws::Client::ClientConfiguration config;
    config.region = region;
    config.endpointOverride = https_endpoint;
    config.connectTimeoutMs = 3000;
    config.requestTimeoutMs = 5000;
    
    api_client_ = std::make_unique<Aws::ApiGatewayManagementApi::ApiGatewayManagementApiClient>(config);
    
    // 워커 스레드 시작
    running_ = true;
    worker_thread_ = std::thread(&NotificationClient::workerLoop, this);
    
    Logger::info("NotificationClient: Background worker started");
    return true;
}

void NotificationClient::shutdown() {
    if (running_) {
        running_ = false;
        queue_cv_.notify_all();
        
        if (worker_thread_.joinable()) {
            worker_thread_.join();
        }
        
        Logger::info("NotificationClient: Shutdown complete");
    }
}

void NotificationClient::enqueue(const NotificationMessage& msg) {
    {
        std::lock_guard<std::mutex> lock(queue_mutex_);
        if (queue_.size() >= MAX_QUEUE_SIZE) {
            Logger::warn("NotificationClient queue full, dropping message");
            return;
        }
        queue_.push(msg);
    }
    queue_cv_.notify_one();
}

void NotificationClient::sendOrderStatus(const std::string& user_id,
                                         const std::string& order_id,
                                         const std::string& symbol,
                                         const std::string& side,
                                         uint64_t price,
                                         uint64_t quantity,
                                         const std::string& order_type,
                                         uint64_t filled_qty,
                                         uint64_t filled_price,
                                         const std::string& status,
                                         const std::string& reason) {
    NotificationMessage msg;
    msg.user_id = user_id;
    msg.order_id = order_id;
    msg.symbol = symbol;
    msg.side = side;
    msg.price = price;
    msg.quantity = quantity;
    msg.order_type = order_type;
    msg.filled_qty = filled_qty;
    msg.filled_price = filled_price;
    msg.status = status;
    msg.reason = reason;
    msg.timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()
    ).count();
    
    enqueue(msg);
}

void NotificationClient::workerLoop() {
    Logger::info("NotificationClient: Worker thread running");
    
    while (running_) {
        NotificationMessage msg;
        
        // 큐에서 메시지 대기
        {
            std::unique_lock<std::mutex> lock(queue_mutex_);
            queue_cv_.wait(lock, [this] { return !queue_.empty() || !running_; });
            
            if (!running_ && queue_.empty()) {
                break;
            }
            
            if (!queue_.empty()) {
                msg = queue_.front();
                queue_.pop();
            } else {
                continue;
            }
        }
        
        // Redis에서 사용자 연결 목록 조회
        auto connections = getUserConnections(msg.user_id);
        
        if (connections.empty()) {
            Logger::debug("NotificationClient: No connections for user", msg.user_id);
            continue;
        }
        
        // JSON 페이로드 생성
        Aws::Utils::Json::JsonValue payload;
        payload.WithString("type", "ORDER_STATUS");
        
        Aws::Utils::Json::JsonValue data;
        data.WithString("order_id", msg.order_id);
        data.WithString("symbol", msg.symbol);
        data.WithString("side", msg.side);
        data.WithInt64("price", msg.price);
        data.WithInt64("quantity", msg.quantity);
        data.WithString("type", msg.order_type);
        data.WithInt64("filled_qty", msg.filled_qty);
        data.WithInt64("filled_price", msg.filled_price);
        data.WithString("status", msg.status);
        if (!msg.reason.empty()) {
            data.WithString("reason", msg.reason);
        }
        data.WithInt64("timestamp", msg.timestamp);
        
        payload.WithObject("data", data);
        
        std::string payload_str = payload.View().WriteCompact();
        
        // 모든 연결에 전송
        int sent = 0;
        for (const auto& conn_id : connections) {
            if (sendToConnection(conn_id, payload_str)) {
                sent++;
            }
        }
        
        Logger::debug("NotificationClient: Sent", msg.status, "to", sent, "/", connections.size(), 
                      "connections for user", msg.user_id);
    }
    
    Logger::info("NotificationClient: Worker thread stopped");
}

bool NotificationClient::sendToConnection(const std::string& connection_id, const std::string& payload) {
    if (!api_client_) {
        return false;
    }
    
    try {
        Aws::ApiGatewayManagementApi::Model::PostToConnectionRequest request;
        request.SetConnectionId(connection_id);
        
        // 바이너리 데이터로 변환
        auto data = Aws::Utils::ByteBuffer(
            reinterpret_cast<const unsigned char*>(payload.c_str()),
            payload.size()
        );
        request.SetBody(std::make_shared<Aws::StringStream>(payload));
        
        auto outcome = api_client_->PostToConnection(request);
        
        if (!outcome.IsSuccess()) {
            auto& error = outcome.GetError();
            if (error.GetResponseCode() == Aws::Http::HttpResponseCode::GONE) {
                // 연결 끊김 - Redis에서 정리 (선택적)
                Logger::debug("NotificationClient: Connection gone:", connection_id);
            } else {
                Logger::warn("NotificationClient: PostToConnection failed:", 
                            error.GetMessage());
            }
            return false;
        }
        
        return true;
    } catch (const std::exception& e) {
        Logger::error("NotificationClient: Exception:", e.what());
        return false;
    }
}

std::vector<std::string> NotificationClient::getUserConnections(const std::string& user_id) {
    std::vector<std::string> result;
    
    if (!redis_) {
        return result;
    }
    
    try {
        // Redis SMEMBERS 호출: user:{user_id}:connections
        std::string key = "user:" + user_id + ":connections";
        result = redis_->smembers(key);
    } catch (const std::exception& e) {
        Logger::error("NotificationClient: Redis error:", e.what());
    }
    
    return result;
}

}  // namespace aws_wrapper
