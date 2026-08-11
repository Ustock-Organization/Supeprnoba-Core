#pragma once

#include "order.h"
#include <string>
#include <vector>
#include <memory>
#include <unordered_map>

namespace aws_wrapper {

/**
 * DynamoDB 클라이언트
 *
 * 매칭 엔진 시작 시 DynamoDB에서 ACCEPTED 상태의 주문들을 로드하여
 * 오더북에 복원하기 위해 사용됩니다.
 */
class DynamoDBClient {
public:
    explicit DynamoDBClient(const std::string& region = "ap-northeast-2");
    ~DynamoDBClient();

    // 복사/이동 금지
    DynamoDBClient(const DynamoDBClient&) = delete;
    DynamoDBClient& operator=(const DynamoDBClient&) = delete;

    /**
     * 초기화
     * @return 성공 여부
     */
    bool initialize();

    /**
     * 활성 주문을 로드 (ACCEPTED + PARTIAL_FILL)
     * PARTIAL_FILL 주문은 잔여 수량(quantity - filled_qty)으로 복원됩니다.
     * MM(마켓메이커) 주문은 제외합니다.
     *
     * @param table_name DynamoDB 테이블 이름
     * @return 주문 목록 (심볼별로 정렬됨)
     */
    std::vector<OrderPtr> loadActiveOrders(const std::string& table_name = "supernoba-orders");

    /**
     * 특정 심볼의 활성 주문 로드 (ACCEPTED + PARTIAL_FILL)
     *
     * @param symbol 심볼명
     * @param table_name DynamoDB 테이블 이름
     * @return 주문 목록
     */
    std::vector<OrderPtr> loadActiveOrdersBySymbol(
        const std::string& symbol,
        const std::string& table_name = "supernoba-orders");

    /**
     * 모든 종목의 totalShares 로드 (랭킹 시가총액 계산용)
     *
     * @param table_name DynamoDB 테이블 이름 (supernoba-stocks)
     * @return 심볼 -> totalShares 매핑
     */
    std::unordered_map<std::string, uint64_t> loadSymbolsTotalShares(
        const std::string& table_name = "supernoba-stocks");

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
    std::string region_;
    bool initialized_ = false;
};

} // namespace aws_wrapper
