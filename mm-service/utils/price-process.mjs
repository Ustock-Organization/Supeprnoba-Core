/**
 * PriceProcess — 사인파를 대체하는 확률적 가격 생성기 (M2).
 *
 * 3층 구조 (합성 시장데이터 리서치 기반):
 *   1) Regime (3-state CTMC: bull/bear/range) → 로그 중심선의 드리프트를 결정
 *   2) OU 평균회귀 (로그가격에 정확해 이산화) → 밴드 내 확률적 진동
 *   3) Hawkes 변조 점프 → 팻테일 + 변동성 클러스터링 (자기여기)
 *
 * 왜: legacy_sine은 price=f(t)가 결정론적이라 주기·위상을 파악하면 무위험 차익거래가
 * 가능(= 가상화폐 무한 발권). 확률적 평균회귀 + 레짐 이동 중심선 + 자기여기 점프는
 * 미래 가격을 예측 불가능하게 만들어 이 익스플로잇을 원천 차단한다(방어 레벨 L3~L4).
 *
 * 하위호환 파라미터 매핑:
 *   basePrice → 초기 중심가, amplitude → OU 정상상태 로그표준편차, period → OU 회귀 시간스케일.
 *
 * 결정론 불필요: mm-service는 실런타임이므로 Math.random 사용(워크플로 스크립트 제약과 무관).
 */

// 표준정규 난수 (Box-Muller)
function gaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// 3 레짐: 로그 중심선 드리프트(초당). range=0, bull=+, bear=−.
const REGIMES = ["range", "bull", "bear"];

export default class PriceProcess {
  /**
   * @param {Object} cfg
   * @param {number} cfg.basePrice   - 초기·기준 중심가
   * @param {number} cfg.amplitude   - OU 정상상태 로그 표준편차(≈ ±상대변동폭). 기본 0.1
   * @param {number} cfg.period      - OU 회귀 시간스케일(초). 반감기 ≈ period/2π. 기본 600
   * @param {number} [cfg.regimeDrift]     - bull/bear 레짐의 |로그드리프트|(초당). 기본 amplitude/period*2
   * @param {number} [cfg.regimeSwitchSec] - 평균 레짐 지속(초). 기본 900(15분)
   * @param {number} [cfg.jumpBaseIntensity] - Hawkes 기저 점프강도(회/초). 기본 1/120
   * @param {number} [cfg.jumpExcitation]    - 자기여기 α. 기본 0.5
   * @param {number} [cfg.jumpDecay]         - 감쇠 β(초^-1). 기본 1/30. 정상성 α/β<1 필요
   * @param {number} [cfg.jumpStd]           - 로그 점프 크기 표준편차. 기본 0.015
   */
  constructor(cfg = {}) {
    this.basePrice = cfg.basePrice > 0 ? cfg.basePrice : 100;
    this.amplitude = cfg.amplitude > 0 ? cfg.amplitude : 0.1;
    this.period = cfg.period > 0 ? cfg.period : 600;

    // OU 파라미터 (로그가격 공간)
    // 회귀속도 λ: period를 한 사이클 시간스케일로 보고 2π/period.
    this.lambda = (2 * Math.PI) / this.period;
    // 정상상태 분산 σ²/(2λ) = amplitude² → σ = amplitude·√(2λ)
    this.sigma = this.amplitude * Math.sqrt(2 * this.lambda);

    // Regime
    this.regimeDrift = cfg.regimeDrift != null
      ? cfg.regimeDrift
      : this.amplitude / this.period;
    this.regimeSwitchSec = cfg.regimeSwitchSec > 0 ? cfg.regimeSwitchSec : 900;
    this.regime = "range";

    // 중심선(logCenter)의 펀더멘털 앵커: 실제 인플루언서 인기도처럼 무한정 드리프트하지 않고
    // 기준가의 maxCenterRatio 배(기본 4x) 범위에 소프트 바운드. 이로써 가격이 유계 유지된다.
    this.maxCenterDrift = Math.log(cfg.maxCenterRatio > 1 ? cfg.maxCenterRatio : 4);

    // Hawkes 점프 (희소 대점프 + 자기여기 클러스터 → 팻테일·변동성 클러스터링).
    // 드물지만 큰 점프가 진짜 outlier가 되어 leptokurtic(초과첨도>0) 수익률 분포를 만든다.
    // ⚠ 정상성 조건: 분기비 n = α/β < 1 이어야 폭발하지 않는다.
    // branchingRatio(n)로 파라미터화하고 α = n·β로 유도 → 초임계 방지를 구조적으로 보장.
    this.jumpBaseIntensity = cfg.jumpBaseIntensity != null ? cfg.jumpBaseIntensity : 1 / 90;
    this.jumpDecay = cfg.jumpDecay != null ? cfg.jumpDecay : 1 / 40;   // β
    const n = cfg.jumpBranchingRatio != null ? cfg.jumpBranchingRatio : 0.4; // 0<n<1
    this.jumpExcitation = Math.min(0.95, Math.max(0, n)) * this.jumpDecay; // α = n·β
    this.jumpStd = cfg.jumpStd != null ? cfg.jumpStd : 0.045;
    this.jumpIntensity = this.jumpBaseIntensity; // 현재 강도(자기여기로 상승)

    // 상태 (로그가격)
    this.logPrice = Math.log(this.basePrice);
    this.logCenter = Math.log(this.basePrice); // 레짐이 이동시키는 중심선
  }

  /** 레짐 전이(CTMC 근사): dt 동안 전이 확률 = dt/평균지속. 전이 시 3-state 균등 선택. */
  _maybeSwitchRegime(dt) {
    const pSwitch = 1 - Math.exp(-dt / this.regimeSwitchSec);
    if (Math.random() < pSwitch) {
      // 현재와 다른 레짐으로 전환(고점/저점 예측 불가하게)
      const others = REGIMES.filter((r) => r !== this.regime);
      this.regime = others[Math.floor(Math.random() * others.length)];
    }
  }

  /** 현재 레짐의 로그 중심선 드리프트(초당). */
  _regimeMu() {
    if (this.regime === "bull") return this.regimeDrift;
    if (this.regime === "bear") return -this.regimeDrift;
    return 0;
  }

  /** Hawkes 점프 샘플: dt 동안 도착한 점프들의 로그 누적치를 반환하고 강도를 갱신. */
  _hawkesJump(dt) {
    // 강도 감쇠: λ ← λ0 + (λ − λ0)·e^(−βdt)
    this.jumpIntensity =
      this.jumpBaseIntensity +
      (this.jumpIntensity - this.jumpBaseIntensity) * Math.exp(-this.jumpDecay * dt);

    // dt 동안 점프 수 ~ Poisson(λ·dt) (작은 dt에서 근사)
    const expected = this.jumpIntensity * dt;
    let n = 0;
    // Knuth Poisson
    const L = Math.exp(-expected);
    let p = 1;
    do {
      p *= Math.random();
      if (p > L) n++;
    } while (p > L && n < 50);

    let jump = 0;
    for (let i = 0; i < n; i++) {
      jump += gaussian() * this.jumpStd;
      this.jumpIntensity += this.jumpExcitation; // 자기여기: 점프가 점프를 부른다
    }
    return jump;
  }

  /**
   * dt초 진행 후 새 가격(정수, ≥1) 반환.
   * @param {number} dtSeconds
   * @returns {number}
   */
  step(dtSeconds) {
    const dt = dtSeconds > 0 ? dtSeconds : 1;

    // 1) 레짐 → 중심선 이동 (펀더멘털 앵커 범위로 소프트 바운드)
    this._maybeSwitchRegime(dt);
    this.logCenter += this._regimeMu() * dt;
    const baseLog = Math.log(this.basePrice);
    const lo = baseLog - this.maxCenterDrift;
    const hi = baseLog + this.maxCenterDrift;
    if (this.logCenter < lo) this.logCenter = lo;
    else if (this.logCenter > hi) this.logCenter = hi;

    // 2) OU 정확해 이산화 (로그가격)
    const eLd = Math.exp(-this.lambda * dt);
    const ouStd = this.sigma * Math.sqrt((1 - Math.exp(-2 * this.lambda * dt)) / (2 * this.lambda));
    this.logPrice = this.logPrice * eLd + this.logCenter * (1 - eLd) + ouStd * gaussian();

    // 3) Hawkes 점프
    this.logPrice += this._hawkesJump(dt);

    const price = Math.exp(this.logPrice);
    return Math.max(1, Math.round(price));
  }

  /** 현재 가격(진행 없이). */
  currentPrice() {
    return Math.max(1, Math.round(Math.exp(this.logPrice)));
  }
}

export { gaussian };
