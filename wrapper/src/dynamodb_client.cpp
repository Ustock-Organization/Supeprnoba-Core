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

std::vector<OrderPtr> DynamoDBClient::loadAcceptedOrders(const std::string& table_name) {
    std::vector<OrderPtr> orders;

    if (!initialized_) {
        Logger::error("DynamoDB client not initialized");
        return orders;
    }

    try {
        Aws::DynamoDB::Model::ScanRequest request;
        request.SetTableName(table_name);

        // status = 'ACCEPTED' 필터
        request.SetFilterExpression("#s = :status");
        request.AddExpressionAttributeNames("#s", "status");

        Aws::DynamoDB::Model::AttributeValue statusVal;
        statusVal.SetS("ACCEPTED");
        request.AddExpressionAttributeValues(":status", statusVal);

        // 필요한 속성만 가져오기 (프로젝션)
        request.SetProjectionExpression(
            "order_id, user_id, symbol, side, price, quantity, filled_qty, #s, created_at"
        );

        std::string last_key;
        int total_scanned = 0;
        int total_loaded = 0;

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

                // quantity
                it = item.find("quantity");
                if (it != item.end()) {
                    order->setOrderQty(static_cast<uint64_t>(std::stoull(it->second.GetN())));
                }

                // created_at을 timestamp로 변환 (선택적)
                it = item.find("created_at");
                if (it != item.end()) {
                    // ISO 8601 형식의 문자열을 epoch으로 변환하는 것은 복잡하므로
                    // 현재 시간을 사용
                    auto now = std::chrono::system_clock::now();
                    auto epoch = std::chrono::duration_cast<std::chrono::nanoseconds>(
                        now.time_since_epoch()).count();
                    order->setTimestamp(epoch);
                }

                orders.push_back(order);
                ++total_loaded;
            }

            // 페이지네이션 처리
            if (result.GetLastEvaluatedKey().empty()) {
                break;
            }
            request.SetExclusiveStartKey(result.GetLastEvaluatedKey());

        } while (true);

        Logger::info("DynamoDB scan complete: scanned=", total_scanned,
                    ", loaded=", total_loaded, " ACCEPTED orders (MM excluded)");

    } catch (const std::exception& e) {
        Logger::error("DynamoDB loadAcceptedOrders failed:", e.what());
    }

    return orders;
}

std::vector<OrderPtr> DynamoDBClient::loadAcceptedOrdersBySymbol(
    const std::string& symbol,
    const std::string& table_name) {

    std::vector<OrderPtr> orders;

    if (!initialized_) {
        Logger::error("DynamoDB client not initialized");
        return orders;
    }

    // GSI가 없으면 Scan + Filter 사용
    // 성능상 이슈가 있다면 symbol-status-index GSI 추가 권장
    try {
        Aws::DynamoDB::Model::ScanRequest request;
        request.SetTableName(table_name);

        // symbol = :sym AND status = 'ACCEPTED'
        request.SetFilterExpression("symbol = :sym AND #s = :status");
        request.AddExpressionAttributeNames("#s", "status");

        Aws::DynamoDB::Model::AttributeValue symbolVal;
        symbolVal.SetS(symbol);
        request.AddExpressionAttributeValues(":sym", symbolVal);

        Aws::DynamoDB::Model::AttributeValue statusVal;
        statusVal.SetS("ACCEPTED");
        request.AddExpressionAttributeValues(":status", statusVal);

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

                it = item.find("quantity");
                if (it != item.end()) {
                    order->setOrderQty(static_cast<uint64_t>(std::stoull(it->second.GetN())));
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

        Logger::info("Loaded", orders.size(), "ACCEPTED orders for symbol:", symbol);

    } catch (const std::exception& e) {
        Logger::error("DynamoDB loadAcceptedOrdersBySymbol failed:", e.what());
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
