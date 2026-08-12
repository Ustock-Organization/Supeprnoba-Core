// M2 organic 전략 검증 — 에이전트 풀 다양성·크기 분포·자가체결 회피·팩토리 등록.
// mock kinesis/redis로 발행된 주문을 수집해 검증.

function mulberry32(seed){return function(){seed|=0;seed=(seed+0x6D2B79F5)|0;let t=Math.imul(seed^(seed>>>15),1|seed);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
Math.random = mulberry32(777);

const { default: OrganicStrategy } = await import("../strategies/organic-strategy.mjs");
const { default: OrderManager } = await import("../utils/order-manager.mjs");

let failures = 0;
function check(cond, name, extra="") {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name + (extra?"  ("+extra+")":""));
  if (!cond) failures++;
}

// 발행 주문을 수집하는 mock kinesis
const published = [];
const mockKinesis = {
  send: async (cmd) => {
    const data = JSON.parse(Buffer.from(cmd.input.Data).toString());
    published.push(data);
    return {};
  },
};
// 키-값을 실제로 보관하는 mock (CPMM 영속 검증에 필요)
const store = new Map();
const mockRedis = {
  set: async (k, v) => { store.set(k, v); },
  get: async (k) => (store.has(k) ? store.get(k) : null),
};

// organic은 재고 방어선(M1 체결 피드백)을 실제로 소비한다 — null이면 동작하지 않는다.
const { default: InventoryTracker } = await import("../utils/inventory.mjs");
function makeInventory(netPosition = 0) {
  const inv = new InventoryTracker(mockRedis);
  inv.getPosition = async () => ({ netPosition, totalBought: 0, totalSold: 0, limit: 2000 });
  return inv;
}

const deps = {
  kinesis: mockKinesis,
  operatingCache: mockRedis,
  orderManager: new OrderManager(mockKinesis, "supernoba-orders"),
  inventory: makeInventory(0),
  priceFeed: null,
  internalFeed: null,
  config: { kinesisStream: "supernoba-orders" },
};

const config = {
  basePrice: 1000, amplitude: 0.1, period: 600,
  strategy: "organic", agentCount: 4, tradeQuantity: 30,
  spread: 0.02, cancelInterval: 5, crossProb: 0.5, maxOrderSize: 1000,
};

console.log("=== M2 organic 전략 검증 ===");

const strat = new OrganicStrategy("AAA", config, deps);
check(strat.strategyName === "organic", "strategyName == organic");

// 여러 틱 실행
for (let i = 0; i < 40; i++) {
  await strat.execute({ elapsed: i, tickCount: i });
}

check(published.length > 0, "메시지 발행됨", `n=${published.length}`);

// 신규 주문(LIMIT 발주)과 취소(action=CANCEL) 분리.
// 취소는 OrderManager가 mm-buyer/mm-seller ID로 발행하나 매칭은 order_id로만 하므로 무해.
const newOrders = published.filter((o) => o.action !== "CANCEL" && o.order_type);
const cancels = published.filter((o) => o.action === "CANCEL");

check(newOrders.length > 0, "신규 주문 존재", `new=${newOrders.length} cancel=${cancels.length}`);

// 1. 신규 주문은 전부 mm-agent-N ID (자가체결 STP 면제 대상, mm- 접두사)
{
  const allAgents = newOrders.every((o) => /^mm-agent-\d+$/.test(o.user_id));
  check(allAgents, "신규 주문 전부 mm-agent-N ID (isMmId mm- 접두사 인식)");
}

// 2. 에이전트 풀 다양성 — 여러 에이전트가 사용됨
{
  const uniqueAgents = new Set(newOrders.map((o) => o.user_id));
  check(uniqueAgents.size >= 3, "에이전트 다양성: 3+ 에이전트 사용", `agents=${uniqueAgents.size}`);
}

// 3. 주문 크기 다양성 — 고정값 아님(legacy_sine 결함 제거)
{
  const sizes = new Set(newOrders.map((o) => o.quantity));
  check(sizes.size > 5, "크기 다양성: 고정 아님", `unique=${sizes.size}`);
}

// 4. 가격 다양성 — 사인파의 동일가 자가체결 결함 제거
{
  const prices = new Set(newOrders.map((o) => o.price));
  check(prices.size > 10, "가격 다양성: 동일가 아님", `unique=${prices.size}`);
}

// 5. 매수/매도 양방향 존재
{
  const buys = newOrders.filter((o) => o.side === "BUY").length;
  const sells = newOrders.filter((o) => o.side === "SELL").length;
  check(buys > 0 && sells > 0, "양방향 호가 존재", `buy=${buys} sell=${sells}`);
}

// 6. 전량 LIMIT, 양수 가격·수량
{
  const valid = newOrders.every((o) =>
    o.order_type === "LIMIT" && o.price >= 1 && o.quantity >= 1);
  check(valid, "주문 유효성: LIMIT·양수 가격/수량");
}

// 7. 라운드넘버 군집(주문 크기가 인간처럼)
{
  const roundHits = newOrders.filter((o) =>
    [1,5,10,50,100,200,500].includes(o.quantity)).length;
  check(roundHits / newOrders.length > 0.3, "라운드넘버 군집 존재",
        `frac=${(roundHits/newOrders.length*100).toFixed(0)}%`);
}

// ── 8. 재고 방어선이 실제로 배선되어 있다 (감사 D2) ────────────────────
// 이전엔 organic이 InventoryTracker를 한 번도 호출하지 않아 5단계 방어선이
// 통째로 우회됐다(inventory: null로도 테스트가 통과하던 것이 증거).
{
  let called = false;
  const inv = makeInventory(0);
  const orig = inv.getPosition;
  inv.getPosition = async (s) => { called = true; return orig(s); };
  const s = new OrganicStrategy("CHK", config, { ...deps, inventory: inv });
  await s.execute({ elapsed: 0, tickCount: 0 });
  check(called, "★ 재고 방어선 배선됨 (InventoryTracker.getPosition 호출)");
}

// ── 9. 서킷브레이커 STOPPED면 호가를 걷고 멈춘다 (감사 D4) ──────────────
{
  const before = published.length;
  // netPosition이 kill 임계(positionLimit×4=2000)를 넘으면 STOPPED
  const s = new OrganicStrategy("STOP", { ...config, positionLimit: 500 },
                                { ...deps, inventory: makeInventory(99999) });
  await s.execute({ elapsed: 0, tickCount: 0 });
  const emitted = published.slice(before);
  const newOrdersAfter = emitted.filter((o) => o.action !== "CANCEL" && o.order_type);
  check(newOrdersAfter.length === 0, "★ STOPPED: 신규 호가 발행 없음",
        `n=${newOrdersAfter.length}`);
}

// ── 10. VI halt 중이면 호가를 걷고 대기한다 (감사 C10/D-halt) ───────────
{
  store.set("symbol:HALT:state", "HALTED");
  const before = published.length;
  const s = new OrganicStrategy("HALT", config, deps);
  await s.execute({ elapsed: 0, tickCount: 0 });
  const emitted = published.slice(before);
  const newOrdersAfter = emitted.filter((o) => o.action !== "CANCEL" && o.order_type);
  check(newOrdersAfter.length === 0, "★ HALTED: 신규 호가 발행 없음",
        `n=${newOrdersAfter.length}`);
}

// ── 11. CPMM 예산이 Redis에 영속된다 (감사 D1) ─────────────────────────
// 인메모리로만 두면 재시작마다 예산이 y₀로 복구되어 캡이 무의미해진다.
{
  const s = new OrganicStrategy("CPMM", config, deps);
  await s.execute({ elapsed: 0, tickCount: 0 });
  const saved = store.get("mm:cpmm:CPMM");
  check(!!saved, "★ CPMM 상태가 Redis에 저장됨");
  if (saved) {
    const st = JSON.parse(saved);
    check(st.y0 > 0 && st.x > 0 && st.y > 0, "CPMM 상태 유효(x,y,y0 > 0)",
          `y0=${st.y0}`);
    // 재시작 시뮬레이션: 같은 키로 새 인스턴스를 만들면 저장분을 복원해야 한다
    const s2 = new OrganicStrategy("CPMM", config, deps);
    const restored = await s2._loadCpmm();
    check(Math.abs(restored.y - st.y) < 1e-6 && restored.y0 === st.y0,
          "★ 재시작 후 CPMM 예산 복원(리셋 안 됨)",
          `y=${restored.y.toFixed(2)}`);
  }
}

// ── 12. CPMM 예산 소진 시 매수(발권 방향) 호가가 철회된다 ────────────────
{
  // 준비금을 바닥 근처로 만들어 저장 → 매수 호가가 나오면 안 된다
  const s = new OrganicStrategy("DRY", config, deps);
  const c = await s._loadCpmm();
  c.y = c.y0 * 0.01;          // floor(2%) 미만
  c.x = c.k / c.y;
  await s._saveCpmm();

  const before = published.length;
  const s2 = new OrganicStrategy("DRY", config, deps);
  await s2.execute({ elapsed: 0, tickCount: 0 });
  const emitted = published.slice(before)
    .filter((o) => o.action !== "CANCEL" && o.order_type);
  const buys = emitted.filter((o) => o.side === "BUY").length;
  check(emitted.length > 0 && buys === 0,
        "★ CPMM 예산 소진: 매수 호가 없음(무한 발권 차단)",
        `total=${emitted.length} buy=${buys}`);
}

console.log("=== " + (failures === 0 ? "ALL PASS" : failures + " FAIL") + " ===");
process.exit(failures === 0 ? 0 : 1);
