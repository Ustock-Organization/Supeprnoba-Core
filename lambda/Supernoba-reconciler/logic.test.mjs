// Reconciler/Sweeper 순수 로직 검증.
import { isStalePending, refundPlan, userLockDrift, reconcileSummary } from "./logic.mjs";

let failures = 0;
function check(cond, name, extra = "") {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name + (extra ? "  (" + extra + ")" : ""));
  if (!cond) failures++;
}

const NOW = 1_700_000_000_000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

console.log("=== 스위퍼: isStalePending ===");
check(isStalePending({ status: "PENDING", created_at: iso(20 * 60000) }, NOW, 10 * 60000),
  "20분 된 PENDING → 블랙홀");
check(!isStalePending({ status: "PENDING", created_at: iso(2 * 60000) }, NOW, 10 * 60000),
  "2분 된 PENDING → 아직 아님");
// PENDING_CANCEL은 취소 요청 시각(updated_at) 기준 + 더 긴 임계.
// created_at 기준으로 재면, 오래 열려 있던 주문을 사용자가 방금 취소한 순간 즉시
// stale로 잡혀 엔진의 정상 환불과 겹쳐 이중환불이 난다.
check(isStalePending({ status: "PENDING_CANCEL", created_at: iso(600 * 60000), updated_at: iso(90 * 60000) },
  NOW, 10 * 60000, 60 * 60000),
  "PENDING_CANCEL: 취소 후 90분 → 대상");
check(!isStalePending({ status: "PENDING_CANCEL", created_at: iso(600 * 60000), updated_at: iso(5 * 60000) },
  NOW, 10 * 60000, 60 * 60000),
  "★ 오래된 주문을 방금 취소 → 아직 대상 아님(엔진 환불과 경합 방지)");
check(!isStalePending({ status: "PENDING_CANCEL", created_at: iso(600 * 60000) }, NOW, 10 * 60000, 60 * 60000),
  "PENDING_CANCEL에 updated_at 없으면 제외");
check(!isStalePending({ status: "ACCEPTED", created_at: iso(60 * 60000) }, NOW, 10 * 60000),
  "ACCEPTED는 블랙홀 아님(정상 대기)");
check(!isStalePending({ status: "FILLED", created_at: iso(60 * 60000) }, NOW, 10 * 60000),
  "FILLED 제외");
check(!isStalePending({ status: "PENDING" }, NOW, 10 * 60000), "created_at 없으면 제외");

console.log("=== 스위퍼: refundPlan ===");
{
  const p = refundPlan({ user_id: "u1", order_id: "o1", status: "PENDING", lock_amount: 5000 });
  check(p && p.refundAmount === 5000 && p.userId === "u1" && p.expectedStatus === "PENDING",
    "환불 계획: lock_amount 5000 반환");
}
{
  const p = refundPlan({ user_id: "u1", order_id: "o2", status: "PENDING", lock_amount: 0 });
  check(p && p.refundAmount === 0, "잠금 0이면 환불 0(주문만 취소)");
}
check(refundPlan({ status: "FILLED" }) === null, "FILLED는 환불 계획 없음");

// ★ 부분체결 이중환불 방지: 체결분의 잠금은 엔진이 이미 소진했으므로 미체결분만 환불한다.
//   전액 환불하면 wallet.locked가 음수가 되며 그 차액만큼 자금이 창출된다.
{
  const p = refundPlan({ user_id: "u1", order_id: "o3", status: "PENDING_CANCEL",
    lock_amount: 1000, quantity: 100, filled_qty: 50 });
  check(p && p.refundAmount === 500, "★ 100주 중 50주 체결 → 절반(500)만 환불",
    `refund=${p && p.refundAmount}`);
}
{
  const p = refundPlan({ user_id: "u1", order_id: "o4", status: "PENDING_CANCEL",
    lock_amount: 1000, quantity: 100, filled_qty: 100 });
  check(p && p.refundAmount === 0, "★ 전량 체결 → 환불 0(이중환불 차단)",
    `refund=${p && p.refundAmount}`);
}
{
  const p = refundPlan({ user_id: "u1", order_id: "o5", status: "PENDING",
    lock_amount: 1000, quantity: 100, filled_qty: 0 });
  check(p && p.refundAmount === 1000, "미체결 → 전액 환불");
}
{
  // 데이터 이상(quantity 누락)인데 체결 흔적이 있으면 보수적으로 0
  const p = refundPlan({ user_id: "u1", order_id: "o6", status: "PENDING",
    lock_amount: 1000, filled_qty: 30 });
  check(p && p.refundAmount === 0, "수량 불명 + 체결 있음 → 보수적으로 환불 0");
}

console.log("=== 리컨실러: userLockDrift ===");
{
  // wallet.locked=5000, 열린 BUY 주문 lock 합 5000 → 일치
  const d = userLockDrift(5000, [
    { side: "BUY", status: "PENDING", lock_amount: 3000 },
    { side: "BUY", status: "ACCEPTED", lock_amount: 2000 },
  ]);
  check(d.ok && d.drift === 0, "일치: drift 0", `exp=${d.expected} act=${d.actual}`);
}
{
  // wallet.locked=8000 이지만 열린 주문 lock 합 5000 → 3000 갇힘(블랙홀 드리프트)
  const d = userLockDrift(8000, [{ side: "BUY", status: "PENDING", lock_amount: 5000 }]);
  check(!d.ok && d.drift === 3000, "블랙홀 드리프트 감지: +3000 갇힘", `drift=${d.drift}`);
}
{
  // SELL 주문은 현금 불변식에서 제외
  const d = userLockDrift(3000, [
    { side: "BUY", status: "PENDING", lock_amount: 3000 },
    { side: "SELL", status: "PENDING", lock_amount: 999 },
  ]);
  check(d.ok, "SELL 주문 제외(현금 아닌 주식 잠금)");
}
{
  // 취소/체결된 주문은 열린 것으로 안 침
  const d = userLockDrift(0, [{ side: "BUY", status: "CANCELLED", lock_amount: 5000 }]);
  check(d.ok && d.expected === 0, "닫힌 주문 제외");
}

console.log("=== 리컨실러: reconcileSummary ===");
{
  const s = reconcileSummary([
    { userId: "a", drift: 0, ok: true },
    { userId: "b", drift: 3000, ok: false },
    { userId: "c", drift: -100, ok: false },
  ]);
  check(s.totalUsers === 3 && s.drifted.length === 2 && s.totalDrift === 3100,
    "요약: 이상치 2명, 총 드리프트 3100");
}

console.log("=== " + (failures === 0 ? "ALL PASS" : failures + " FAIL") + " ===");
process.exit(failures === 0 ? 0 : 1);
