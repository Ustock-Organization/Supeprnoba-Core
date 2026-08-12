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
const mockRedis = { set: async () => {}, get: async () => null };

const deps = {
  kinesis: mockKinesis,
  operatingCache: mockRedis,
  orderManager: new OrderManager(mockKinesis, "supernoba-orders"),
  inventory: null,
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

console.log("=== " + (failures === 0 ? "ALL PASS" : failures + " FAIL") + " ===");
process.exit(failures === 0 ? 0 : 1);
