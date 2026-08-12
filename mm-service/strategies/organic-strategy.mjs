/**
 * OrganicStrategy — legacy_sine를 대체하는 자연스러운 시장 생성 전략 (M2).
 *
 * legacy_sine의 3대 결함을 해소한다:
 *   1) 결정론적 사인파 → PriceProcess(OU+Hawkes+regime): 예측 불가 → 무위험 차익 제거
 *   2) 동일가·동일수량 자가체결 → 에이전트 풀(mm-agent-N)이 서로 다른 ID로 ZI-C 호가 →
 *      서로 다른 ID 간 체결이라 자가체결(wash) 시그니처 회피
 *   3) 고정 tradeQuantity → OrderSize(라운드넘버 군집+기하 꼬리): Benford 통과
 *
 * 매 틱: 가격 프로세스 진행 → fair price 산출 → 에이전트들이 fair 주변에 예약가 분산 호가.
 * 일부 교차 주문으로 실제 체결·캔들 생성, 나머지는 호가창 깊이를 채운다.
 * 취소 주기로 stale 호가를 정리(주문 수명 유한 → 호가창이 살아있게).
 */

import BaseStrategy from "./base-strategy.mjs";
import PriceProcess from "../utils/price-process.mjs";
import OrderSize from "../utils/order-size.mjs";
import { PutRecordCommand } from "@aws-sdk/client-kinesis";
import { v4 as uuidv4 } from "uuid";

export default class OrganicStrategy extends BaseStrategy {
  constructor(symbol, config, deps) {
    super(symbol, config, deps);

    this.priceProcess = new PriceProcess({
      basePrice: this.config.basePrice,
      amplitude: this.config.amplitude,
      period: this.config.period,
    });
    this.orderSize = new OrderSize({
      geomMean: this.config.tradeQuantity || 30,
      maxSize: this.config.maxOrderSize || 1000,
    });

    // 에이전트 풀: mm-agent-0..N. 서로 다른 ID라 자가체결 시그니처 회피.
    this.agentCount = Math.max(2, this.config.agentCount || 4);

    this._lastTick = Date.now();
    this._ticksSinceCancel = 0;
    this.currentPrice = this.config.basePrice;
  }

  get strategyName() {
    return "organic";
  }

  _agentId(i) {
    return `mm-agent-${i % this.agentCount}`;
  }

  /** 특정 user_id로 주문 발행(base.sendOrder는 side로 ID를 고정하므로 여기서 별도 구현). */
  async _sendAgentOrder(userId, side, price, quantity) {
    const orderId = uuidv4();
    const order = {
      user_id: userId,
      order_id: orderId,
      symbol: this.symbol,
      side,
      order_type: "LIMIT",
      quantity,
      price,
      timestamp: Date.now(),
    };
    try {
      await this.kinesis.send(new PutRecordCommand({
        StreamName: this.kinesisStream,
        Data: Buffer.from(JSON.stringify(order)),
        PartitionKey: this.symbol,
      }));
      this.orderManager.trackOrder(this.symbol, orderId, side, price, quantity);
      this._orderCount++;
      return { success: true, orderId };
    } catch (err) {
      console.error(`[organic] order failed ${side} ${this.symbol}:`, err.message);
      return { success: false, orderId: null };
    }
  }

  async execute(tick) {
    // 1) 가격 프로세스 진행 (경과 실시간 기준)
    const now = Date.now();
    const dt = Math.max(0.001, (now - this._lastTick) / 1000);
    this._lastTick = now;
    const fair = this.priceProcess.step(dt);
    this.currentPrice = fair;

    // 2) 주기적 취소 — stale 호가 정리(주문 수명 유한)
    this._ticksSinceCancel++;
    if (this._ticksSinceCancel >= (this.config.cancelInterval || 5)) {
      this._ticksSinceCancel = 0;
      await this.orderManager.cancelAllForSymbol(this.symbol);
      await new Promise((r) => setTimeout(r, 50));
    }

    // 3) 에이전트들이 fair 주변에 ZI-C 예약가로 분산 호가.
    //    각 에이전트는 fair 대비 랜덤 스프레드(예약가 제약)로 매수/매도 중 하나를 낸다.
    const spreadFrac = this.config.spread || 0.02;
    const orders = [];
    for (let i = 0; i < this.agentCount; i++) {
      const side = Math.random() < 0.5 ? "BUY" : "SELL";
      // ZI-C: 예약가는 fair에서 랜덤하게 벗어난 값(매수는 낮게, 매도는 높게 편향)
      const offset = (0.2 + Math.random()) * spreadFrac; // 0.2~1.2 × spread
      const price = side === "BUY"
        ? Math.max(1, Math.round(fair * (1 - offset)))
        : Math.max(1, Math.round(fair * (1 + offset)));
      const qty = this.orderSize.sample();
      orders.push({ agent: i, side, price, quantity: qty });
    }

    // 4) 일부는 교차(체결)되도록 fair 근처 반대 호가를 소수 삽입 → 실제 거래·캔들 생성
    if (Math.random() < (this.config.crossProb ?? 0.5)) {
      const takerSide = Math.random() < 0.5 ? "BUY" : "SELL";
      const price = takerSide === "BUY"
        ? Math.round(fair * (1 + spreadFrac))   // 매수가 매도호가를 넘어서 체결
        : Math.round(fair * (1 - spreadFrac));
      orders.push({
        agent: Math.floor(Math.random() * this.agentCount),
        side: takerSide, price: Math.max(1, price), quantity: this.orderSize.sample(),
      });
    }

    // SELL 먼저(파티션 순서로 구주문 오체결 방지)
    orders.sort((a, b) => (a.side === "SELL" ? -1 : 1));
    for (const o of orders) {
      await this._sendAgentOrder(this._agentId(o.agent), o.side, o.price, o.quantity);
    }

    // 5) 상태 저장
    await this.operatingCache.set(`mm:price:${this.symbol}`, String(fair));
    await this.operatingCache.set(`mm:orderCount:${this.symbol}`, String(this._orderCount));
    await this.operatingCache.set(`mm:lastTick:${this.symbol}`, String(now));
  }

  async cleanup() {
    await super.cleanup();
  }
}
