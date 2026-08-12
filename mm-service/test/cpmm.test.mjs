// M4 CPMM 백스톱 검증 — 핵심은 유계 손실(순지급 < y₀) 하드 캡 증명.
import CpmmBackstop from "../utils/cpmm.mjs";

let failures = 0;
function check(cond, name, extra = "") {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name + (extra ? "  (" + extra + ")" : ""));
  if (!cond) failures++;
}
const approx = (a, b, rel = 1e-6) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));

console.log("=== M4 CPMM 백스톱 검증 ===");

// 1. 초기가 = basePrice, 곡선 준비금 정합
{
  const c = new CpmmBackstop({ basePrice: 1000, budget: 1_000_000 });
  check(approx(c.price(), 1000), "초기가 == basePrice", `price=${c.price().toFixed(2)}`);
  check(approx(c.k, c.x * c.y), "불변식 k == x·y");
  check(c.netPaidOut() === 0, "초기 순지급 0");
}

// 2. ★ 유계 손실 하드 캡 — 극단적 매도 폭격에도 순지급 < y₀
{
  const y0 = 1_000_000;
  const c = new CpmmBackstop({ basePrice: 1000, budget: y0 });
  // 초기 토큰 x0 = 1000. 그 1000배(=100만 토큰)를 쏟아부어도...
  let totalPaid = 0;
  for (let i = 0; i < 1000; i++) {
    totalPaid += c.sellToBot(1000);   // 매번 초기 x 전체만큼 매도
  }
  check(totalPaid < y0, "★ 무제한 매도 폭격에도 총지급 < y₀ (하드 캡)",
        `paid=${totalPaid.toFixed(0)} < ${y0}`);
  check(c.y > 0, "★ 현금 준비금 y > 0 (0에 점근, 절대 음수 아님)", `y=${c.y.toFixed(2)}`);
  check(approx(c.netPaidOut(), totalPaid), "netPaidOut == 실제 총지급");
}

// 3. 곡선 볼록성 — 큰 주문일수록 평균 체결가 불리(슬리피지)
{
  const c1 = new CpmmBackstop({ basePrice: 1000, budget: 1_000_000 });
  const smallPayout = c1.sellToBot(10);     // 작은 매도
  const avgSmall = smallPayout / 10;
  const c2 = new CpmmBackstop({ basePrice: 1000, budget: 1_000_000 });
  const bigPayout = c2.sellToBot(500);      // 큰 매도
  const avgBig = bigPayout / 500;
  check(avgBig < avgSmall, "볼록성: 큰 매도의 평균 체결가가 더 낮음(슬리피지)",
        `big=${avgBig.toFixed(2)} < small=${avgSmall.toFixed(2)}`);
}

// 4. 매수는 발권이 아니라 회수 — 순지급 감소
{
  const c = new CpmmBackstop({ basePrice: 1000, budget: 1_000_000 });
  c.sellToBot(200);
  const afterSell = c.netPaidOut();
  check(afterSell > 0, "매도 후 순지급 > 0", `net=${afterSell.toFixed(0)}`);
  c.buyFromBot(200);
  const afterBuy = c.netPaidOut();
  check(afterBuy < afterSell, "매수 후 순지급 감소(회수)", `${afterBuy.toFixed(0)} < ${afterSell.toFixed(0)}`);
  check(Math.abs(afterBuy) < 1e-3, "매도→동량 매수 왕복: 순지급 ≈ 0(수수료 없는 곡선)");
}

// 5. 예산 소진 시 매수호가(발권) 철회, 매도만 유지 (EVE 비대칭)
{
  const c = new CpmmBackstop({ basePrice: 1000, budget: 100_000 });
  // y를 바닥(2% 아래)까지 밀어냄
  for (let i = 0; i < 2000; i++) c.sellToBot(100);
  const q = c.quotes(3, 0.01, 10);
  check(q.buyWithdrawn === true, "예산 소진: 매수호가 철회");
  check(q.bids.length === 0 && q.asks.length === 3, "매수 0 / 매도만 유지(싱크 전환)");
}

// 6. 정상 구간에서는 양방향 호가
{
  const c = new CpmmBackstop({ basePrice: 1000, budget: 1_000_000 });
  const q = c.quotes(3, 0.01, 10);
  check(q.bids.length === 3 && q.asks.length === 3, "정상: 양방향 3레벨 호가");
  check(q.bids[0].price < 1000 && q.asks[0].price > 1000, "호가 배치: bid<price<ask");
}

console.log("=== " + (failures === 0 ? "ALL PASS" : failures + " FAIL") + " ===");
process.exit(failures === 0 ? 0 : 1);
