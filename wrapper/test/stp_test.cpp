// STP(자전거래 방지) 검증 테스트 — 프레임워크 없이 독립 실행.
// 시나리오: 자전거래 차단 / MM 면제 / 정상 유저간 체결 / 비교차 미개입.
#include "engine_core.h"
#include "market_data_handler.h"
#include "iproducer.h"
#include "order.h"
#include <cassert>
#include <iostream>
#include <string>
#include <vector>

using namespace aws_wrapper;

// 체결/취소를 기록하는 mock producer.
struct MockProducer : public IProducer {
    struct Fill { std::string buyer, seller; uint64_t qty, price; };
    std::vector<Fill> fills;
    std::vector<std::string> cancels;   // CANCELLED status를 받은 order_id

    void publishFill(const std::string&, const std::string&, const std::string&,
                     const std::string& buyer_id, const std::string& seller_id,
                     uint64_t qty, uint64_t price, bool, bool, bool) override {
        fills.push_back({buyer_id, seller_id, qty, price});
    }
    void publishTrade(const std::string&, uint64_t, uint64_t) override {}
    void publishDepth(const std::string&, const nlohmann::json&) override {}
    void publishOrderStatus(const std::string&, const std::string& order_id,
                            const std::string&, const std::string& status,
                            const std::string&, uint64_t, uint64_t, bool,
                            const std::string&) override {
        if (status == "CANCELLED") cancels.push_back(order_id);
    }
    void flush(int) override {}
};

static OrderPtr makeOrder(const std::string& id, const std::string& user,
                          const std::string& sym, bool buy, uint64_t price,
                          uint64_t qty) {
    auto o = std::make_shared<Order>();
    o->setOrderId(id);
    o->setUserId(user);
    o->setSymbol(sym);
    o->setIsBuy(buy);
    o->setPrice(price);
    o->setOrderQty(qty);
    o->setOrderType("LIMIT");
    return o;
}

static int failures = 0;
static void check(bool cond, const std::string& name) {
    std::cout << (cond ? "  PASS  " : "  FAIL  ") << name << "\n";
    if (!cond) ++failures;
}

int main() {
    std::cout << "=== STP 검증 테스트 ===\n";

    // 시나리오 1: 동일 유저 자전거래 차단.
    // user A가 SELL @100 resting, 이어서 A가 BUY @100 → 교차하지만 자기 주문.
    // STP(cancel-oldest): resting SELL 취소, 체결 0건.
    {
        MockProducer prod;
        MarketDataHandler handler(&prod);
        EngineCore engine(&handler);
        engine.addOrder(makeOrder("s1", "userA", "AAA", false, 100, 10));
        engine.addOrder(makeOrder("b1", "userA", "AAA", true, 100, 10));
        check(prod.fills.empty(), "자전거래: 체결 0건");
        check(prod.cancels.size() == 1 && prod.cancels[0] == "s1",
              "자전거래: resting(s1) 취소 발행");
    }

    // 시나리오 2: 정상 유저간 체결은 STP가 개입하지 않음.
    // userA SELL @100, userB BUY @100 → 정상 체결.
    {
        MockProducer prod;
        MarketDataHandler handler(&prod);
        EngineCore engine(&handler);
        engine.addOrder(makeOrder("s2", "userA", "BBB", false, 100, 10));
        engine.addOrder(makeOrder("b2", "userB", "BBB", true, 100, 10));
        check(prod.fills.size() == 1, "정상 체결: 1건 발생");
        check(prod.fills.size() == 1 && prod.fills[0].buyer == "userB" &&
              prod.fills[0].seller == "userA", "정상 체결: buyer/seller 정확");
    }

    // 시나리오 3: MM 면제 — mm-buyer/mm-seller는 의도적 자전체결 허용.
    {
        MockProducer prod;
        MarketDataHandler handler(&prod);
        EngineCore engine(&handler);
        engine.addOrder(makeOrder("ms", "mm-seller", "CCC", false, 100, 10));
        engine.addOrder(makeOrder("mb", "mm-buyer", "CCC", true, 100, 10));
        check(prod.fills.size() == 1, "MM 면제: 자전체결 1건 허용");
    }

    // 시나리오 4: 같은 MM ID여도 면제(mm- 접두사면 STP 스킵).
    {
        MockProducer prod;
        MarketDataHandler handler(&prod);
        EngineCore engine(&handler);
        engine.addOrder(makeOrder("m1", "mm-buyer", "DDD", false, 100, 10));
        engine.addOrder(makeOrder("m2", "mm-buyer", "DDD", true, 100, 10));
        check(prod.fills.size() == 1, "동일 MM ID: 면제되어 체결");
        check(prod.cancels.empty(), "동일 MM ID: STP 취소 없음");
    }

    // 시나리오 5: 비교차 주문은 STP 미개입.
    // userA SELL @110 resting, userA BUY @100 → 교차 안 함(100 < 110).
    {
        MockProducer prod;
        MarketDataHandler handler(&prod);
        EngineCore engine(&handler);
        engine.addOrder(makeOrder("s5", "userA", "EEE", false, 110, 10));
        engine.addOrder(makeOrder("b5", "userA", "EEE", true, 100, 10));
        check(prod.cancels.empty(), "비교차: STP 미개입(취소 없음)");
        check(prod.fills.empty(), "비교차: 체결 없음");
    }

    // 시나리오 6: 시장가 자전거래 차단(price==0은 전 구간 교차).
    {
        MockProducer prod;
        MarketDataHandler handler(&prod);
        EngineCore engine(&handler);
        engine.addOrder(makeOrder("s6", "userA", "FFF", false, 95, 10));
        auto mkt = makeOrder("b6", "userA", "FFF", true, 0, 10);
        mkt->setOrderType("MARKET");
        engine.addOrder(mkt);
        check(prod.cancels.size() == 1, "시장가 자전거래: resting 취소");
        check(prod.fills.empty(), "시장가 자전거래: 체결 0건");
    }

    std::cout << "=== " << (failures == 0 ? "ALL PASS" : std::to_string(failures) + " FAIL")
              << " ===\n";
    return failures == 0 ? 0 : 1;
}
