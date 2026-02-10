/**
 * Order Manager for MM Service v10
 *
 * Tracks active MM orders and sends CANCEL actions via Kinesis.
 * The C++ Matching Engine reads CANCEL messages from the supernoba-orders
 * stream and removes matching orders from the orderbook.
 *
 * Data structure: Map<symbol, Map<orderId, { side, price, quantity, ts }>>
 *
 * Key design choices:
 * - 50ms spacing between sequential cancels to stay within Kinesis shard limits
 * - Fire-and-forget: cancel failures leave the order tracked for retry next cycle
 * - Partition key = symbol, matching the existing order publish pattern
 */

import { PutRecordCommand } from "@aws-sdk/client-kinesis";

export default class OrderManager {
  /**
   * @param {import("@aws-sdk/client-kinesis").KinesisClient} kinesis
   * @param {string} streamName - Kinesis stream name (supernoba-orders)
   */
  constructor(kinesis, streamName) {
    this.kinesis = kinesis;
    this.streamName = streamName;

    /** @type {Map<string, Map<string, {side: string, price: number, quantity: number, ts: number}>>} */
    this.orders = new Map();
  }

  // ── Tracking ───────────────────────────────────────────────

  /**
   * Track a newly placed order.
   * Call this right after sendOrder() succeeds.
   */
  trackOrder(symbol, orderId, side, price, quantity) {
    if (!this.orders.has(symbol)) {
      this.orders.set(symbol, new Map());
    }
    this.orders.get(symbol).set(orderId, {
      side,
      price,
      quantity,
      ts: Date.now(),
    });
  }

  /**
   * Remove an order from tracking (e.g., when filled via Engine callback).
   * @returns {boolean} true if the order was found and removed
   */
  removeOrder(symbol, orderId) {
    const symbolOrders = this.orders.get(symbol);
    if (!symbolOrders) return false;
    const removed = symbolOrders.delete(orderId);
    if (symbolOrders.size === 0) this.orders.delete(symbol);
    return removed;
  }

  /**
   * Get a copy of all active orders for a symbol.
   * @returns {Array<{orderId: string, side: string, price: number, quantity: number, ts: number}>}
   */
  getActiveOrders(symbol) {
    const symbolOrders = this.orders.get(symbol);
    if (!symbolOrders) return [];
    return Array.from(symbolOrders.entries()).map(([orderId, info]) => ({
      orderId,
      ...info,
    }));
  }

  /**
   * @returns {number} count of active orders for a symbol
   */
  getActiveOrderCount(symbol) {
    const symbolOrders = this.orders.get(symbol);
    return symbolOrders ? symbolOrders.size : 0;
  }

  // ── Cancellation ───────────────────────────────────────────

  /**
   * Cancel a single order via Kinesis CANCEL action.
   *
   * The Engine expects:
   *   { action: "CANCEL", order_id, user_id, symbol, timestamp }
   *
   * @returns {boolean} true if cancel was sent successfully
   */
  async cancelOrder(symbol, orderId) {
    const symbolOrders = this.orders.get(symbol);
    if (!symbolOrders) return false;

    const order = symbolOrders.get(orderId);
    if (!order) return false;

    const userId = order.side === "BUY" ? "mm-buyer" : "mm-seller";

    const cancelMsg = {
      action: "CANCEL",
      order_id: orderId,
      user_id: userId,
      symbol,
      timestamp: Date.now(),
    };

    try {
      await this.kinesis.send(
        new PutRecordCommand({
          StreamName: this.streamName,
          Data: Buffer.from(JSON.stringify(cancelMsg)),
          PartitionKey: symbol,
        })
      );

      symbolOrders.delete(orderId);
      if (symbolOrders.size === 0) this.orders.delete(symbol);

      console.log(
        `[OrderMgr] Cancelled ${order.side} ${orderId.slice(0, 8)}.. for ${symbol} @ ${order.price}`
      );
      return true;
    } catch (e) {
      // Fire-and-forget: log but don't throw.
      // Order stays tracked so it can be retried next cycle.
      console.error(
        `[OrderMgr] Cancel failed for ${orderId.slice(0, 8)}.. (${symbol}):`,
        e.message
      );
      return false;
    }
  }

  /**
   * Cancel ALL active orders for a symbol.
   * Sends cancels sequentially with 50ms spacing to avoid Kinesis burst.
   *
   * @returns {number} count of successfully cancelled orders
   */
  async cancelAllForSymbol(symbol) {
    const symbolOrders = this.orders.get(symbol);
    if (!symbolOrders || symbolOrders.size === 0) return 0;

    const orderIds = Array.from(symbolOrders.keys());
    let cancelled = 0;

    for (let i = 0; i < orderIds.length; i++) {
      const success = await this.cancelOrder(symbol, orderIds[i]);
      if (success) cancelled++;

      // 50ms spacing between cancels (skip after last)
      if (i < orderIds.length - 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    console.log(
      `[OrderMgr] cancelAllForSymbol(${symbol}): ${cancelled}/${orderIds.length} cancelled`
    );
    return cancelled;
  }

  // ── Replace (cancel + place new) ──────────────────────────

  /**
   * Atomic replace: cancel all existing orders for a symbol, then place new ones.
   *
   * @param {string} symbol
   * @param {Array<{side: string, price: number, quantity: number}>} newOrders
   * @param {(side: string, price: number, quantity: number) => Promise<{success: boolean, orderId: string}>} sendOrderFn
   *   The caller's order-sending function (e.g. strategy.sendOrder.bind(strategy)).
   *   Must return { success, orderId }. Tracking is done inside sendOrderFn.
   * @returns {Array<{success: boolean, orderId: string|null}>}
   */
  async replaceOrders(symbol, newOrders, sendOrderFn) {
    // 1) Cancel all existing orders
    await this.cancelAllForSymbol(symbol);

    // 2) Wait 100ms for Engine to process cancels before placing new orders
    await new Promise((r) => setTimeout(r, 100));

    // 3) Place new orders (sendOrderFn is expected to call trackOrder internally,
    //    e.g. BaseStrategy.sendOrder() already tracks — no double-tracking here)
    const results = [];
    for (const order of newOrders) {
      try {
        const result = await sendOrderFn(
          order.side,
          order.price,
          order.quantity
        );
        results.push({
          success: result.success,
          orderId: result.orderId || null,
        });
      } catch (e) {
        console.error(
          `[OrderMgr] replaceOrders send failed (${symbol} ${order.side}):`,
          e.message
        );
        results.push({ success: false, orderId: null });
      }
    }

    return results;
  }

  // ── Housekeeping ───────────────────────────────────────────

  /** Clear all tracked orders (call on shutdown). */
  clearAll() {
    const total = this.getTotalOrderCount();
    this.orders.clear();
    if (total > 0) {
      console.log(`[OrderMgr] Cleared ${total} tracked orders`);
    }
  }

  /** @returns {number} total tracked orders across all symbols */
  getTotalOrderCount() {
    let total = 0;
    for (const symbolOrders of this.orders.values()) {
      total += symbolOrders.size;
    }
    return total;
  }

  /**
   * Stats for status reporting (published via mm:status).
   * @returns {{ totalOrders: number, symbols: Record<string, number> }}
   */
  getStats() {
    const symbols = {};
    let totalOrders = 0;
    for (const [symbol, symbolOrders] of this.orders) {
      symbols[symbol] = symbolOrders.size;
      totalOrders += symbolOrders.size;
    }
    return { totalOrders, symbols };
  }
}
