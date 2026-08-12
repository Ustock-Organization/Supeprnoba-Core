/**
 * DepthStrategy - Multi-Level Orderbook Depth Market-Making
 *
 * Extends SpreadStrategy by placing MULTIPLE price levels per side,
 * creating visual orderbook depth. Each level widens the spread and
 * reduces quantity geometrically via depthDecay.
 *
 * Example (basePrice=100, spread=2%, depthDecay=0.5, tradeQty=100):
 *   SELL L1: 101 × 100  (spread 2%)
 *   SELL L2: 102 × 50   (spread 4%)
 *   SELL L3: 103 × 25   (spread 6%)
 *   BUY  L1:  99 × 100  (spread 2%)
 *   BUY  L2:  98 × 50   (spread 4%)
 *   BUY  L3:  97 × 25   (spread 6%)
 *
 * Config fields:
 *   depthLevels  (3)   — price levels per side
 *   depthDecay   (0.5) — geometric quantity decay per level
 *   maxOpenOrders(10)  — per-side cap (truncates excess levels)
 *   + all SpreadStrategy fields (spread, trendBias, positionLimit, etc.)
 *
 * @module strategies/depth-mm
 */

import SpreadStrategy from "./spread-mm.mjs";

export default class DepthStrategy extends SpreadStrategy {
  /** @override */
  get strategyName() {
    return "depth";
  }

  /**
   * Multi-level tick handler — generates depthLevels × 2 orders per cycle.
   *
   * @param {{ elapsed: number, tickCount: number }} tick
   */
  async execute(tick) {
    // ── 1. Reference price ──────────────────────────────────────
    const refPrice = await this._resolveReferencePrice(tick.elapsed);

    // ── 2. Inventory position ───────────────────────────────────
    const pos = await this.inventory.getPosition(this.symbol);

    // ── 3. Circuit breaker ──────────────────────────────────────
    const posLimit = this.config.positionLimit;
    const cb = this.inventory.checkCircuitBreaker(pos.netPosition, {
      soft: posLimit,
      hard: posLimit * 2,
      kill: posLimit * 4,
    });

    if (cb.status === "STOPPED") {
      // 호가 철회 후 정지 — 남겨두면 킬 스위치 이후에도 체결이 이어진다.
      await this.orderManager.cancelAllForSymbol(this.symbol);
      console.log(
        `[depth] ${this.symbol} STOPPED — net=${pos.netPosition}, limit=${posLimit} (호가 철회)`
      );
      return;
    }

    if (cb.status === "CRITICAL") {
      console.log(
        `[depth] ${this.symbol} CRITICAL — net=${pos.netPosition}, canBuy=${cb.canBuy}, canSell=${cb.canSell}`
      );
    }

    // ── 4. Reservation price (Avellaneda-Stoikov) ───────────────
    const riskAversion = this.config.riskAversion ?? 0.5;
    const volatility = this.config.volatility ?? 0.0001;
    const reservation = this.inventory.calculateReservationPrice(
      refPrice,
      pos.netPosition,
      volatility,
      riskAversion
    );

    // ── 5. Build multi-level orders ─────────────────────────────
    const { spread, trendBias, depthLevels, depthDecay, tradeQuantity, maxOpenOrders } = this.config;
    const newOrders = [];

    for (let level = 1; level <= depthLevels; level++) {
      // Each level adds one more spread width
      const levelSpread = spread * level;

      let bid = Math.round(reservation * (1 - levelSpread / 2));
      let ask = Math.round(reservation * (1 + levelSpread / 2));

      // Apply trend bias (shift both sides in trend direction)
      if (trendBias !== 0) {
        const biasShift = Math.round(
          reservation * Math.abs(trendBias) * spread
        );
        if (trendBias > 0) {
          bid += biasShift;
          ask += biasShift;
        } else {
          bid -= biasShift;
          ask -= biasShift;
        }
      }

      bid = Math.max(1, bid);
      ask = Math.max(bid + 1, ask);

      // Geometric decay: level 1 = 100%, level 2 = 50%, level 3 = 25% (decay=0.5)
      const levelQty = Math.max(1, Math.round(tradeQuantity * depthDecay ** (level - 1)));

      // Inventory tapering per level
      let buyQty = this.inventory.calculateTaperedQuantity(
        levelQty, "BUY", pos.netPosition, posLimit
      );
      let sellQty = this.inventory.calculateTaperedQuantity(
        levelQty, "SELL", pos.netPosition, posLimit
      );

      // Circuit breaker direction limits
      if (!cb.canBuy) buyQty = 0;
      if (!cb.canSell) sellQty = 0;

      if (sellQty > 0) newOrders.push({ side: "SELL", price: ask, quantity: sellQty });
      if (buyQty > 0) newOrders.push({ side: "BUY", price: bid, quantity: buyQty });
    }

    // Enforce maxOpenOrders per side — truncate deepest levels first
    const sells = newOrders.filter((o) => o.side === "SELL");
    const buys = newOrders.filter((o) => o.side === "BUY");
    const cappedOrders = [
      ...sells.slice(0, maxOpenOrders),
      ...buys.slice(0, maxOpenOrders),
    ];

    // Sort: all SELLs first, then BUYs (Kinesis ordering guarantee)
    cappedOrders.sort((a, b) => (a.side === "SELL" ? -1 : 1));

    // ── 6. Replace orders every cancelInterval ticks ────────────
    this._ticksSinceReplace++;

    if (this._ticksSinceReplace >= this.config.cancelInterval) {
      this._ticksSinceReplace = 0;

      await this.orderManager.replaceOrders(
        this.symbol,
        cappedOrders,
        this.sendOrder.bind(this)
      );
    }

    // ── 7. Update state (Level 1 midpoint) ──────────────────────
    const l1Bid = Math.round(reservation * (1 - spread / 2));
    const l1Ask = Math.round(reservation * (1 + spread / 2));
    this.currentPrice = Math.round((l1Bid + l1Ask) / 2);

    await this.operatingCache.set(
      `mm:price:${this.symbol}`,
      this.currentPrice.toString()
    );
    await this.operatingCache.set(
      `mm:orderCount:${this.symbol}`,
      this._orderCount.toString()
    );
    await this.operatingCache.set(
      `mm:lastTick:${this.symbol}`,
      Date.now().toString()
    );
  }

  /** @override — include depth-specific info */
  getStatus() {
    return {
      ...super.getStatus(),
      depthLevels: this.config.depthLevels,
      depthDecay: this.config.depthDecay,
    };
  }
}
