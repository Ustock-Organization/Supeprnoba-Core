#include "redis_client.h"
#include "websocket_server.h"
#include "depth_broadcaster.h"
#include <iostream>
#include <csignal>
#include <cstdlib>

std::atomic<bool> g_running{true};

void signalHandler(int signum) {
    std::cout << "\nShutdown signal received..." << std::endl;
    g_running = false;
}

void printUsage(const char* program) {
    std::cout << "Usage: " << program << " [options]\n"
              << "Options:\n"
              << "  --redis-host=HOST   Valkey/Redis host (default: localhost)\n"
              << "  --redis-port=PORT   Valkey/Redis port (default: 6379)\n"
              << "  --ws-port=PORT      WebSocket server port (default: 8080)\n"
              << "  --poll-interval=MS  Polling interval in ms (default: 100)\n"
              << "  --help              Show this help\n";
}

int main(int argc, char* argv[]) {
    std::string redis_host = "localhost";
    int redis_port = 6379;
    int ws_port = 8080;
    int poll_interval = 100;

    // 커맨드라인 인자 파싱
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg.find("--redis-host=") == 0) {
            redis_host = arg.substr(13);
        } else if (arg.find("--redis-port=") == 0) {
            redis_port = std::stoi(arg.substr(13));
        } else if (arg.find("--ws-port=") == 0) {
            ws_port = std::stoi(arg.substr(10));
        } else if (arg.find("--poll-interval=") == 0) {
            poll_interval = std::stoi(arg.substr(16));
        } else if (arg == "--help") {
            printUsage(argv[0]);
            return 0;
        }
    }

    std::cout << "=== Streamer Configuration ===" << std::endl;
    std::cout << "Redis Host: " << redis_host << ":" << redis_port << std::endl;
    std::cout << "WebSocket Port: " << ws_port << std::endl;
    std::cout << "Poll Interval: " << poll_interval << "ms" << std::endl;

    // 시그널 핸들러 등록
    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);

    try {
        // Redis 클라이언트 초기화
        RedisClient redis(redis_host, redis_port, true);
        if (!redis.connect()) {
            std::cerr << "Failed to connect to Redis" << std::endl;
            return 1;
        }
        std::cout << "Connected to Redis" << std::endl;

        // WebSocket 서버 초기화
        WebSocketServer ws_server(ws_port);
        
        // Depth 브로드캐스터 초기화
        DepthBroadcaster broadcaster(redis, ws_server);

        // 메시지 핸들러 설정
        ws_server.setMessageCallback([&broadcaster](const std::string& conn_id, 
                                                      const std::string& msg) {
            // JSON 파싱하여 subscribe/unsubscribe 처리
            // 예: {"action": "subscribe", "symbols": ["AAPL", "GOOGL"]}
            // 실제 구현에서는 nlohmann/json 사용
            std::cout << "Message from " << conn_id << ": " << msg << std::endl;
        });

        // 서버 시작
        ws_server.start();
        broadcaster.start(poll_interval);

        std::cout << "Streamer running. Press Ctrl+C to stop." << std::endl;

        // 메인 루프
        while (g_running) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }

        // 정리
        broadcaster.stop();
        ws_server.stop();
        redis.disconnect();

        std::cout << "Streamer stopped." << std::endl;

    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << std::endl;
        return 1;
    }

    return 0;
}
