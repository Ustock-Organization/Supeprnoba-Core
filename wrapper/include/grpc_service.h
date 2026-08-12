#pragma once

#include <grpcpp/grpcpp.h>
#include "snapshot.grpc.pb.h"
#include "engine_core.h"
#include "redis_client.h"
#include <thread>
#include <atomic>
#include <memory>

namespace aws_wrapper {

class GrpcServiceImpl final : public SnapshotService::Service {
public:
    GrpcServiceImpl(EngineCore* engine, RedisClient* redis);
    
    grpc::Status CreateSnapshot(grpc::ServerContext* context,
                                 const SnapshotRequest* request,
                                 SnapshotResponse* response) override;
    
    grpc::Status RestoreSnapshot(grpc::ServerContext* context,
                                  const RestoreRequest* request,
                                  RestoreResponse* response) override;
    
    grpc::Status RemoveOrderBook(grpc::ServerContext* context,
                                  const RemoveRequest* request,
                                  RemoveResponse* response) override;
    
    grpc::Status HealthCheck(grpc::ServerContext* context,
                              const Empty* request,
                              HealthResponse* response) override;

    grpc::Status CancelAllOrders(grpc::ServerContext* context,
                                  const CancelAllRequest* request,
                                  CancelAllResponse* response) override;

    grpc::Status CancelOrder(grpc::ServerContext* context,
                              const CancelOrderRequest* request,
                              CancelOrderResponse* response) override;

private:
    // 관리 채널 인증: 메타데이터 x-engine-token이 공유 시크릿과 일치하는지 확인.
    // ENGINE_GRPC_TOKEN 미설정 시 경고 후 허용(하위호환), 설정 시 강제.
    // 파괴적 RPC(CancelAllOrders/RemoveOrderBook 등)를 무인증 노출로부터 보호.
    bool authorize(grpc::ServerContext* context, const char* rpc_name) const;

    EngineCore* engine_;
    RedisClient* redis_;
    std::string auth_token_;
    std::chrono::steady_clock::time_point start_time_;
};

class GrpcService {
public:
    GrpcService(EngineCore* engine, RedisClient* redis);
    ~GrpcService();
    
    void start(int port);
    void stop();
    
private:
    std::unique_ptr<grpc::Server> server_;
    std::unique_ptr<GrpcServiceImpl> service_;
    std::thread server_thread_;
    std::atomic<bool> running_{false};
};

} // namespace aws_wrapper
