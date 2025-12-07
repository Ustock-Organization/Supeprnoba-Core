#include "grpc_service.h"
#include "logger.h"
#include <grpcpp/grpcpp.h>

namespace aws_wrapper {

GrpcServiceImpl::GrpcServiceImpl(EngineCore* engine, RedisClient* redis)
    : engine_(engine)
    , redis_(redis)
    , start_time_(std::chrono::steady_clock::now()) {
}

grpc::Status GrpcServiceImpl::CreateSnapshot(grpc::ServerContext* context,
                                               const SnapshotRequest* request,
                                               SnapshotResponse* response) {
    Logger::info("gRPC CreateSnapshot:", request->symbol());
    
    std::string data = engine_->snapshotOrderBook(request->symbol());
    
    if (data.empty()) {
        response->set_success(false);
        response->set_error("Symbol not found or empty orderbook");
        return grpc::Status::OK;
    }
    
    // Redis에 저장
    if (redis_ && redis_->isConnected()) {
        redis_->saveSnapshot(request->symbol(), data);
    }
    
    response->set_success(true);
    response->set_data(data);
    return grpc::Status::OK;
}

grpc::Status GrpcServiceImpl::RestoreSnapshot(grpc::ServerContext* context,
                                                const RestoreRequest* request,
                                                RestoreResponse* response) {
    Logger::info("gRPC RestoreSnapshot:", request->symbol());
    
    std::string data = request->data();
    
    // Redis에서 로드 시도 (data가 비어있으면)
    if (data.empty() && redis_ && redis_->isConnected()) {
        auto cached = redis_->loadSnapshot(request->symbol());
        if (cached) {
            data = *cached;
        }
    }
    
    if (data.empty()) {
        response->set_success(false);
        response->set_error("No snapshot data provided or found in cache");
        return grpc::Status::OK;
    }
    
    bool success = engine_->restoreOrderBook(request->symbol(), data);
    response->set_success(success);
    if (!success) {
        response->set_error("Failed to restore orderbook");
    }
    
    return grpc::Status::OK;
}

grpc::Status GrpcServiceImpl::RemoveOrderBook(grpc::ServerContext* context,
                                                const RemoveRequest* request,
                                                RemoveResponse* response) {
    Logger::info("gRPC RemoveOrderBook:", request->symbol());
    
    bool success = engine_->removeOrderBook(request->symbol());
    response->set_success(success);
    
    return grpc::Status::OK;
}

grpc::Status GrpcServiceImpl::HealthCheck(grpc::ServerContext* context,
                                            const Empty* request,
                                            HealthResponse* response) {
    auto now = std::chrono::steady_clock::now();
    auto uptime = std::chrono::duration_cast<std::chrono::seconds>(
        now - start_time_).count();
    
    response->set_healthy(true);
    response->set_uptime_seconds(uptime);
    response->set_symbol_count(engine_->getSymbolCount());
    response->set_orders_processed(engine_->getTotalOrdersProcessed());
    response->set_trades_executed(engine_->getTotalTradesExecuted());
    
    return grpc::Status::OK;
}

// GrpcService implementation
GrpcService::GrpcService(EngineCore* engine, RedisClient* redis)
    : service_(std::make_unique<GrpcServiceImpl>(engine, redis)) {
}

GrpcService::~GrpcService() {
    stop();
}

void GrpcService::start(int port) {
    if (running_) return;
    
    std::string server_address = "0.0.0.0:" + std::to_string(port);
    
    grpc::ServerBuilder builder;
    builder.AddListeningPort(server_address, grpc::InsecureServerCredentials());
    builder.RegisterService(service_.get());
    
    server_ = builder.BuildAndStart();
    running_ = true;
    
    Logger::info("gRPC server started on port:", port);
    
    server_thread_ = std::thread([this]() {
        server_->Wait();
    });
}

void GrpcService::stop() {
    if (!running_) return;
    
    running_ = false;
    if (server_) {
        server_->Shutdown();
    }
    if (server_thread_.joinable()) {
        server_thread_.join();
    }
    
    Logger::info("gRPC server stopped");
}

} // namespace aws_wrapper
