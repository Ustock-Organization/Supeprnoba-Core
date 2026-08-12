/**
 * Reconciler/Sweeper 순수 로직 (P0 감시 검사관).
 *
 * 두 역할:
 *  1) 주문 블랙홀 스위퍼: 엔진 다운 등으로 오래 PENDING에 갇힌 주문을 찾아 잠긴 자금을 환불.
 *     (엔진 재시작 시 스냅샷/DynamoDB 복원 필터가 ACCEPTED/PARTIAL_FILL만 보므로 PENDING은 영구 방치됐음)
 *  2) 잔고 보존 리컨실러: 유저별 wallet.locked가 열린 BUY 주문의 lock_amount 합과 일치하는지 감시.
 *     불일치 = 자금 갇힘(블랙홀) 또는 누수 → 알람.
 *
 * 여기는 부작용 없는 순수 함수만. DynamoDB I/O는 index.mjs가 담당(테스트 용이).
 */

// PENDING 계열 상태(아직 엔진에 반영/매칭되지 않아 자금만 잠긴 상태)
const PENDING_STATUSES = new Set(["PENDING", "PENDING_CANCEL"]);

/**
 * 주문이 "블랙홀"인지 — PENDING 계열이면서 임계 시간보다 오래됨.
 * @param {{status:string, created_at?:string}} order
 * @param {number} nowMs
 * @param {number} thresholdMs  이 시간보다 오래 PENDING이면 블랙홀로 간주
 * @returns {boolean}
 */
export function isStalePending(order, nowMs, thresholdMs) {
  if (!order || !PENDING_STATUSES.has(order.status)) return false;
  if (!order.created_at) return false;
  const created = Date.parse(order.created_at);
  if (Number.isNaN(created)) return false;
  return nowMs - created >= thresholdMs;
}

/**
 * 블랙홀 주문의 환불 계획. lock_amount를 wallet.locked→available로 되돌리고 주문 CANCELLED.
 * 멱등: 주문 상태가 여전히 원래 PENDING 계열일 때만 적용(조건부) → 중복 스윕 무해.
 * @param {{user_id:string, order_id:string, status:string, lock_amount?:number}} order
 * @returns {{userId:string, orderId:string, refundAmount:number, expectedStatus:string}|null}
 */
export function refundPlan(order) {
  if (!order || !PENDING_STATUSES.has(order.status)) return null;
  const amount = Number(order.lock_amount || 0);
  if (!(amount > 0)) {
    // 잠긴 금액이 없으면 환불 없이 주문만 취소하면 됨
    return { userId: order.user_id, orderId: order.order_id, refundAmount: 0,
             expectedStatus: order.status };
  }
  return { userId: order.user_id, orderId: order.order_id, refundAmount: amount,
           expectedStatus: order.status };
}

/**
 * 유저별 잔고 보존 드리프트: wallet.locked가 그 유저의 열린 BUY 주문 lock_amount 합과 일치해야 한다.
 * (BUY 주문은 현금을 잠근다. SELL은 보유주식을 잠그므로 이 현금 불변식에서 제외.)
 * @param {number} walletLocked
 * @param {Array<{side:string, status:string, lock_amount?:number}>} userOpenOrders
 * @param {number} [epsilon] 허용 오차(부동소수)
 * @returns {{expected:number, actual:number, drift:number, ok:boolean}}
 */
export function userLockDrift(walletLocked, userOpenOrders, epsilon = 1e-6) {
  const OPEN = new Set(["PENDING", "PENDING_CANCEL", "ACCEPTED", "PARTIAL_FILL"]);
  let expected = 0;
  for (const o of userOpenOrders || []) {
    if (o.side === "BUY" && OPEN.has(o.status)) {
      expected += Number(o.lock_amount || 0);
    }
  }
  const actual = Number(walletLocked || 0);
  const drift = actual - expected;
  return { expected, actual, drift, ok: Math.abs(drift) <= epsilon };
}

/**
 * 전체 리컨실 요약 — 유저별 드리프트 목록에서 이상치만 추린다.
 * @param {Array<{userId:string, expected:number, actual:number, drift:number, ok:boolean}>} perUser
 * @returns {{totalUsers:number, drifted:Array, totalDrift:number}}
 */
export function reconcileSummary(perUser) {
  const drifted = (perUser || []).filter((u) => !u.ok);
  const totalDrift = (perUser || []).reduce((a, u) => a + Math.abs(u.drift), 0);
  return { totalUsers: (perUser || []).length, drifted, totalDrift };
}

export { PENDING_STATUSES };
