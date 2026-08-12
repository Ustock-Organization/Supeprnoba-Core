// M2 검증 하네스 — 가격 프로세스가 사인파의 결함(예측가능성)을 제거하고
// 자연스러운 통계(팻테일·평균회귀)를 갖는지, 주문 크기가 Benford를 통과하는지.
// 재현성: 시드 LCG로 Math.random 고정.

// --- 시드 PRNG (mulberry32) ---
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = mulberry32(12345);

const { default: PriceProcess } = await import("../utils/price-process.mjs");
const { default: OrderSize } = await import("../utils/order-size.mjs");

let failures = 0;
function check(cond, name, extra = "") {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name + (extra ? "  (" + extra + ")" : ""));
  if (!cond) failures++;
}

// --- 통계 유틸 ---
function excessKurtosis(xs) {
  const n = xs.length;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  let m2 = 0, m4 = 0;
  for (const x of xs) { const d = x - m; m2 += d * d; m4 += d * d * d * d; }
  m2 /= n; m4 /= n;
  return m4 / (m2 * m2) - 3;
}
// 주기 지연 자기상관 — 결정론적 주기성의 직접 지표.
// 사인파는 lag=period에서 |acf|≈1(완벽 주기), 확률적 평균회귀는 낮다(위상 랜덤·레짐 이동).
function autocorrAtLag(series, lag) {
  const n = series.length;
  const mean = series.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const d = series[i] - mean;
    den += d * d;
    if (i + lag < n) num += d * (series[i + lag] - mean);
  }
  return den > 0 ? num / den : 0;
}

console.log("=== M2 가격 프로세스 검증 ===");

// 시리즈 생성
const pp = new PriceProcess({ basePrice: 1000, amplitude: 0.1, period: 600 });
const N = 2000;
const prices = [];
for (let i = 0; i < N; i++) prices.push(pp.step(1));

// 1. 가격 양수·유한
check(prices.every((p) => p >= 1 && Number.isFinite(p)), "가격: 전부 양수·유한");

// 2. 폭주하지 않음 — 가격이 0으로 붕괴하거나 발산하지 않고 유계
{
  const within = prices.filter((p) => p > 100 && p < 15000).length / N;
  check(within > 0.9, "유계: 90%+ 가 [100,15000] 내(붕괴/발산 없음)", `within=${(within * 100).toFixed(1)}%`);
}

// 3. 팻테일 — 로그수익률 초과첨도 > 1 (점프로 인한 leptokurtic)
{
  const rets = [];
  for (let i = 1; i < N; i++) rets.push(Math.log(prices[i] / prices[i - 1]));
  const ek = excessKurtosis(rets);
  check(ek > 1, "팻테일: 로그수익률 초과첨도 > 1", `ek=${ek.toFixed(2)}`);
}

// 4. 사인파 제거 검증 — 주기 지연 자기상관으로 결정론적 주기성 판별
{
  // 순수 사인파 기준선(주기 600)
  const sine = [];
  for (let i = 0; i < N; i++) sine.push(1000 * (1 + 0.1 * Math.sin((2 * Math.PI * i) / 600)));
  const sineAcf = Math.abs(autocorrAtLag(sine, 600));
  const ouAcf = Math.abs(autocorrAtLag(prices, 600));
  check(sineAcf > 0.5, "기준선: 사인파는 주기지연 자기상관 높음", `|acf(600)|=${sineAcf.toFixed(2)}`);
  check(ouAcf < 0.35, "사인파 제거: organic은 주기성 없음(무위험 차익 불가)",
        `|acf(600)|=${ouAcf.toFixed(2)}`);
}

// 5. 결정론 아님 — 같은 basePrice로 두 인스턴스가 다른 경로
{
  const a = new PriceProcess({ basePrice: 1000 });
  const b = new PriceProcess({ basePrice: 1000 });
  const pa = [], pb = [];
  for (let i = 0; i < 100; i++) { pa.push(a.step(1)); pb.push(b.step(1)); }
  const identical = pa.every((v, i) => v === pb[i]);
  check(!identical, "비결정론: 동일 파라미터 두 경로가 상이");
}

console.log("=== M2 주문 크기 분포 검증 ===");

const os = new OrderSize();
const sizes = [];
for (let i = 0; i < 5000; i++) sizes.push(os.sample());

// 6. 전부 정수 ≥1, 상한 이내
check(sizes.every((s) => Number.isInteger(s) && s >= 1 && s <= 1000), "크기: 정수 [1,1000]");

// 7. 라운드넘버 군집 존재 (100/500 등이 유의한 비율)
{
  const roundHits = sizes.filter((s) => [1, 5, 10, 50, 100, 200, 500].includes(s)).length;
  const frac = roundHits / sizes.length;
  check(frac > 0.4, "라운드넘버 군집 존재(>40%)", `frac=${(frac * 100).toFixed(1)}%`);
}

// 8. Benford 경향 — 첫 유효숫자 1이 최빈(균등난수 시그니처 회피)
{
  const digitCount = new Array(10).fill(0);
  for (const s of sizes) {
    const d = parseInt(String(s)[0], 10);
    digitCount[d]++;
  }
  const mode = digitCount.indexOf(Math.max(...digitCount.slice(1)));
  check(mode === 1, "Benford 경향: 첫 유효숫자 1이 최빈", `d1=${digitCount[1]}, d9=${digitCount[9]}`);
  check(digitCount[1] > digitCount[9], "Benford 경향: P(1) > P(9)");
}

// 9. 크기가 상수 아님 (사인파의 고정 tradeQuantity 결함 제거)
{
  const uniq = new Set(sizes).size;
  check(uniq > 10, "크기 다양성: 고정값 아님", `unique=${uniq}`);
}

console.log("=== " + (failures === 0 ? "ALL PASS" : failures + " FAIL") + " ===");
process.exit(failures === 0 ? 0 : 1);
