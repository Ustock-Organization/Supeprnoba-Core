/**
 * OrderSize — "인간처럼 보이는" 주문 수량 분포 (M2).
 *
 * 핵심 반직관 (워시트레이딩 탐지 리서치): "무작위 크기"만으로는 부족하다.
 * 인간은 100·500 같은 라운드 넘버를 인지적 기준점으로 선호 → 실제 시장 거래 크기에는
 * 뚜렷한 라운드넘버 군집이 있다. 균등난수 크기는 오히려 "프로그램 거래" 시그니처가 되어
 * Benford 법칙·roundness 검정에 걸린다. 그래서 [Dirac 라운드넘버 혼합 + 기하 꼬리]를 쓴다.
 *
 * @param {Object} [cfg]
 * @param {number[]} [cfg.roundNumbers] - 라운드넘버 후보. 기본 [1,5,10,50,100,200,500]
 * @param {number}   [cfg.roundProb]    - 라운드넘버를 뽑을 확률. 기본 0.55
 * @param {number}   [cfg.geomMean]     - 기하분포 꼬리의 평균. 기본 30
 * @param {number}   [cfg.maxSize]      - 상한(스팸/과대 방어). 기본 1000
 */
export default class OrderSize {
  constructor(cfg = {}) {
    this.roundNumbers = cfg.roundNumbers || [1, 5, 10, 50, 100, 200, 500];
    this.roundProb = cfg.roundProb != null ? cfg.roundProb : 0.55;
    this.geomMean = cfg.geomMean > 0 ? cfg.geomMean : 30;
    this.maxSize = cfg.maxSize > 0 ? cfg.maxSize : 1000;

    // 라운드넘버 가중치: 작은 값일수록 흔하게(1/√n) — 인간 거래의 우하향 경향 반영
    this._weights = this.roundNumbers.map((n) => 1 / Math.sqrt(n));
    this._weightSum = this._weights.reduce((a, b) => a + b, 0);
  }

  _pickRound() {
    let r = Math.random() * this._weightSum;
    for (let i = 0; i < this.roundNumbers.length; i++) {
      r -= this._weights[i];
      if (r <= 0) return this.roundNumbers[i];
    }
    return this.roundNumbers[this.roundNumbers.length - 1];
  }

  // 기하분포 표본 (평균 geomMean): p = 1/mean, 역변환.
  _pickGeometric() {
    const p = 1 / this.geomMean;
    // Geometric(p) via inverse-CDF, 최소 1
    const g = Math.floor(Math.log(1 - Math.random()) / Math.log(1 - p)) + 1;
    return g;
  }

  /** 한 건의 주문 수량을 표본추출(정수 ≥1). */
  sample() {
    let size;
    if (Math.random() < this.roundProb) {
      size = this._pickRound();
    } else {
      size = this._pickGeometric();
    }
    return Math.max(1, Math.min(this.maxSize, Math.round(size)));
  }
}
