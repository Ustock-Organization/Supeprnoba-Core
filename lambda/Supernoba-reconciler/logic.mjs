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
 *
 * PENDING과 PENDING_CANCEL은 성격이 다르다:
 *  - PENDING: 엔진에 아직 도달 못 한 신규 주문. created_at 기준.
 *  - PENDING_CANCEL: 이미 (부분)체결됐을 수 있고 엔진이 취소를 처리 중일 수 있다.
 *    created_at으로 재면 오래된 주문이 취소되자마자 즉시 stale로 잡혀, 엔진이 정상
 *    취소·환불하는 주문을 스위퍼가 가로채 이중환불한다. 그래서 취소 요청 시각(updated_at)
 *    기준으로 더 긴 임계를 적용해 엔진에 처리 시간을 준다.
 * @param {{status:string, created_at?:string, updated_at?:string}} order
 * @param {number} nowMs
 * @param {number} thresholdMs  PENDING 임계
 * @param {number} [cancelThresholdMs]  PENDING_CANCEL 임계(미지정 시 thresholdMs)
 * @returns {boolean}
 */
export function isStalePending(order, nowMs, thresholdMs, cancelThresholdMs = thresholdMs) {
  if (!order || !PENDING_STATUSES.has(order.status)) return false;
  if (order.status === "PENDING_CANCEL") {
    const ts = order.updated_at ? Date.parse(order.updated_at) : NaN;
    if (Number.isNaN(ts)) return false;
    return nowMs - ts >= cancelThresholdMs;
  }
  if (!order.created_at) return false;
  const created = Date.parse(order.created_at);
  if (Number.isNaN(created)) return false;
  return nowMs - created >= thresholdMs;
}

/**
 * 블랙홀 주문의 환불 계획. 미체결 잔량에 해당하는 잠금만 wallet.locked→available로 되돌리고
 * 주문 CANCELLED.
 *
 * 핵심: lock_amount 전액이 아니라 미체결분만 환불한다. 부분체결된 주문은 체결분의 잠금이
 * 이미 소진됐기 때문(엔진이 체결마다 locked에서 price×fill_qty를 차감). 전액 환불하면
 * 이미 소진된 몫까지 되돌려 이중환불 + wallet.locked 음수가 된다.
 * 멱등: 주문 상태가 여전히 원래 PENDING 계열일 때만 적용(조건부) → 중복 스윕 무해.
 * @param {{user_id:string, order_id:string, status:string, lock_amount?:number, quantity?:number, filled_qty?:number}} order
 * @returns {{userId:string, orderId:string, refundAmount:number, expectedStatus:string}|null}
 */
export function refundPlan(order) {
  if (!order || !PENDING_STATUSES.has(order.status)) return null;
  const lockAmount = Number(order.lock_amount || 0);
  const qty = Number(order.quantity || 0);
  const filled = Number(order.filled_qty || 0);

  // 미체결 잔량 비율만큼만 환불 (부분체결 반영). 데이터가 이상하면(qty<=0 등) 보수적으로 0.
  let refund = lockAmount;
  if (qty > 0) {
    const remainingRatio = Math.max(0, Math.min(1, (qty - filled) / qty));
    refund = lockAmount * remainingRatio;
  } else if (filled > 0) {
    refund = 0;
  }

  if (!(refund > 0)) {
    // 환불할 잠금이 없으면 주문만 취소
    return { userId: order.user_id, orderId: order.order_id, refundAmount: 0,
             expectedStatus: order.status };
  }
  return { userId: order.user_id, orderId: order.order_id, refundAmount: refund,
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
