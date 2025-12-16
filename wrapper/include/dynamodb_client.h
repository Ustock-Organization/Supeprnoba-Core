#pragma once

#include <string>
#include <optional>
#include <memory>

#ifdef USE_KINESIS
#include <aws/core/Aws.h>
#include <aws/dynamodb/DynamoDBClient.h>
#include <aws/dynamodb/model/PutItemRequest.h>
#include <aws/dynamodb/model/GetItemRequest.h>
#endif

namespace aws_wrapper {

class DynamoDBClient {
public:
    DynamoDBClient(const std::string& region, const std::string& table_name);
    ~DynamoDBClient();
    
    bool connect();
    bool isConnected() const { return connected_; }
    
    // 체결 내역 저장
    bool putTrade(const std::string& symbol,
                  int64_t timestamp,
                  uint64_t price,
                  uint64_t quantity,
                  const std::string& buyer_id,
                  const std::string& seller_id,
                  const std::string& buyer_order,
                  const std::string& seller_order);
    
private:
    std::string region_;
    std::string table_name_;
    bool connected_ = false;
    
#ifdef USE_KINESIS
    std::unique_ptr<Aws::DynamoDB::DynamoDBClient> client_;
#endif
};

} // namespace aws_wrapper
