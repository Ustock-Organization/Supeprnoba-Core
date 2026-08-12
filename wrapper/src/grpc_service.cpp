#include "grpc_service.h"
#include "logger.h"
#include "config.h"
#include <grpcpp/grpcpp.h>
#include <cstdlib>

namespace aws_wrapper {

GrpcServiceImpl::GrpcServiceImpl(EngineCore* engine, RedisClient* redis)
    : engine_(engine)
    , redis_(redis)
    , auth_token_(Config::get("ENGINE_GRPC_TOKEN", ""))
    , start_time_(std::chrono::steady_clock::now()) {
    if (auth_token_.empty()) {
        Logger::warn("gRPC 관리 채널 인증 비활성 (ENGINE_GRPC_TOKEN 미설정) — "
                     "프로덕션에서는 반드시 설정할 것");
    } else {
        Logger::info("gRPC 관리 채널 인증 활성 (x-engine-token 검증)");
    }
}

bool GrpcServiceImpl::authorize(grpc::ServerContext* context, const char* rpc_name) const {
    if (auth_token_.empty()) {
        return true;  // 미설정 시 허용(하위호환) — 생성자에서 경고 로깅됨
    }
    const auto& md = context->client_metadata();
    auto it = md.find("x-engine-token");
    if (it != md.end() &&
        std::string(it->second.data(), it->second.length()) == auth_token_) {
        return true;
    }
    Logger::warn("gRPC UNAUTHENTICATED:", rpc_name, "(토큰 누락/불일치)");
    return false;
}

grpc::Status GrpcServiceImpl::CreateSnapshot(grpc::ServerContext* context,
                                               const SnapshotRequest* request,
                                               SnapshotResponse* response) {
    if (!authorize(context, "CreateSnapshot"))
        return grpc::Status(grpc::StatusCode::UNAUTHENTICATED, "invalid or missing x-engine-token");
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
    if (!authorize(context, "RestoreSnapshot"))
        return grpc::Status(grpc::StatusCode::UNAUTHENTICATED, "invalid or missing x-engine-token");
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
    if (!authorize(context, "RemoveOrderBook"))
        return grpc::Status(grpc::StatusCode::UNAUTHENTICATED, "invalid or missing x-engine-token");
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

grpc::Status GrpcServiceImpl::CancelAllOrders(
    grpc::ServerContext* context,
    const CancelAllRequest* request,
    CancelAllResponse* response) {

    const std::string& symbol = request->symbol();

    if (symbol.empty()) {
        response->set_success(false);
        response->set_error("symbol is required");
        return grpc::Status::OK;
    }

    if (!authorize(context, "CancelAllOrders"))
        return grpc::Status(grpc::StatusCode::UNAUTHENTICATED, "invalid or missing x-engine-token");
    Logger::info("gRPC CancelAllOrders:", symbol);

    try {
        auto result = engine_->cancelAllOrders(symbol);
        response->set_success(true);
        response->set_cancelled_count(result.cancelled_count);
        for (const auto& id : result.failed_order_ids) {
            response->add_failed_order_ids(id);
        }
        Logger::info("gRPC CancelAllOrders completed:", symbol,
                     "cancelled:", result.cancelled_count);
    } catch (const std::exception& e) {
        response->set_success(false);
        response->set_error(e.what());
        Logger::error("gRPC CancelAllOrders failed:", symbol, e.what());
    }

    return grpc::Status::OK;
}

grpc::Status GrpcServiceImpl::CancelOrder(
    grpc::ServerContext* context,
    const CancelOrderRequest* request,
    CancelOrderResponse* response) {

    const std::string& symbol = request->symbol();
    const std::string& order_id = request->order_id();

    if (symbol.empty() || order_id.empty()) {
        response->set_success(false);
        response->set_error("symbol and order_id are required");
        return grpc::Status::OK;
    }

    if (!authorize(context, "CancelOrder"))
        return grpc::Status(grpc::StatusCode::UNAUTHENTICATED, "invalid or missing x-engine-token");
    Logger::info("gRPC CancelOrder:", symbol, order_id);

    try {
        bool cancelled = engine_->cancelOrder(symbol, order_id);
        response->set_success(cancelled);
        if (!cancelled) {
            response->set_error("Order not found or already cancelled");
        }
        Logger::info("gRPC CancelOrder result:", symbol, order_id,
                     cancelled ? "success" : "not found");
    } catch (const std::exception& e) {
        response->set_success(false);
        response->set_error(e.what());
        Logger::error("gRPC CancelOrder failed:", symbol, order_id, e.what());
    }

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
