#include "dynamodb_client.h"
#include "logger.h"

#include <aws/core/Aws.h>
#include <aws/dynamodb/DynamoDBClient.h>
#include <aws/dynamodb/model/ScanRequest.h>
#include <aws/dynamodb/model/QueryRequest.h>
#include <aws/dynamodb/model/AttributeValue.h>

namespace aws_wrapper {

struct DynamoDBClient::Impl {
    std::unique_ptr<Aws::DynamoDB::DynamoDBClient> client;
};

DynamoDBClient::DynamoDBClient(const std::string& region)
    : impl_(std::make_unique<Impl>())
    , region_(region) {
}

DynamoDBClient::~DynamoDBClient() = default;

bool DynamoDBClient::initialize() {
    if (initialized_) {
        return true;
    }

    try {
        Aws::Client::ClientConfiguration config;
        config.region = region_;
        config.connectTimeoutMs = 5000;
        config.requestTimeoutMs = 10000;

        impl_->client = std::make_unique<Aws::DynamoDB::DynamoDBClient>(config);
        initialized_ = true;
        Logger::info("DynamoDB client initialized, region:", region_);
        return true;
    } catch (const std::exception& e) {
        Logger::error("DynamoDB initialization failed:", e.what());
        return false;
    }
}

std::vector<OrderPtr> DynamoDBClient::loadActiveOrders(const std::string& table_name) {
    std::vector<OrderPtr> orders;

    if (!initialized_) {
        Logger::error("DynamoDB client not initialized");
        return orders;
    }

    try {
        Aws::DynamoDB::Model::ScanRequest request;
        request.SetTableName(table_name);

        // status IN ('ACCEPTED', 'PARTIAL_FILL') + cancel_processed/PENDING_CANCEL 가드
        // 고스트 주문 방지: cancel_processed=true 또는 PENDING_CANCEL 상태인 주문 제외
        request.SetFilterExpression(
            "(#s = :accepted OR #s = :partial_fill) AND "
            "(attribute_not_exists(cancel_processed) OR cancel_processed = :false)"
        );
        request.AddExpressionAttributeNames("#s", "status");

        Aws::DynamoDB::Model::AttributeValue acceptedVal;
        acceptedVal.SetS("ACCEPTED");
        request.AddExpressionAttributeValues(":accepted", acceptedVal);

        Aws::DynamoDB::Model::AttributeValue partialFillVal;
        partialFillVal.SetS("PARTIAL_FILL");
        request.AddExpressionAttributeValues(":partial_fill", partialFillVal);

        Aws::DynamoDB::Model::AttributeValue falseVal;
        falseVal.SetBool(false);
        request.AddExpressionAttributeValues(":false", falseVal);

        // 필요한 속성만 가져오기 (프로젝션)
        request.SetProjectionExpression(
            "order_id, user_id, symbol, side, price, quantity, filled_qty, #s, created_at"
        );

        std::string last_key;
        int total_scanned = 0;
        int total_accepted = 0;
        int total_partial = 0;

        do {
            auto outcome = impl_->client->Scan(request);

            if (!outcome.IsSuccess()) {
                Logger::error("DynamoDB scan failed:",
                             outcome.GetError().GetMessage());
                break;
            }

            const auto& result = outcome.GetResult();
            total_scanned += result.GetScannedCount();

            for (const auto& item : result.GetItems()) {
                // MM(마켓메이커) 주문 제외
                auto user_it = item.find("user_id");
                if (user_it != item.end()) {
                    const std::string& user_id = user_it->second.GetS();
                    if (user_id.find("mm-") == 0 ||
                        user_id.find("mm_") == 0 ||
                        user_id == "mm-bid" ||
                        user_id == "mm-ask" ||
                        user_id == "mm-kinesis-direct-buy" ||
                        user_id == "mm-kinesis-direct-sell") {
                        continue;  // MM 주문 스킵
                    }
                }

                auto order = std::make_shared<Order>();

                // order_id
                auto it = item.find("order_id");
                if (it != item.end()) {
                    order->setOrderId(it->second.GetS());
                }

                // user_id
                it = item.find("user_id");
                if (it != item.end()) {
                    order->setUserId(it->second.GetS());
                }

                // symbol
                it = item.find("symbol");
                if (it != item.end()) {
                    order->setSymbol(it->second.GetS());
                }

                // side (BUY/SELL)
                it = item.find("side");
                if (it != item.end()) {
                    order->setIsBuy(it->second.GetS() == "BUY");
                }

                // price
                it = item.find("price");
                if (it != item.end()) {
                    order->setPrice(static_cast<uint64_t>(std::stoull(it->second.GetN())));
                }

                // quantity 및 filled_qty 파싱
                uint64_t quantity = 0;
                uint64_t filled_qty = 0;

                it = item.find("quantity");
                if (it != item.end()) {
                    quantity = static_cast<uint64_t>(std::stoull(it->second.GetN()));
                }

                it = item.find("filled_qty");
                if (it != item.end()) {
                    filled_qty = static_cast<uint64_t>(std::stoull(it->second.GetN()));
                }

                // status 확인 - PARTIAL_FILL이면 잔여 수량으로 복원
                std::string status;
                it = item.find("status");
                if (it != item.end()) {
                    status = it->second.GetS();
                }

                if (status == "PARTIAL_FILL") {
                    uint64_t remaining = quantity - filled_qty;
                    if (remaining == 0) {
                        Logger::warn("PARTIAL_FILL order has 0 remaining qty, skipping:",
                                    order->order_id());
                        continue;
                    }
                    // Safety: skip orders with suspiciously large remaining qty.
                    // Caused by legacy bug (hardcoded qty=999999999 in fill_processor).
                    if (remaining > 100000000) {
                        Logger::warn("Suspiciously large remaining qty, skipping:",
                                    order->order_id(), "remaining:", remaining,
                                    "quantity:", quantity, "filled:", filled_qty);
                        continue;
                    }
                    order->setOrderQty(remaining);
                    ++total_partial;
                    Logger::info("PARTIAL_FILL order loaded:", order->order_id(),
                                "original_qty:", quantity, "filled:", filled_qty,
                                "remaining:", remaining);
                } else {
                    order->setOrderQty(quantity);
                    ++total_accepted;
                }

                // created_at을 timestamp로 변환 (선택적)
                it = item.find("created_at");
                if (it != item.end()) {
                    auto now = std::chrono::system_clock::now();
                    auto epoch = std::chrono::duration_cast<std::chrono::nanoseconds>(
                        now.time_since_epoch()).count();
                    order->setTimestamp(epoch);
                }

                orders.push_back(order);
            }

            // 페이지네이션 처리
            if (result.GetLastEvaluatedKey().empty()) {
                break;
            }
            request.SetExclusiveStartKey(result.GetLastEvaluatedKey());

        } while (true);

        Logger::info("DynamoDB scan complete: scanned=", total_scanned,
                    ", accepted=", total_accepted, ", partial_fill=", total_partial,
                    " active orders loaded (MM excluded)");

    } catch (const std::exception& e) {
        Logger::error("DynamoDB loadActiveOrders failed:", e.what());
    }

    return orders;
}

std::vector<OrderPtr> DynamoDBClient::loadActiveOrdersBySymbol(
    const std::string& symbol,
    const std::string& table_name) {

    std::vector<OrderPtr> orders;

    if (!initialized_) {
        Logger::error("DynamoDB client not initialized");
        return orders;
    }

    try {
        Aws::DynamoDB::Model::ScanRequest request;
        request.SetTableName(table_name);

        // symbol = :sym AND (status = 'ACCEPTED' OR status = 'PARTIAL_FILL')
        // 고스트 주문 방지: cancel_processed=true인 주문 제외
        request.SetFilterExpression(
            "symbol = :sym AND (#s = :accepted OR #s = :partial_fill) AND "
            "(attribute_not_exists(cancel_processed) OR cancel_processed = :false)"
        );
        request.AddExpressionAttributeNames("#s", "status");

        Aws::DynamoDB::Model::AttributeValue symbolVal;
        symbolVal.SetS(symbol);
        request.AddExpressionAttributeValues(":sym", symbolVal);

        Aws::DynamoDB::Model::AttributeValue acceptedVal;
        acceptedVal.SetS("ACCEPTED");
        request.AddExpressionAttributeValues(":accepted", acceptedVal);

        Aws::DynamoDB::Model::AttributeValue partialFillVal;
        partialFillVal.SetS("PARTIAL_FILL");
        request.AddExpressionAttributeValues(":partial_fill", partialFillVal);

        Aws::DynamoDB::Model::AttributeValue falseVal;
        falseVal.SetBool(false);
        request.AddExpressionAttributeValues(":false", falseVal);

        request.SetProjectionExpression(
            "order_id, user_id, symbol, side, price, quantity, filled_qty, #s"
        );

        do {
            auto outcome = impl_->client->Scan(request);

            if (!outcome.IsSuccess()) {
                Logger::error("DynamoDB scan by symbol failed:",
                             outcome.GetError().GetMessage());
                break;
            }

            const auto& result = outcome.GetResult();

            for (const auto& item : result.GetItems()) {
                // MM 주문 제외
                auto user_it = item.find("user_id");
                if (user_it != item.end()) {
                    const std::string& user_id = user_it->second.GetS();
                    if (user_id.find("mm-") == 0 || user_id.find("mm_") == 0) {
                        continue;
                    }
                }

                auto order = std::make_shared<Order>();

                auto it = item.find("order_id");
                if (it != item.end()) order->setOrderId(it->second.GetS());

                it = item.find("user_id");
                if (it != item.end()) order->setUserId(it->second.GetS());

                it = item.find("symbol");
                if (it != item.end()) order->setSymbol(it->second.GetS());

                it = item.find("side");
                if (it != item.end()) order->setIsBuy(it->second.GetS() == "BUY");

                it = item.find("price");
                if (it != item.end()) {
                    order->setPrice(static_cast<uint64_t>(std::stoull(it->second.GetN())));
                }

                // quantity 및 filled_qty 파싱
                uint64_t quantity = 0;
                uint64_t filled_qty = 0;

                it = item.find("quantity");
                if (it != item.end()) {
                    quantity = static_cast<uint64_t>(std::stoull(it->second.GetN()));
                }

                it = item.find("filled_qty");
                if (it != item.end()) {
                    filled_qty = static_cast<uint64_t>(std::stoull(it->second.GetN()));
                }

                // PARTIAL_FILL이면 잔여 수량으로 복원
                std::string status;
                it = item.find("status");
                if (it != item.end()) {
                    status = it->second.GetS();
                }

                if (status == "PARTIAL_FILL") {
                    uint64_t remaining = quantity - filled_qty;
                    if (remaining == 0) continue;
                    // Safety: skip orders with suspiciously large remaining qty
                    if (remaining > 100000000) {
                        Logger::warn("Suspiciously large remaining qty in symbol scan, skipping:",
                                    order->order_id(), "remaining:", remaining);
                        continue;
                    }
                    order->setOrderQty(remaining);
                } else {
                    order->setOrderQty(quantity);
                }

                auto now = std::chrono::system_clock::now();
                order->setTimestamp(std::chrono::duration_cast<std::chrono::nanoseconds>(
                    now.time_since_epoch()).count());

                orders.push_back(order);
            }

            if (result.GetLastEvaluatedKey().empty()) {
                break;
            }
            request.SetExclusiveStartKey(result.GetLastEvaluatedKey());

        } while (true);

        Logger::info("Loaded", orders.size(), "active orders for symbol:", symbol);

    } catch (const std::exception& e) {
        Logger::error("DynamoDB loadActiveOrdersBySymbol failed:", e.what());
    }

    return orders;
}

std::unordered_map<std::string, uint64_t> DynamoDBClient::loadSymbolsTotalShares(
    const std::string& table_name) {

    std::unordered_map<std::string, uint64_t> result;

    if (!initialized_) {
        Logger::error("DynamoDB client not initialized");
        return result;
    }

    try {
        Aws::DynamoDB::Model::ScanRequest request;
        request.SetTableName(table_name);

        // symbol과 totalShares만 가져오기
        request.SetProjectionExpression("symbol, totalShares");

        int total_loaded = 0;

        do {
            auto outcome = impl_->client->Scan(request);

            if (!outcome.IsSuccess()) {
                Logger::error("DynamoDB scan stocks failed:",
                             outcome.GetError().GetMessage());
                break;
            }

            const auto& scan_result = outcome.GetResult();

            for (const auto& item : scan_result.GetItems()) {
                std::string symbol;
                uint64_t total_shares = 0;

                // symbol
                auto it = item.find("symbol");
                if (it != item.end()) {
                    symbol = it->second.GetS();
                }

                // totalShares
                it = item.find("totalShares");
                if (it != item.end()) {
                    try {
                        total_shares = static_cast<uint64_t>(std::stoull(it->second.GetN()));
                    } catch (...) {
                        Logger::warn("Failed to parse totalShares for symbol:", symbol);
                        continue;
                    }
                }

                if (!symbol.empty() && total_shares > 0) {
                    result[symbol] = total_shares;
                    ++total_loaded;
                }
            }

            // 페이지네이션 처리
            if (scan_result.GetLastEvaluatedKey().empty()) {
                break;
            }
            request.SetExclusiveStartKey(scan_result.GetLastEvaluatedKey());

        } while (true);

        Logger::info("DynamoDB loadSymbolsTotalShares complete:", total_loaded, "symbols loaded");

    } catch (const std::exception& e) {
        Logger::error("DynamoDB loadSymbolsTotalShares failed:", e.what());
    }

    return result;
}

} // namespace aws_wrapper
