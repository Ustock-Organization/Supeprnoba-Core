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

private:
    EngineCore* engine_;
    RedisClient* redis_;
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
