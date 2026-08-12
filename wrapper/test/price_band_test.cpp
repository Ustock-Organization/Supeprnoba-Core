// 가격 밴드 검증 — 직전 체결가 ±band 밖 LIMIT 주문 거부, 밴드 내 통과, 첫거래 전 스킵.
#include "engine_core.h"
#include "market_data_handler.h"
#include "iproducer.h"
#include "order.h"
#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

using namespace aws_wrapper;

struct MockProducer : public IProducer {
    std::vector<std::string> rejects;   // REJECTED order_id
    int fills = 0;
    void publishFill(const std::string&, const std::string&, const std::string&,
                     const std::string&, const std::string&, uint64_t, uint64_t,
                     bool, bool, bool) override { ++fills; }
    void publishTrade(const std::string&, uint64_t, uint64_t) override {}
    void publishDepth(const std::string&, const nlohmann::json&) override {}
    void publishOrderStatus(const std::string&, const std::string& order_id,
                            const std::string&, const std::string& status,
                            const std::string&, uint64_t, uint64_t, bool,
                            const std::string&) override {
        if (status == "REJECTED") rejects.push_back(order_id);
    }
    void flush(int) override {}
};

static OrderPtr mk(const std::string& id, const std::string& user, const std::string& sym,
                   bool buy, uint64_t price, uint64_t qty) {
    auto o = std::make_shared<Order>();
    o->setOrderId(id); o->setUserId(user); o->setSymbol(sym);
    o->setIsBuy(buy); o->setPrice(price); o->setOrderQty(qty); o->setOrderType("LIMIT");
    return o;
}

static int failures = 0;
static void check(bool c, const std::string& n) {
    std::cout << (c ? "  PASS  " : "  FAIL  ") << n << "\n";
    if (!c) ++failures;
}
static bool rejected(const MockProducer& p, const std::string& id) {
    for (auto& r : p.rejects) if (r == id) return true;
    return false;
}

int main() {
    setenv("PRICE_BAND_PCT", "0.5", 1);   // ±50%
    std::cout << "=== 가격 밴드 검증 (±50%) ===\n";

    MockProducer prod;
    MarketDataHandler handler(&prod);
    EngineCore engine(&handler);

    // 첫 거래 전: 기준가 없음 → 밴드 스킵(통과)
    engine.addOrder(mk("s0", "mmA", "AAA", false, 1000, 10));
    check(!rejected(prod, "s0"), "첫 거래 전: 밴드 스킵(거부 안 함)");

    // 체결로 last_price=1000 확정 (userB가 매수 체결)
    engine.addOrder(mk("b0", "userB", "AAA", true, 1000, 10));
    check(prod.fills == 1, "체결 발생 → last_price=1000 확정");

    // 밴드 [500, 1500]. 밴드 밖 상단: 2000 → 거부
    engine.addOrder(mk("hi", "userC", "AAA", true, 2000, 5));
    check(rejected(prod, "hi"), "상단 밴드 밖(2000 > 1500): 거부");

    // 밴드 밖 하단: 400 → 거부
    engine.addOrder(mk("lo", "userC", "AAA", false, 400, 5));
    check(rejected(prod, "lo"), "하단 밴드 밖(400 < 500): 거부");

    // 밴드 내: 1200 → 통과(거부 안 함)
    engine.addOrder(mk("ok", "userC", "AAA", true, 1200, 5));
    check(!rejected(prod, "ok"), "밴드 내(1200): 통과");

    // 경계값: 정확히 1500(=상한) → 통과
    engine.addOrder(mk("edge", "userC", "AAA", true, 1500, 5));
    check(!rejected(prod, "edge"), "경계값 1500: 통과");

    // 다른 심볼은 독립(BBB는 기준가 없음) → 극단값도 스킵
    engine.addOrder(mk("other", "userC", "BBB", true, 999999, 5));
    check(!rejected(prod, "other"), "타 심볼 첫 거래 전: 밴드 스킵");

    // 밴드 비활성(0) 시 극단값도 통과 — 별도 엔진
    {
        setenv("PRICE_BAND_PCT", "0", 1);
        MockProducer p2;
        MarketDataHandler h2(&p2);
        EngineCore e2(&h2);
        e2.addOrder(mk("s", "mmA", "CCC", false, 100, 10));
        e2.addOrder(mk("b", "userB", "CCC", true, 100, 10));   // last=100
        e2.addOrder(mk("wild", "userC", "CCC", true, 100000, 5));
        check(!rejected(p2, "wild"), "밴드 비활성(0): 극단값도 통과");
    }

    std::cout << "=== " << (failures == 0 ? "ALL PASS" : std::to_string(failures) + " FAIL")
              << " ===\n";
    return failures == 0 ? 0 : 1;
}
