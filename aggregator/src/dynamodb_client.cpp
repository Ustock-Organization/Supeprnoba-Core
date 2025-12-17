#include "dynamodb_client.h"
#include "logger.h"

#include <aws/core/Aws.h>
#include <aws/dynamodb/DynamoDBClient.h>
#include <aws/dynamodb/model/PutItemRequest.h>
#include <aws/dynamodb/model/BatchWriteItemRequest.h>
#include <aws/dynamodb/model/WriteRequest.h>

namespace aggregator {

DynamoDBClient::DynamoDBClient(const std::string& table_name, const std::string& region)
    : table_name_(table_name), region_(region), connected_(false) {}

DynamoDBClient::~DynamoDBClient() = default;

bool DynamoDBClient::connect() {
    try {
        Aws::Client::ClientConfiguration config;
        config.region = region_;
        
        client_ = std::make_unique<Aws::DynamoDB::DynamoDBClient>(config);
        connected_ = true;
        return true;
    } catch (const std::exception& e) {
        Logger::error("DynamoDB client init error:", e.what());
        return false;
    }
}

bool DynamoDBClient::put_candle(const std::string& symbol, const std::string& interval, 
                                const Candle& candle) {
    if (!connected_ || !client_) return false;
    
    try {
        Aws::DynamoDB::Model::PutItemRequest request;
        request.SetTableName(table_name_);
        
        // pk: CANDLE#SYMBOL#INTERVAL
        std::string pk = "CANDLE#" + symbol + "#" + interval;
        request.AddItem("pk", Aws::DynamoDB::Model::AttributeValue(pk));
        
        // sk: epoch seconds (Number)
        request.AddItem("sk", Aws::DynamoDB::Model::AttributeValue().SetN(std::to_string(candle.epoch())));
        
        // OHLCV 데이터
        request.AddItem("time", Aws::DynamoDB::Model::AttributeValue(candle.time));
        request.AddItem("open", Aws::DynamoDB::Model::AttributeValue().SetN(std::to_string(candle.open)));
        request.AddItem("high", Aws::DynamoDB::Model::AttributeValue().SetN(std::to_string(candle.high)));
        request.AddItem("low", Aws::DynamoDB::Model::AttributeValue().SetN(std::to_string(candle.low)));
        request.AddItem("close", Aws::DynamoDB::Model::AttributeValue().SetN(std::to_string(candle.close)));
        request.AddItem("volume", Aws::DynamoDB::Model::AttributeValue().SetN(std::to_string(candle.volume)));
        request.AddItem("symbol", Aws::DynamoDB::Model::AttributeValue(symbol));
        request.AddItem("interval", Aws::DynamoDB::Model::AttributeValue(interval));
        
        auto outcome = client_->PutItem(request);
        
        if (!outcome.IsSuccess()) {
            Logger::error("DynamoDB put failed:", outcome.GetError().GetMessage());
            return false;
        }
        
        return true;
    } catch (const std::exception& e) {
        Logger::error("DynamoDB put exception:", e.what());
        return false;
    }
}

int DynamoDBClient::batch_put_candles(const std::string& symbol, const std::string& interval,
                                      const std::vector<Candle>& candles) {
    if (!connected_ || !client_ || candles.empty()) return 0;
    
    int total_saved = 0;
    
    // BatchWriteItem은 최대 25개씩 처리
    const size_t BATCH_SIZE = 25;
    
    for (size_t i = 0; i < candles.size(); i += BATCH_SIZE) {
        std::vector<Aws::DynamoDB::Model::WriteRequest> write_requests;
        
        size_t end = std::min(i + BATCH_SIZE, candles.size());
        for (size_t j = i; j < end; j++) {
            const auto& candle = candles[j];
            
            Aws::DynamoDB::Model::PutRequest put;
            
            std::string pk = "CANDLE#" + symbol + "#" + interval;
            put.AddItem("pk", Aws::DynamoDB::Model::AttributeValue(pk));
            put.AddItem("sk", Aws::DynamoDB::Model::AttributeValue().SetN(std::to_string(candle.epoch())));
            put.AddItem("time", Aws::DynamoDB::Model::AttributeValue(candle.time));
            put.AddItem("open", Aws::DynamoDB::Model::AttributeValue().SetN(std::to_string(candle.open)));
            put.AddItem("high", Aws::DynamoDB::Model::AttributeValue().SetN(std::to_string(candle.high)));
            put.AddItem("low", Aws::DynamoDB::Model::AttributeValue().SetN(std::to_string(candle.low)));
            put.AddItem("close", Aws::DynamoDB::Model::AttributeValue().SetN(std::to_string(candle.close)));
            put.AddItem("volume", Aws::DynamoDB::Model::AttributeValue().SetN(std::to_string(candle.volume)));
            put.AddItem("symbol", Aws::DynamoDB::Model::AttributeValue(symbol));
            put.AddItem("interval", Aws::DynamoDB::Model::AttributeValue(interval));
            
            Aws::DynamoDB::Model::WriteRequest wr;
            wr.SetPutRequest(put);
            write_requests.push_back(wr);
        }
        
        Aws::DynamoDB::Model::BatchWriteItemRequest batch_request;
        batch_request.AddRequestItems(table_name_, write_requests);
        
        auto outcome = client_->BatchWriteItem(batch_request);
        
        if (outcome.IsSuccess()) {
            total_saved += (end - i);
        } else {
            Logger::error("DynamoDB batch put failed:", outcome.GetError().GetMessage());
        }
    }
    
    return total_saved;
}

} // namespace aggregator
