// VI 서킷브레이커 검증 — 급변 halt 발동, halt 중 주문 거부, 임계 순수판정, halt>밴드 우선.
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
    std::vector<std::pair<std::string,std::string>> rejects;  // (order_id, reason)
    int fills = 0;
    void publishFill(const std::string&, const std::string&, const std::string&,
                     const std::string&, const std::string&, uint64_t, uint64_t,
                     bool, bool, bool) override { ++fills; }
    void publishTrade(const std::string&, uint64_t, uint64_t) override {}
    void publishDepth(const std::string&, const nlohmann::json&) override {}
    void publishOrderStatus(const std::string&, const std::string& oid,
                            const std::string&, const std::string& status,
                            const std::string& reason, uint64_t, uint64_t, bool,
                            const std::string&) override {
        if (status == "REJECTED") rejects.push_back({oid, reason});
    }
    void flush(int) override {}
};

static OrderPtr mk(const std::string& id, const std::string& u, const std::string& s,
                   bool buy, uint64_t px, uint64_t q) {
    auto o = std::make_shared<Order>();
    o->setOrderId(id); o->setUserId(u); o->setSymbol(s);
    o->setIsBuy(buy); o->setPrice(px); o->setOrderQty(q); o->setOrderType("LIMIT");
    return o;
}
static int failures = 0;
static void check(bool c, const std::string& n) {
    std::cout << (c ? "  PASS  " : "  FAIL  ") << n << "\n"; if (!c) ++failures;
}
static bool rejectedFor(const MockProducer& p, const std::string& id, const std::string& sub) {
    for (auto& r : p.rejects)
        if (r.first == id && r.second.find(sub) != std::string::npos) return true;
    return false;
}

int main() {
    std::cout << "=== VI 서킷브레이커 검증 ===\n";

    // 순수 판정
    check(EngineCore::exceedsViThreshold(1000, 1035, 0.03), "판정: +3.5% >= 3% 임계");
    check(!EngineCore::exceedsViThreshold(1000, 1020, 0.03), "판정: +2% < 3% 임계");
    check(EngineCore::exceedsViThreshold(1000, 960, 0.03), "판정: -4% 하락도 감지");
    check(!EngineCore::exceedsViThreshold(0, 1000, 0.03), "판정: 기준가 0이면 미발동");
    check(!EngineCore::exceedsViThreshold(1000, 2000, 0.0), "판정: 비활성(0)이면 미발동");

    // 통합: 동적 VI 3%, halt 3600초(자동해제 안 됨)
    setenv("VI_DYNAMIC_PCT", "0.03", 1);
    setenv("VI_HALT_SECONDS", "3600", 1);
    setenv("PRICE_BAND_PCT", "0", 1);   // 밴드 끔(VI 단독 검증)

    MockProducer prod;
    MarketDataHandler handler(&prod);
    EngineCore engine(&handler);

    // 첫 체결 100 (VI 기준가 확립)
    engine.addOrder(mk("s1", "mmA", "AAA", false, 100, 10));
    engine.addOrder(mk("b1", "userB", "AAA", true, 100, 10));   // 체결 → last=100
    check(prod.fills == 1, "첫 체결 100 (VI 기준)");
    check(!engine.isHalted("AAA"), "체결 직후 halt 아님(첫 기준가 확립만)");

    // 다음 체결을 105로 (직전 100 대비 +5% > 3%) → halt 발동
    engine.addOrder(mk("s2", "mmA", "AAA", false, 105, 10));
    engine.addOrder(mk("b2", "userB", "AAA", true, 105, 10));   // 체결 105
    check(engine.isHalted("AAA"), "★ +5% 급변 → VI halt 발동");

    // halt 중 신규 주문 거부
    engine.addOrder(mk("s3", "mmA", "AAA", false, 106, 10));
    check(rejectedFor(prod, "s3", "halted"), "★ halt 중 신규 주문 거부");

    // 다른 심볼은 영향 없음
    engine.addOrder(mk("x1", "mmA", "BBB", false, 100, 10));
    check(!rejectedFor(prod, "x1", "halted"), "타 심볼(BBB)은 halt 무관");

    // halt > 밴드 우선순위: 밴드도 켜고 halt 중이면 사유가 halt여야
    {
        setenv("VI_DYNAMIC_PCT", "0.03", 1);
        setenv("VI_HALT_SECONDS", "3600", 1);
        setenv("PRICE_BAND_PCT", "0.10", 1);  // ±10% — 105는 통과(VI 유발), 200은 밴드 밖
        MockProducer p2;
        MarketDataHandler h2(&p2);
        EngineCore e2(&h2);
        e2.addOrder(mk("s", "mmA", "CCC", false, 100, 10));
        e2.addOrder(mk("b", "userB", "CCC", true, 100, 10));       // last=100, 밴드 [90,110]
        e2.addOrder(mk("s2", "mmA", "CCC", false, 105, 10));       // 밴드 내(통과)
        e2.addOrder(mk("b2", "userB", "CCC", true, 105, 10));      // 체결 105 → +5% → halt
        // 200은 밴드 밖이자 halt 중 → halt 검사가 먼저이므로 사유는 halt
        e2.addOrder(mk("z", "userC", "CCC", true, 200, 5));
        check(rejectedFor(p2, "z", "halted"), "★ halt>밴드 우선: 사유가 halt");
        check(!rejectedFor(p2, "z", "band"), "밴드 사유로는 거부 안 됨(halt가 먼저)");
    }

    std::cout << "=== " << (failures == 0 ? "ALL PASS" : std::to_string(failures) + " FAIL")
              << " ===\n";
    return failures == 0 ? 0 : 1;
}
