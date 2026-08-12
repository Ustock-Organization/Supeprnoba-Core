/**
 * InventoryTracker - MM Position Risk Manager
 *
 * Manages Market Maker inventory risk with 5 defense layers:
 *   1. Position Tracking    — record fills, persist net position in Redis
 *   2. Asymmetric Spread    — Avellaneda-Stoikov reservation price shift
 *   3. Quantity Tapering    — reduce overexposed side, boost recovery side
 *   4. Circuit Breaker      — soft/hard/kill limits halt trading direction
 *   5. Monitoring           — enriched status for publishStatus()
 *
 * Redis key: mm:inventory:{SYMBOL} (Operating Cache, port 6382)
 *
 * Why this matters:
 *   MM has virtual balance (bypassed in fill_processor.cpp).
 *   When a real user trades against MM, only the user's side is updated
 *   in DynamoDB. MM's net position must be tracked separately to prevent
 *   unbounded exposure.
 *
 * @module inventory
 */

/** @type {{ soft: number, hard: number, kill: number }} */
const DEFAULT_LIMITS = { soft: 500, hard: 1000, kill: 2000 };

/** Default volatility estimate when none is provided */
const DEFAULT_VOLATILITY = 0.0001;

/** Reservation price floor/ceiling relative to mid */
const RESERVATION_MIN_RATIO = 0.5;
const RESERVATION_MAX_RATIO = 2.0;

export default class InventoryTracker {
  /**
   * @param {import("ioredis").Redis} operatingCache - ioredis client (port 6382)
   */
  constructor(operatingCache) {
    this.cache = operatingCache;
  }

  // ─────────────────────────────────────────────
  // Layer 1: Position Tracking
  // ─────────────────────────────────────────────

  /**
   * Record a fill where MM was one party and a real user was the other.
   *
   * @param {string} symbol  - e.g. "AAPL"
   * @param {"BUY"|"SELL"} side - MM's side in the trade
   * @param {number} quantity - fill quantity (positive integer)
   */
  async recordFill(symbol, side, quantity) {
    const key = `mm:inventory:${symbol}`;
    const raw = await this.cache.get(key);

    let record = raw
      ? JSON.parse(raw)
      : { netPosition: 0, totalSold: 0, totalBought: 0, limit: DEFAULT_LIMITS.kill, lastUpdated: 0 };

    if (side === "SELL") {
      record.netPosition -= quantity;
      record.totalSold += quantity;
    } else {
      record.netPosition += quantity;
      record.totalBought += quantity;
    }

    record.lastUpdated = Date.now();

    await this.cache.set(key, JSON.stringify(record));
  }

  /**
   * Get current net position for a symbol.
   *
   * @param {string} symbol
   * @returns {Promise<{ netPosition: number, totalSold: number, totalBought: number, limit: number, lastUpdated: number }>}
   */
  async getPosition(symbol) {
    const raw = await this.cache.get(`mm:inventory:${symbol}`);
    if (!raw) {
      return { netPosition: 0, totalSold: 0, totalBought: 0, limit: DEFAULT_LIMITS.kill, lastUpdated: 0 };
    }
    return JSON.parse(raw);
  }

  // ─────────────────────────────────────────────
  // Layer 2: Asymmetric Spread (Avellaneda-Stoikov)
  // ─────────────────────────────────────────────

  /**
   * Calculate the Avellaneda-Stoikov reservation price.
   *
   * Formula:  reservation = midPrice - gamma * q * sigma^2
   *
   * When oversold (q < 0), reservation shifts UP  → ask becomes expensive
   * When overbought (q > 0), reservation shifts DOWN → bid becomes cheap
   *
   * @param {number} midPrice      - current mid price
   * @param {number} netPosition   - net inventory (negative = oversold)
   * @param {number} [volatility]  - sigma^2, default 0.0001
   * @param {number} [riskAversion] - gamma, default 0.5
   * @returns {number} adjusted reservation price
   */
  calculateReservationPrice(midPrice, netPosition, volatility, riskAversion = 0.5) {
    const sigma2 = volatility != null ? volatility : DEFAULT_VOLATILITY;
    const raw = midPrice - riskAversion * netPosition * sigma2;

    // Clamp to reasonable range
    const floor = midPrice * RESERVATION_MIN_RATIO;
    const ceiling = midPrice * RESERVATION_MAX_RATIO;
    return Math.max(floor, Math.min(ceiling, raw));
  }

  // ─────────────────────────────────────────────
  // Layer 3: Quantity Tapering
  // ─────────────────────────────────────────────

  /**
   * Calculate tapered quantity based on position utilization.
   *
   * Oversold  → shrink SELL qty, boost BUY qty (encourage recovery)
   * Overbought → shrink BUY qty, boost SELL qty (encourage unwinding)
   *
   * @param {number} baseQuantity   - original order quantity
   * @param {"BUY"|"SELL"} side     - order side
   * @param {number} netPosition    - current net position
   * @param {number} positionLimit  - max allowed abs(position)
   * @returns {number} adjusted quantity (integer, minimum 1)
   */
  calculateTaperedQuantity(baseQuantity, side, netPosition, positionLimit) {
    const positionRatio = Math.min(1, Math.abs(netPosition) / positionLimit);

    let adjusted = baseQuantity;

    if (netPosition < 0) {
      // Oversold — reduce sells, boost buys
      if (side === "SELL") adjusted = baseQuantity * Math.max(0, 1 - positionRatio);
      if (side === "BUY") adjusted = baseQuantity * (1 + positionRatio * 0.5);
    } else if (netPosition > 0) {
      // Overbought — reduce buys, boost sells
      if (side === "BUY") adjusted = baseQuantity * Math.max(0, 1 - positionRatio);
      if (side === "SELL") adjusted = baseQuantity * (1 + positionRatio * 0.5);
    }

    return Math.max(1, Math.round(adjusted));
  }

  /**
   * Hummingbot 스타일 인벤토리 스큐 — 매수/매도 수량 배수를 재분배한다.
   *
   * 핵심 성질: bidMultiplier + askMultiplier ≡ 2.0 (총 노출은 유지, 비중만 이동).
   * 재고가 목표(중립=0)에서 벗어난 만큼 반대 방향 체결을 촉진한다.
   *   - 롱 과다(q>0) → 매수 배수↓, 매도 배수↑ (재고 청산 유도)
   *   - 숏 과다(q<0) → 매수 배수↑, 매도 배수↓ (재고 회복 유도)
   *   - 밴드 경계(|q| ≥ positionLimit)에서 한쪽 배수가 0으로 수렴 → 한 방향만 호가.
   *
   * calculateTaperedQuantity(비대칭 0.5 부스트)와 달리 선형 [0,2]·합2.0이라
   * 재고 중립화 압력이 명확하고 예측 가능하다(Hummingbot inventory_skew).
   *
   * @param {number} netPosition   - 현재 순포지션 (롱 +, 숏 -)
   * @param {number} positionLimit - 스큐가 완전히 기우는 밴드 폭(=한쪽 배수 0 도달점)
   * @returns {{ bidMultiplier: number, askMultiplier: number, ratio: number }}
   */
  calculateInventorySkew(netPosition, positionLimit) {
    const limit = positionLimit > 0 ? positionLimit : DEFAULT_LIMITS.soft;
    // ratio ∈ [-1, 1]: +1 = 최대 롱, -1 = 최대 숏
    const ratio = Math.max(-1, Math.min(1, netPosition / limit));

    // 롱일수록 매수 줄이고 매도 늘림. 합은 항상 2.0.
    let bidMultiplier = 1 - ratio;
    let askMultiplier = 1 + ratio;

    // 방어적 클램프(부동소수 오차 대비)
    bidMultiplier = Math.max(0, Math.min(2, bidMultiplier));
    askMultiplier = Math.max(0, Math.min(2, askMultiplier));

    return { bidMultiplier, askMultiplier, ratio };
  }

  // ─────────────────────────────────────────────
  // Layer 4: Circuit Breaker
  // ─────────────────────────────────────────────

  /**
   * Check circuit breaker status.
   *
   * Three thresholds:
   *   soft  (500) → WARNING  — still trading both directions
   *   hard (1000) → CRITICAL — stop the overexposed direction only
   *   kill (2000) → STOPPED  — halt all trading
   *
   * @param {number} netPosition
   * @param {{ soft?: number, hard?: number, kill?: number }} [limits]
   * @returns {{ status: "NORMAL"|"WARNING"|"CRITICAL"|"STOPPED", canBuy: boolean, canSell: boolean }}
   */
  checkCircuitBreaker(netPosition, limits = {}) {
    const { soft = DEFAULT_LIMITS.soft, hard = DEFAULT_LIMITS.hard, kill = DEFAULT_LIMITS.kill } = limits;
    const absPos = Math.abs(netPosition);

    if (absPos >= kill) {
      return { status: "STOPPED", canBuy: false, canSell: false };
    }

    if (absPos >= hard) {
      // Stop the overexposed direction only
      if (netPosition < 0) return { status: "CRITICAL", canBuy: true, canSell: false };
      return { status: "CRITICAL", canBuy: false, canSell: true };
    }

    if (absPos >= soft) {
      return { status: "WARNING", canBuy: true, canSell: true };
    }

    return { status: "NORMAL", canBuy: true, canSell: true };
  }

  // ─────────────────────────────────────────────
  // Layer 5: Monitoring
  // ─────────────────────────────────────────────

  /**
   * Get full inventory status for monitoring/publishStatus().
   *
   * @param {string} symbol
   * @returns {Promise<Object>} enriched status object
   */
  async getStatus(symbol) {
    const pos = await this.getPosition(symbol);
    const positionLimit = pos.limit || DEFAULT_LIMITS.kill;
    const circuitBreaker = this.checkCircuitBreaker(pos.netPosition);

    return {
      symbol,
      netPosition: pos.netPosition,
      totalSold: pos.totalSold,
      totalBought: pos.totalBought,
      positionLimit,
      positionUtilization: positionLimit > 0 ? Math.abs(pos.netPosition) / positionLimit : 0,
      circuitBreaker,
      lastUpdated: pos.lastUpdated,
    };
  }

  /**
   * Reset inventory for a symbol (admin action).
   *
   * @param {string} symbol
   */
  async resetInventory(symbol) {
    await this.cache.del(`mm:inventory:${symbol}`);
    console.log(`[Inventory] Reset ${symbol}`);
  }
}
