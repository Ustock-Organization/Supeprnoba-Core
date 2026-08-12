// M3 재고 스큐 검증 — calculateInventorySkew (Hummingbot 선형, bid+ask=2.0).
import InventoryTracker from "../utils/inventory.mjs";

let failures = 0;
function check(cond, name) {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name);
  if (!cond) failures++;
}
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const inv = new InventoryTracker(null); // 순수 계산이라 cache 불요

console.log("=== M3 재고 스큐 검증 ===");

// 1. 중립(netPosition=0): 대칭
{
  const s = inv.calculateInventorySkew(0, 500);
  check(approx(s.bidMultiplier, 1) && approx(s.askMultiplier, 1), "중립: bid=ask=1");
  check(approx(s.bidMultiplier + s.askMultiplier, 2), "중립: 합=2.0");
}

// 2. 롱 과다(절반): 매수 줄이고 매도 늘림
{
  const s = inv.calculateInventorySkew(250, 500); // ratio=0.5
  check(approx(s.bidMultiplier, 0.5), "롱 절반: bid 배수 0.5");
  check(approx(s.askMultiplier, 1.5), "롱 절반: ask 배수 1.5");
  check(approx(s.bidMultiplier + s.askMultiplier, 2), "롱 절반: 합=2.0");
}

// 3. 숏 과다(절반): 매수 늘리고 매도 줄임
{
  const s = inv.calculateInventorySkew(-250, 500); // ratio=-0.5
  check(approx(s.bidMultiplier, 1.5), "숏 절반: bid 배수 1.5");
  check(approx(s.askMultiplier, 0.5), "숏 절반: ask 배수 0.5");
}

// 4. 밴드 경계(롱 최대): 매수 0, 매도만
{
  const s = inv.calculateInventorySkew(500, 500); // ratio=1
  check(approx(s.bidMultiplier, 0), "롱 최대: bid 배수 0 (매수 중단)");
  check(approx(s.askMultiplier, 2), "롱 최대: ask 배수 2");
}

// 5. 밴드 초과: 클램프되어 여전히 [0,2] 합2.0
{
  const s = inv.calculateInventorySkew(1000, 500); // ratio clamp 1
  check(approx(s.bidMultiplier, 0) && approx(s.askMultiplier, 2), "밴드 초과: 클램프(0,2)");
  check(s.bidMultiplier >= 0 && s.askMultiplier <= 2, "클램프: 범위 [0,2] 유지");
}

// 6. 숏 최대: 매도 0, 매수만
{
  const s = inv.calculateInventorySkew(-500, 500);
  check(approx(s.bidMultiplier, 2), "숏 최대: bid 배수 2");
  check(approx(s.askMultiplier, 0), "숏 최대: ask 배수 0 (매도 중단)");
}

// 7. 합 불변성 — 임의 포지션에서 항상 2.0
{
  let allTwo = true;
  for (let q = -600; q <= 600; q += 37) {
    const s = inv.calculateInventorySkew(q, 500);
    if (!approx(s.bidMultiplier + s.askMultiplier, 2)) allTwo = false;
  }
  check(allTwo, "합 불변: 전 구간에서 bid+ask=2.0");
}

// 8. positionLimit=0 방어(0 나눗셈 없이 soft 기본 사용)
{
  const s = inv.calculateInventorySkew(100, 0);
  check(Number.isFinite(s.bidMultiplier) && Number.isFinite(s.askMultiplier),
        "limit=0 방어: 유한값 반환");
}

console.log("=== " + (failures === 0 ? "ALL PASS" : failures + " FAIL") + " ===");
process.exit(failures === 0 ? 0 : 1);
