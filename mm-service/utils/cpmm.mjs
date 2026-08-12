/**
 * CpmmBackstop — 유계 손실 마켓메이커 백스톱 (M4).
 *
 * 게임경제 리서치의 최종 권고: 오더북(주 유동성)은 그대로 두고, 심볼마다 상수곱 곡선(x·y=k)
 * 백스톱을 깔아 "롱테일 종목도 항상 거래 가능"을 보장하되, **봇이 지급하는 순 화폐가 시드 예산
 * y₀로 수학적으로 상한**이 잡히게 한다(= 가상화폐 무한 발권 원천 차단).
 *
 * 핵심 불변식 (직접 성립, 증분 집계 불필요):
 *   y_t = k / x_t > 0 이 항상 성립 →  순지급 = y₀ − y_t  <  y₀.
 *   매도(유저→봇)는 y를 낮춰 지급을 늘리고, 매수(봇→유저)는 y를 높여 회수한다.
 *   어느 경로든 y는 0에 도달하지 않으므로(점근) 순지급은 y₀ 미만으로 하드 캡.
 *   legacy_sine의 "결정론+무한예산" 무한 발권 구멍을 곡선 파라미터가 구조적으로 막는다.
 */
export default class CpmmBackstop {
  /**
   * @param {Object} cfg
   * @param {number} cfg.basePrice - 초기가(= y/x). 인플루언서 지표 등 외생값 권장.
   * @param {number} cfg.budget    - 현금 준비금 y₀ = 이 심볼의 순발권 예산(하드 캡).
   */
  constructor(cfg = {}) {
    const basePrice = cfg.basePrice > 0 ? cfg.basePrice : 100;
    const budget = cfg.budget > 0 ? cfg.budget : 100000;

    this.y0 = budget;                 // 시드 현금 = 순지급 하드 캡
    this.y = budget;                  // 현금 준비금
    this.x = budget / basePrice;      // 토큰 준비금 → 초기가 = basePrice
    this.k = this.x * this.y;
  }

  /** 현재 곡선가 = y/x */
  price() {
    return this.y / this.x;
  }

  /** 봇이 지금까지 순지급한 화폐(음수면 순수취). 항상 < y₀. */
  netPaidOut() {
    return this.y0 - this.y;
  }

  /** 추가로 지급 가능한 최대 화폐(= 현재 현금 준비금). 이보다 더는 못 준다. */
  remainingPayoutCapacity() {
    return this.y;
  }

  /**
   * 유저가 토큰 dx를 봇에게 매도 → 봇이 현금 지급(발권 방향).
   * @param {number} dx 매도 토큰 수량(>0)
   * @returns {number} 봇이 지급한 현금(체결가 반영, 슬리피지 포함)
   */
  sellToBot(dx) {
    if (!(dx > 0)) return 0;
    const xNew = this.x + dx;
    const yNew = this.k / xNew;       // y 감소(0에 점근, 절대 음수 아님)
    const payout = this.y - yNew;
    this.x = xNew;
    this.y = yNew;
    return payout;
  }

  /**
   * 유저가 봇에게서 토큰 dx를 매수 → 봇이 현금 수취(발권 아님, 회수).
   * @param {number} dx 매수 토큰 수량(>0, 현재 x 미만)
   * @returns {number} 유저가 지불한 현금(=봇 수취). x 소진 시 0(체결 불가).
   */
  buyFromBot(dx) {
    if (!(dx > 0) || dx >= this.x) return 0;   // 토큰 소진 방어
    const xNew = this.x - dx;
    const yNew = this.k / xNew;       // y 증가
    const cost = yNew - this.y;
    this.x = xNew;
    this.y = yNew;
    return cost;
  }

  /**
   * 오더북 투사용 호가 레벨 — 현재가 주변에 곡선 기반 매수/매도 지정가.
   * 예산 소진(y가 매우 작아짐) 시 매수(봇이 사줌=발권)를 철회하고 매도만 유지
   * (싱크 전환, EVE 비대칭 원칙: "고정가 무제한 매수"는 위험, "무제한 매도"는 안전).
   * @param {number} levels 편측 레벨 수
   * @param {number} stepPct 레벨 간 가격 간격(비율)
   * @param {number} sizePerLevel 레벨당 토큰 수량
   * @param {number} [minPayoutFloor] y가 이 값 이하로 떨어지면 매수 철회(기본 y₀의 2%)
   */
  quotes(levels, stepPct, sizePerLevel, minPayoutFloor) {
    const p = this.price();
    const floor = minPayoutFloor != null ? minPayoutFloor : this.y0 * 0.02;
    const canBuy = this.y > floor;    // 발권 여력 있을 때만 매수호가
    const bids = [];
    const asks = [];
    for (let i = 1; i <= levels; i++) {
      const bidPrice = Math.max(1, Math.round(p * (1 - stepPct * i)));
      const askPrice = Math.max(1, Math.round(p * (1 + stepPct * i)));
      if (canBuy) bids.push({ price: bidPrice, size: sizePerLevel });
      asks.push({ price: askPrice, size: sizePerLevel });
    }
    return { bids, asks, buyWithdrawn: !canBuy };
  }
}
