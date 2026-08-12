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
import CpmmBackstop from "../utils/cpmm.mjs";
import { PutRecordCommand } from "@aws-sdk/client-kinesis";
import { v4 as uuidv4 } from "uuid";

const CPMM_KEY = (sym) => `mm:cpmm:${sym}`;

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

    // CPMM 유계손실 백스톱 — 봇의 순지급을 시드 예산으로 수학적으로 상한한다.
    // 상태는 Redis에 영속한다: 인메모리로만 두면 재시작마다 예산이 y₀로 복구되어
    // "재시작 1회당 y₀"가 되고, 크래시가 잦으면 캡이 사실상 사라진다.
    this.cpmm = null;
    this._cpmmLoaded = false;
  }

  /** CPMM 상태 로드(최초 1회) — 저장분이 없으면 새로 시드한다. */
  async _loadCpmm() {
    if (this._cpmmLoaded) return this.cpmm;
    this._cpmmLoaded = true;
    try {
      const raw = await this.operatingCache.get(CPMM_KEY(this.symbol));
      this.cpmm = raw ? CpmmBackstop.fromJSON(raw) : null;
    } catch (e) {
      console.error(`[organic] CPMM 로드 실패 ${this.symbol}:`, e.message);
      this.cpmm = null;
    }
    if (!this.cpmm) {
      this.cpmm = new CpmmBackstop({
        basePrice: this.config.basePrice,
        budget: this.config.cpmmBudget || (this.config.basePrice || 100) * 10000,
      });
      await this._saveCpmm();
      console.log(`[organic] CPMM 신규 시드 ${this.symbol}: budget=${this.cpmm.y0}`);
    }
    return this.cpmm;
  }

  async _saveCpmm() {
    if (!this.cpmm) return;
    try {
      await this.operatingCache.set(CPMM_KEY(this.symbol), JSON.stringify(this.cpmm.toJSON()));
    } catch (e) {
      console.error(`[organic] CPMM 저장 실패 ${this.symbol}:`, e.message);
    }
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
    // 0) VI halt 확인 — 정지된 종목에 계속 호가를 대면 전량 거부되고(거부 폭풍),
    //    재개 시 단일가가 왜곡된다. 엔진이 symbol:{S}:state에 HALTED를 기록한다.
    const state = await this.operatingCache.get(`symbol:${this.symbol}:state`);
    if (state === "HALTED") {
      await this.orderManager.cancelAllForSymbol(this.symbol);
      console.log(`[organic] ${this.symbol} HALTED — 호가 철회 후 대기`);
      return;
    }

    // 1) 가격 프로세스 진행 (경과 실시간 기준)
    const now = Date.now();
    const dt = Math.max(0.001, (now - this._lastTick) / 1000);
    this._lastTick = now;
    const fair = this.priceProcess.step(dt);
    this.currentPrice = fair;

    // 2) 재고 방어선 — 이것이 없으면 봇이 한 방향으로 무한히 재고를 쌓으며
    //    무제한 발권이 된다(MM은 정산에서 잔고·보유가 갱신되지 않는다).
    //    백엔드가 체결마다 mm:inventory를 갱신(M1)하고 여기서 소비한다.
    const posLimit = this.config.positionLimit || 500;
    const pos = await this.inventory.getPosition(this.symbol);
    const cb = this.inventory.checkCircuitBreaker(pos.netPosition, {
      soft: posLimit, hard: posLimit * 2, kill: posLimit * 4,
    });

    // 2-b) 직전 틱 이후의 순재고 변화만큼 CPMM 곡선을 전진시켜 예산을 실제로 소진시킨다.
    //      봇이 순매수(재고 증가)했다 = 유저에게 현금을 지급했다 = 발권 방향.
    //      곡선 공식이 아니라 "실제 체결로 변한 재고"를 진실원천으로 삼는다.
    {
      const cpmm = await this._loadCpmm();
      if (this._lastNetPosition != null) {
        const delta = pos.netPosition - this._lastNetPosition;
        if (delta > 0) cpmm.sellToBot(delta);        // 유저가 봇에게 매도 → 봇 현금 지급
        else if (delta < 0) cpmm.buyFromBot(-delta); // 유저가 봇에게서 매수 → 봇 현금 회수
        if (delta !== 0) await this._saveCpmm();
      }
      this._lastNetPosition = pos.netPosition;
    }
    if (cb.status === "STOPPED") {
      // 호가를 걷고 멈춘다. 걷지 않으면 마지막 사이클의 호가가 오더북에 영구히 남아
      // 킬 스위치가 걸린 뒤에도 체결이 계속되고 시세 기준을 왜곡한다.
      await this.orderManager.cancelAllForSymbol(this.symbol);
      console.log(`[organic] ${this.symbol} STOPPED — net=${pos.netPosition}, limit=${posLimit}`);
      return;
    }

    // 3) 에이전트들이 fair 주변에 ZI-C 예약가로 분산 호가.
    //    각 에이전트는 fair 대비 랜덤 스프레드(예약가 제약)로 매수/매도 중 하나를 낸다.
    //    재고가 한쪽으로 기울면 side 선택 확률을 반대로 편향시켜 되돌린다(스큐).
    const spreadFrac = this.config.spread || 0.02;
    const skew = this.inventory.calculateInventorySkew(pos.netPosition, posLimit);
    // bidMult+askMult=2.0. 재고가 많으면(net>0) 매도 쪽 확률을 키운다.
    const buyProb = Math.max(0.05, Math.min(0.95, skew.bidMultiplier / 2));

    // CPMM 예산 게이트: 봇의 매수(유저→봇 매도)는 화폐를 발행하는 방향이다.
    // 준비금이 바닥나면 매수 호가를 철회한다(EVE 비대칭 원칙: 무제한 매도는 안전,
    // 무제한 매수는 위험). 이 게이트가 없으면 봇 예산은 사실상 무한이다.
    const cpmm = await this._loadCpmm();
    const payoutFloor = cpmm.y0 * 0.02;
    const cpmmCanBuy = cpmm.remainingPayoutCapacity() > payoutFloor;
    if (!cpmmCanBuy) {
      console.log(`[organic] ${this.symbol} CPMM 예산 소진 — 매수 호가 철회 ` +
                  `(순지급 ${Math.round(cpmm.netPaidOut())}/${cpmm.y0})`);
    }

    const orders = [];
    for (let i = 0; i < this.agentCount; i++) {
      let side = Math.random() < buyProb ? "BUY" : "SELL";
      // 서킷브레이커 CRITICAL: 재고를 늘리는 방향은 금지
      if (side === "BUY" && cb.canBuy === false) side = "SELL";
      else if (side === "SELL" && cb.canSell === false) side = "BUY";
      // CPMM 예산 소진 시 매수 금지(발권 차단)
      if (side === "BUY" && !cpmmCanBuy) side = "SELL";
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
