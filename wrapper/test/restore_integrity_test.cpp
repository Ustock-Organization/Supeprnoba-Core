// 복원·중복 무결성 검증 — 감사(2026-08-12) GROUP C가 지적한, 기존 단위테스트가
// 원리적으로 잡지 못하던 영역:
//   ① 리플레이 이중 등록 (스냅샷 복원 후 같은 ADD 재유입)
//   ② IOC/MARKET 주문의 order_maps_ 영구 잔류 → 스냅샷 유령 부활
//   ③ 부분체결 주문의 스냅샷 복원 시 수량 팽창
//   ④ VI halt 유발가로 기준가가 세탁되는 문제
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
    int fills = 0;
    uint64_t last_fill_price = 0;
    std::vector<std::string> rejects;
    void publishFill(const std::string&, const std::string&, const std::string&,
                     const std::string&, const std::string&, uint64_t price, uint64_t,
                     bool, bool, bool) override { ++fills; last_fill_price = price; }
    void publishTrade(const std::string&, uint64_t, uint64_t) override {}
    void publishDepth(const std::string&, const nlohmann::json&) override {}
    void publishOrderStatus(const std::string&, const std::string& oid,
                            const std::string&, const std::string& status,
                            const std::string&, uint64_t, uint64_t, bool,
                            const std::string&) override {
        if (status == "REJECTED") rejects.push_back(oid);
    }
    void flush(int) override {}
};

static OrderPtr mk(const std::string& id, const std::string& u, const std::string& s,
                   bool buy, uint64_t px, uint64_t q, const std::string& type = "LIMIT") {
    auto o = std::make_shared<Order>();
    o->setOrderId(id); o->setUserId(u); o->setSymbol(s);
    o->setIsBuy(buy); o->setPrice(px); o->setOrderQty(q); o->setOrderType(type);
    return o;
}
static int failures = 0;
static void check(bool c, const std::string& n, const std::string& extra = "") {
    std::cout << (c ? "  PASS  " : "  FAIL  ") << n
              << (extra.empty() ? "" : "  (" + extra + ")") << "\n";
    if (!c) ++failures;
}

int main() {
    setenv("PRICE_BAND_PCT", "0", 1);
    setenv("VI_DYNAMIC_PCT", "0", 1);
    std::cout << "=== 복원·중복 무결성 검증 ===\n";

    // ── ① 같은 order_id 재유입은 북에 이중 등록되지 않는다 ──────────────
    {
        MockProducer p; MarketDataHandler h(&p); EngineCore e(&h);
        e.addOrder(mk("dup1", "userA", "AAA", false, 100, 10));
        check(e.hasOrder("AAA", "dup1"), "resting 주문 등록됨");

        // 리플레이가 같은 ADD를 재전달 (dedup TTL 내라 Layer 1이 잡는다)
        bool second = e.addOrder(mk("dup1", "userA", "AAA", false, 100, 10));
        check(!second, "★ 같은 order_id 재유입 거부(이중 등록 차단)");

        // 매수 10주면 정확히 10주만 체결되어야 한다(20주가 아니라)
        e.addOrder(mk("b1", "userB", "AAA", true, 100, 10));
        check(p.fills == 1, "체결 1건 — 유령 사본과의 추가 체결 없음",
              "fills=" + std::to_string(p.fills));
        check(!e.hasOrder("AAA", "dup1"), "전량 체결된 주문은 맵에서 제거됨");
    }

    // ── ② 스냅샷 왕복: 복원 후 같은 ADD가 재유입돼도 이중 등록 없음 ──────
    {
        MockProducer p1; MarketDataHandler h1(&p1); EngineCore e1(&h1);
        e1.addOrder(mk("s1", "userA", "BBB", false, 100, 10));
        std::string snap = e1.snapshotOrderBook("BBB");
        check(!snap.empty(), "스냅샷 생성됨");

        MockProducer p2; MarketDataHandler h2(&p2); EngineCore e2(&h2);
        check(e2.restoreOrderBook("BBB", snap), "스냅샷 복원 성공");
        check(e2.hasOrder("BBB", "s1"), "복원된 주문이 맵에 존재");

        // 앵커 리플레이가 같은 주문을 다시 흘려보낸 상황
        bool re = e2.addOrder(mk("s1", "userA", "BBB", false, 100, 10));
        check(!re, "★ 복원 후 리플레이 재유입 거부(dedup 시딩 동작)");

        // 10주 매수 → 10주만 체결되어야 함
        e2.addOrder(mk("b1", "userB", "BBB", true, 100, 10));
        check(p2.fills == 1, "복원분과 1회만 체결", "fills=" + std::to_string(p2.fills));
    }

    // ── ③ IOC 취소된 주문이 맵에 잔류하지 않는다 ────────────────────────
    {
        MockProducer p; MarketDataHandler h(&p); EngineCore e(&h);
        // 상대 호가 없는 시장가 매도(IOC) → 전량 미체결 취소
        auto ioc = mk("ioc1", "userA", "CCC", false, 0, 10, "MARKET");
        ioc->setConditions(liquibook::book::oc_immediate_or_cancel);
        e.addOrder(ioc);
        check(!e.hasOrder("CCC", "ioc1"),
              "★ IOC 취소 주문이 order_maps_에 잔류하지 않음(스냅샷 유령 방지)");

        // 스냅샷에도 실리지 않아야 한다
        std::string snap = e.snapshotOrderBook("CCC");
        check(snap.find("ioc1") == std::string::npos,
              "★ 취소된 IOC가 스냅샷에 포함되지 않음");
    }

    // ── ④ 부분체결 주문은 잔량으로 복원된다(수량 팽창 없음) ──────────────
    {
        MockProducer p1; MarketDataHandler h1(&p1); EngineCore e1(&h1);
        e1.addOrder(mk("big", "userA", "DDD", false, 100, 100));  // 100주 매도
        e1.addOrder(mk("sm", "userB", "DDD", true, 100, 30));     // 30주 체결 → 잔량 70
        check(p1.fills == 1, "부분체결 발생");

        std::string snap = e1.snapshotOrderBook("DDD");
        MockProducer p2; MarketDataHandler h2(&p2); EngineCore e2(&h2);
        check(e2.restoreOrderBook("DDD", snap), "부분체결 주문 복원");

        // 복원 후 100주 매수를 넣으면 잔량 70주만 체결되어야 한다.
        // 수량이 팽창(100주로 부활)했다면 100주가 체결된다.
        MockProducer& p = p2;
        int before = p.fills;
        e2.addOrder(mk("buy100", "userC", "DDD", true, 100, 100));
        check(p.fills == before + 1, "복원분과 체결 발생");
        // 잔량 70만 있었으면 buy100은 30주가 남아 북에 resting 상태로 있어야 한다
        check(e2.hasOrder("DDD", "buy100"),
              "★ 잔량 70주만 체결 → 매수 30주가 미체결로 남음(수량 팽창 없음)");
    }

    // ── ⑤ VI: halt 유발 체결가로 기준가가 세탁되지 않는다 ────────────────
    // halt 발동 후에도 VI 기준가는 충격 이전 가격(100)에 동결되어야 한다. 105로 갱신되면
    // 해제 후 105가 정상가로 취급되어 같은 폭으로 계속 밀 수 있다(halt가 조작을 지연만 시킴).
    {
        setenv("VI_DYNAMIC_PCT", "0.03", 1);
        setenv("VI_HALT_SECONDS", "0", 1);   // 즉시 만료 → 거부 없이 다음 체결 관찰 가능
        MockProducer p; MarketDataHandler h(&p); EngineCore e(&h);

        e.addOrder(mk("s", "mmA", "EEE", false, 100, 10));
        e.addOrder(mk("b", "userB", "EEE", true, 100, 10));       // last=100 기준 확립
        e.addOrder(mk("s2", "mmA", "EEE", false, 105, 10));
        e.addOrder(mk("b2", "userB", "EEE", true, 105, 10));      // +5% → halt (기준가 동결)

        // halt_seconds=0이라 즉시 해제되어 다음 주문은 통과한다. 이때 103으로 체결하면:
        //  - 기준가가 105로 세탁됐다면 103은 -1.9%라 halt 미발동
        //  - 기준가가 100으로 동결됐다면 103은 +3%라 halt 재발동
        e.addOrder(mk("s3", "mmA", "EEE", false, 103, 10));
        e.addOrder(mk("b3", "userB", "EEE", true, 103, 10));
        check(e.isHalted("EEE") || e.viReferencePrice("EEE") == 100,
              "★ 기준가 동결: 충격 이전 가격(100) 유지 — 조작가가 정상가로 세탁되지 않음",
              "ref=" + std::to_string(e.viReferencePrice("EEE")));
    }

    // ── ⑥ MARKET BUY(collar)는 가격밴드로 거부되지 않는다 ────────────────
    {
        setenv("VI_DYNAMIC_PCT", "0", 1);
        setenv("PRICE_BAND_PCT", "0.10", 1);   // ±10%
        MockProducer p; MarketDataHandler h(&p); EngineCore e(&h);
        e.addOrder(mk("s", "mmA", "FFF", false, 100, 10));
        e.addOrder(mk("b", "userB", "FFF", true, 100, 10));       // last=100, 밴드 [90,110]

        // MARKET BUY는 collar로 price=max_price(예: 200)가 실려 온다 — 호가가 아니라 상한.
        auto mkt = mk("mbuy", "userC", "FFF", true, 200, 5, "MARKET");
        mkt->setConditions(liquibook::book::oc_immediate_or_cancel);
        e.addOrder(mkt);
        bool rejected = false;
        for (auto& r : p.rejects) if (r == "mbuy") rejected = true;
        check(!rejected, "★ MARKET BUY(collar 200)가 밴드로 거부되지 않음");

        // LIMIT 200은 여전히 밴드 밖이라 거부되어야 한다
        e.addOrder(mk("lim", "userC", "FFF", true, 200, 5));
        bool limRejected = false;
        for (auto& r : p.rejects) if (r == "lim") limRejected = true;
        check(limRejected, "LIMIT 200은 밴드 밖이라 거부(밴드 자체는 유효)");
    }

    std::cout << "=== " << (failures == 0 ? "ALL PASS" : std::to_string(failures) + " FAIL")
              << " ===\n";
    return failures == 0 ? 0 : 1;
}
