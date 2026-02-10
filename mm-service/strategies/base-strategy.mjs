/**
 * BaseStrategy - MM 전략 추상 클래스
 *
 * 모든 MM 전략은 이 클래스를 상속하여 execute()를 구현해야 합니다.
 *
 * Dependencies (injected via constructor):
 * - kinesis: KinesisClient instance
 * - operatingCache: ioredis instance (port 6382)
 * - orderManager: OrderManager instance (주문 추적/취소)
 * - inventory: InventoryTracker instance (포지션 관리)
 * - priceFeed: PriceFeed instance (외부 가격, optional)
 * - internalFeed: InternalFeed instance (내부 가격, optional)
 * - config: { kinesisStream, awsRegion }
 */

import { v4 as uuidv4 } from "uuid";
import { PutRecordCommand } from "@aws-sdk/client-kinesis";

/** @type {Object} v9 legacy + v10 new defaults */
const DEFAULT_CONFIG = {
  // Legacy v9
  basePrice: 100,
  period: 600,
  amplitude: 0.1,
  tickInterval: 1000,
  tradeQuantity: 10,
  // v10 new fields
  strategy: "legacy_sine",
  spread: 0.02,
  depthLevels: 3,
  depthDecay: 0.5,
  externalFeed: "none",
  externalSymbol: "btcusdt",
  correlation: 0.3,
  cancelInterval: 5,
  maxOpenOrders: 10,
  trendBias: 0,
  positionLimit: 500,
};

export default class BaseStrategy {
  /**
   * @param {string} symbol - 거래 종목 (e.g. "AAPL")
   * @param {Object} config - 종목별 MM 설정 (DEFAULT_CONFIG와 병합)
   * @param {Object} deps - 외부 의존성
   * @param {import("@aws-sdk/client-kinesis").KinesisClient} deps.kinesis
   * @param {import("ioredis").Redis} deps.operatingCache
   * @param {Object} deps.orderManager
   * @param {Object} deps.inventory
   * @param {Object} [deps.priceFeed]
   * @param {Object} [deps.internalFeed]
   * @param {Object} deps.config - { kinesisStream, awsRegion }
   */
  constructor(symbol, config, deps) {
    if (new.target === BaseStrategy) {
      throw new Error("BaseStrategy is abstract — instantiate a subclass instead");
    }

    this.symbol = symbol;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Dependencies
    this.kinesis = deps.kinesis;
    this.operatingCache = deps.operatingCache;
    this.orderManager = deps.orderManager;
    this.inventory = deps.inventory;
    this.priceFeed = deps.priceFeed || null;
    this.internalFeed = deps.internalFeed || null;
    this.kinesisStream = deps.config.kinesisStream;

    this.currentPrice = this.config.basePrice;
    this._orderCount = 0;
  }

  /**
   * Strategy type identifier — override in subclass.
   * @returns {string}
   */
  get strategyName() {
    throw new Error("strategyName must be overridden by subclass");
  }

  /**
   * Main tick handler — called every tickInterval.
   * @param {{ elapsed: number, tickCount: number }} tick
   * @returns {Promise<void>}
   */
  async execute(tick) {
    throw new Error("execute() must be overridden by subclass");
  }

  /**
   * Cancel all active orders and log cleanup.
   * @returns {Promise<void>}
   */
  async cleanup() {
    const cancelled = await this.orderManager.cancelAllForSymbol(this.symbol);
    console.log(`[${this.strategyName}] cleanup ${this.symbol}: cancelled ${cancelled} orders`);
  }

  /**
   * Return a snapshot of the strategy's current state.
   * @returns {Object}
   */
  getStatus() {
    return {
      strategy: this.strategyName,
      symbol: this.symbol,
      currentPrice: this.currentPrice,
      orderCount: this._orderCount,
      config: this.config,
    };
  }

  /**
   * Build an order payload and send it to Kinesis.
   *
   * The payload matches the exact format the C++ Matching Engine expects:
   * { user_id, order_id, symbol, side, order_type, quantity, price, timestamp }
   *
   * @param {"BUY"|"SELL"} side
   * @param {number} price
   * @param {number} quantity
   * @returns {Promise<{ success: boolean, orderId: string|null }>}
   */
  async sendOrder(side, price, quantity) {
    const orderId = uuidv4();
    const order = {
      user_id: side === "BUY" ? "mm-buyer" : "mm-seller",
      order_id: orderId,
      symbol: this.symbol,
      side,
      order_type: "LIMIT",
      quantity,
      price,
      timestamp: Date.now(),
    };

    try {
      await this.kinesis.send(
        new PutRecordCommand({
          StreamName: this.kinesisStream,
          Data: Buffer.from(JSON.stringify(order)),
          PartitionKey: this.symbol,
        })
      );

      this.orderManager.trackOrder(this.symbol, orderId, side, price, quantity);
      this._orderCount++;

      console.log(
        `[${this.strategyName}] ${side} ${this.symbol} @ ${price} x ${quantity} (${orderId.slice(0, 8)})`
      );

      return { success: true, orderId };
    } catch (err) {
      console.error(
        `[${this.strategyName}] order failed ${side} ${this.symbol}:`,
        err.message
      );
      return { success: false, orderId: null };
    }
  }
}
