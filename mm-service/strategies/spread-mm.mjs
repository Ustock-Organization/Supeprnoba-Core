/**
 * SpreadStrategy - Core Spread Market-Making Strategy
 *
 * Places bid/ask orders around a reference price, using inventory-aware
 * adjustments to manage position risk. Extends BaseStrategy.
 *
 * Execution flow (each tick):
 *   1. Determine reference price (internalFeed → priceFeed → sine fallback)
 *   2. Load current inventory position from Redis
 *   3. Check circuit breaker — if STOPPED, skip tick
 *   4. Calculate Avellaneda-Stoikov reservation price (inventory-shifted)
 *   5. Build bid/ask with spread + trend bias
 *   6. Taper quantities based on position utilization
 *   7. Replace orders every cancelInterval ticks (SELL-first ordering)
 *   8. Persist current price to Redis
 *
 * Why SELL before BUY:
 *   Kinesis partition key = symbol, so records within a partition are ordered.
 *   If BUY goes first, it may match against stale sell orders from the
 *   previous cycle. SELL-first ensures the new ask is in the book before
 *   the new bid arrives.
 *
 * @module strategies/spread-mm
 */

import BaseStrategy from "./base-strategy.mjs";

export default class SpreadStrategy extends BaseStrategy {
  constructor(symbol, config, deps) {
    super(symbol, config, deps);
    /** @type {number} ticks since last order replacement */
    this._ticksSinceReplace = 0;
  }

  /** @override */
  get strategyName() {
    return "spread";
  }

  /**
   * Main tick handler — called every tickInterval ms.
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
      console.log(
        `[spread] ${this.symbol} STOPPED — net=${pos.netPosition}, limit=${posLimit}`
      );
      return;
    }

    if (cb.status === "CRITICAL") {
      console.log(
        `[spread] ${this.symbol} CRITICAL — net=${pos.netPosition}, canBuy=${cb.canBuy}, canSell=${cb.canSell}`
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

    // ── 5. Bid / Ask with spread + trend bias ───────────────────
    const { spread, trendBias } = this.config;
    let bid = Math.round(reservation * (1 - spread / 2));
    let ask = Math.round(reservation * (1 + spread / 2));

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
    ask = Math.max(bid + 1, ask); // ask always > bid

    // ── 6. Tapered quantities ───────────────────────────────────
    const baseQty = this.config.tradeQuantity;
    let buyQty = this.inventory.calculateTaperedQuantity(
      baseQty, "BUY", pos.netPosition, posLimit
    );
    let sellQty = this.inventory.calculateTaperedQuantity(
      baseQty, "SELL", pos.netPosition, posLimit
    );

    // Apply circuit breaker direction limits
    if (!cb.canBuy) buyQty = 0;
    if (!cb.canSell) sellQty = 0;

    // ── 7. Order replacement (every cancelInterval ticks) ───────
    this._ticksSinceReplace++;

    if (this._ticksSinceReplace >= this.config.cancelInterval) {
      this._ticksSinceReplace = 0;

      const newOrders = [];
      if (sellQty > 0) newOrders.push({ side: "SELL", price: ask, quantity: sellQty });
      if (buyQty > 0) newOrders.push({ side: "BUY", price: bid, quantity: buyQty });

      // SELL first, then BUY — maintain v9 ordering guarantee
      newOrders.sort((a, b) => (a.side === "SELL" ? -1 : 1));

      await this.orderManager.replaceOrders(
        this.symbol,
        newOrders,
        this.sendOrder.bind(this)
      );
    }

    // ── 8. Update state ─────────────────────────────────────────
    this.currentPrice = Math.round((bid + ask) / 2);
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

  /**
   * Override cleanup to cancel all open orders for this symbol.
   */
  async cleanup() {
    await super.cleanup();
  }

  /**
   * Enriched status including inventory and spread info.
   * @override
   */
  getStatus() {
    return {
      ...super.getStatus(),
      ticksSinceReplace: this._ticksSinceReplace,
    };
  }

  // ── Private helpers ─────────────────────────────────────────

  /**
   * Resolve the best available reference price.
   *
   * Priority:
   *   1. internalFeed (depth cache mid-price from real orderbook)
   *   2. priceFeed with external correlation applied to basePrice
   *   3. sine wave fallback (smooth transition from legacy v9)
   *
   * @param {number} elapsed - seconds since strategy started
   * @returns {number} reference price
   */
  async _resolveReferencePrice(elapsed) {
    // 1. Internal feed — real orderbook mid-price (async: reads from Redis)
    if (this.internalFeed) {
      const best = await this.internalFeed.getBestPrice(this.symbol);
      if (best && best > 0) return best;
    }

    // 2. External feed — apply correlation to base price (sync)
    if (this.priceFeed && this.priceFeed.isConnected()) {
      const influenced = this.priceFeed.applyExternalInfluence(
        this.config.basePrice,
        this.config.correlation
      );
      if (influenced && influenced > 0) return influenced;
    }

    // 3. Sine wave fallback
    return this._sinePrice(elapsed);
  }

  /**
   * Legacy sine wave price calculation — identical to v9 for smooth transition.
   *
   * @param {number} elapsed - seconds since strategy started
   * @returns {number} price (integer, minimum 1)
   */
  _sinePrice(elapsed) {
    const { basePrice, period, amplitude } = this.config;
    const swing = amplitude * Math.sin((2 * Math.PI * elapsed) / period);
    return Math.max(1, Math.round(basePrice * (1 + swing)));
  }
}
