#include "dynamodb_client.h"
#include "logger.h"

#ifdef USE_KINESIS
#include <aws/dynamodb/model/AttributeValue.h>
#endif

namespace aws_wrapper {

DynamoDBClient::DynamoDBClient(const std::string& region, const std::string& table_name)
    : region_(region), table_name_(table_name) {}

DynamoDBClient::~DynamoDBClient() = default;

bool DynamoDBClient::connect() {
#ifdef USE_KINESIS
    Aws::Client::ClientConfiguration config;
    config.region = region_;
    
    client_ = std::make_unique<Aws::DynamoDB::DynamoDBClient>(config);
    connected_ = true;
    Logger::info("DynamoDB client connected:", table_name_, "region:", region_);
    return true;
#else
    Logger::warn("DynamoDB not available (USE_KINESIS not defined)");
    return false;
#endif
}

bool DynamoDBClient::putTrade(const std::string& symbol,
                               int64_t timestamp,
                               uint64_t price,
                               uint64_t quantity,
                               const std::string& buyer_id,
                               const std::string& seller_id,
                               const std::string& buyer_order,
                               const std::string& seller_order) {
#ifdef USE_KINESIS
    if (!connected_ || !client_) {
        Logger::warn("DynamoDB not connected, skipping trade save");
        return false;
    }
    
    Aws::DynamoDB::Model::PutItemRequest request;
    request.SetTableName(table_name_);
    
    // 날짜 문자열 생성 (YYYYMMDD)
    // 🔧 FIX: timestamp는 이미 초 단위로 전달됨 (market_data_handler.cpp에서 epoch_sec)
    time_t rawtime = timestamp;  // timestamp is already in seconds
    struct tm* timeinfo = gmtime(&rawtime);
    char dateStr[9];
    strftime(dateStr, sizeof(dateStr), "%Y%m%d", timeinfo);
    
    // Partition Key: TRADE#SYMBOL#DATE
    std::string pk = "TRADE#" + symbol + "#" + dateStr;
    request.AddItem("pk", Aws::DynamoDB::Model::AttributeValue(pk));
    
    // Sort Key: timestamp (Number)
    request.AddItem("sk", Aws::DynamoDB::Model::AttributeValue().SetN(std::to_string(timestamp)));
    
    // 체결 데이터
    request.AddItem("symbol", Aws::DynamoDB::Model::AttributeValue(symbol));
    request.AddItem("price", Aws::DynamoDB::Model::AttributeValue().SetN(std::to_string(price)));
    request.AddItem("quantity", Aws::DynamoDB::Model::AttributeValue().SetN(std::to_string(quantity)));
    request.AddItem("timestamp", Aws::DynamoDB::Model::AttributeValue().SetN(std::to_string(timestamp)));
    request.AddItem("date", Aws::DynamoDB::Model::AttributeValue(dateStr));
    request.AddItem("buyer_id", Aws::DynamoDB::Model::AttributeValue(buyer_id));
    request.AddItem("seller_id", Aws::DynamoDB::Model::AttributeValue(seller_id));
    request.AddItem("buyer_order", Aws::DynamoDB::Model::AttributeValue(buyer_order));
    request.AddItem("seller_order", Aws::DynamoDB::Model::AttributeValue(seller_order));
    
    auto outcome = client_->PutItem(request);
    
    if (outcome.IsSuccess()) {
        Logger::debug("DynamoDB trade saved:", symbol, "ts:", timestamp, "price:", price);
        return true;
    } else {
        Logger::error("DynamoDB PutItem failed:", outcome.GetError().GetMessage());
        return false;
    }
#else
    return false;
#endif
}

std::optional<uint64_t> DynamoDBClient::getPrevClose(const std::string& symbol) {
#ifdef USE_KINESIS
    if (!connected_ || !client_) {
        return std::nullopt;
    }
    
    // symbol_history 테이블에서 가장 최근 종가 조회
    // (실제 구현 시 날짜 기반 쿼리 필요)
    Aws::DynamoDB::Model::GetItemRequest request;
    request.SetTableName("symbol_history");
    request.AddKey("symbol", Aws::DynamoDB::Model::AttributeValue(symbol));
    
    auto outcome = client_->GetItem(request);
    
    if (outcome.IsSuccess()) {
        const auto& item = outcome.GetResult().GetItem();
        if (item.find("close") != item.end()) {
            return std::stoull(item.at("close").GetN());
        }
    }
    
    return std::nullopt;
#else
    return std::nullopt;
#endif
}

} // namespace aws_wrapper
