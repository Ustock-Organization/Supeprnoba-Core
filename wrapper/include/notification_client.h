#pragma once

#include <string>
#include <queue>
#include <mutex>
#include <condition_variable>
#include <thread>
#include <atomic>
#include <memory>
#include <functional>

#include <aws/core/Aws.h>
#include <aws/apigatewaymanagementapi/ApiGatewayManagementApiClient.h>

namespace aws_wrapper {

// 큐 최대 크기 제한 (메모리 누수 방지)
constexpr size_t MAX_QUEUE_SIZE = 10000;

class RedisClient;  // Forward declaration

// 알림 메시지 구조체
struct NotificationMessage {
    std::string user_id;
    std::string order_id;
    std::string symbol;
    std::string side;        // BUY, SELL
    uint64_t    price;
    uint64_t    quantity;
    std::string order_type;  // LIMIT, MARKET
    uint64_t    filled_qty;  // 이번 체결 수량 (FILL일 경우)
    uint64_t    filled_price;// 이번 체결 가격 (FILL일 경우)
    std::string status;      // ACCEPTED, REJECTED, FILLED, CANCELLED, PARTIAL_FILL
    std::string reason;      // 거부/취소 사유 (선택)
    int64_t timestamp;
};

/**
 * @brief WebSocket 알림을 비동기로 전송하는 클라이언트
 * 
 * 메인 스레드(매칭 엔진)를 블로킹하지 않도록 백그라운드 스레드에서 전송합니다.
 */
class NotificationClient {
public:
    NotificationClient(RedisClient* redis);
    ~NotificationClient();
    
    // 초기화 (AWS 클라이언트 생성)
    bool initialize(const std::string& websocket_endpoint, const std::string& region = "ap-northeast-2");
    
    // 종료 (백그라운드 스레드 정지)
    void shutdown();
    
    // 주문 상태 알림 큐에 추가 (비블로킹, 빠름)
    void enqueue(const NotificationMessage& msg);
    
    // 편의 메서드
    void sendOrderStatus(const std::string& user_id,
                         const std::string& order_id,
                         const std::string& symbol,
                         const std::string& side,
                         uint64_t price,
                         uint64_t quantity,
                         const std::string& order_type,
                         uint64_t filled_qty,
                         uint64_t filled_price,
                         const std::string& status,
                         const std::string& reason = "");

private:
    // 백그라운드 워커 스레드 함수
    void workerLoop();
    
    // 실제 WebSocket 전송
    bool sendToConnection(const std::string& connection_id, const std::string& payload);
    
    // Redis 연결 조회
    std::vector<std::string> getUserConnections(const std::string& user_id);

private:
    RedisClient* redis_;
    std::unique_ptr<Aws::ApiGatewayManagementApi::ApiGatewayManagementApiClient> api_client_;
    
    // 스레드-세이프 큐
    std::queue<NotificationMessage> queue_;
    std::mutex queue_mutex_;
    std::condition_variable queue_cv_;
    
    // 워커 스레드
    std::thread worker_thread_;
    std::atomic<bool> running_{false};
    
    std::string websocket_endpoint_;
};

}  // namespace aws_wrapper
