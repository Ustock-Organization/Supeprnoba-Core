/**
 * SineStrategy - v9 사인파 마켓메이킹 (legacy_sine)
 *
 * 기존 index.mjs의 calculatePrice() + runSymbol() 로직을
 * BaseStrategy 기반으로 1:1 이식한 하위 호환 전략.
 *
 * 가격 = basePrice * (1 + amplitude * sin(2π * t / period))
 *
 * 매 틱마다 SELL → BUY 순서로 동일 가격 주문을 발행하여
 * 자가 체결(wash trade)을 일으켜 캔들/호가 데이터를 생성합니다.
 */

import BaseStrategy from "./base-strategy.mjs";

export default class SineStrategy extends BaseStrategy {
  /**
   * @param {string} symbol
   * @param {Object} config
   * @param {Object} deps
   */
  constructor(symbol, config, deps) {
    super(symbol, { ...config, strategy: "legacy_sine" }, deps);
    this._startedAt = Date.now();
  }

  get strategyName() {
    return "legacy_sine";
  }

  /**
   * 사인파 가격 계산 — index.mjs calculatePrice()와 동일.
   * @param {number} elapsedSec - 시작 후 경과 시간 (초)
   * @returns {number} 정수 가격 (최소 1)
   */
  _calculatePrice(elapsedSec) {
    const { basePrice, period, amplitude } = this.config;
    const swing = amplitude * Math.sin((2 * Math.PI * elapsedSec) / period);
    return Math.max(1, Math.round(basePrice * (1 + swing)));
  }

  /**
   * 매 틱마다 호출 — SELL을 먼저 발행하여 잔존 매수호가 체결 방지.
   * @param {{ elapsed: number, tickCount: number }} tick
   */
  async execute(tick) {
    const elapsedSec = (Date.now() - this._startedAt) / 1000;
    const price = this._calculatePrice(elapsedSec);
    const quantity = this.config.tradeQuantity;

    // v9 핵심: SELL → BUY 순서 (같은 Kinesis 파티션 → 순서 보장)
    await this.sendOrder("SELL", price, quantity);
    await this.sendOrder("BUY", price, quantity);

    this.currentPrice = price;

    // Operating Cache에 가격/주문 수/생존 시각 저장 (Streamer → Admin 전달용)
    await this.operatingCache.set(`mm:price:${this.symbol}`, price.toString());
    await this.operatingCache.set(`mm:orderCount:${this.symbol}`, this._orderCount.toString());
    await this.operatingCache.set(`mm:lastTick:${this.symbol}`, Date.now().toString());
  }
}
