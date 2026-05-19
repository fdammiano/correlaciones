// Shared statistical distribution helpers — log Gamma, regularized incomplete
// beta, Student-t CDF, F-distribution complementary CDF. Used by both the
// univariate regression and the multivariate OLS modules.

export function logGamma(x: number): number {
  const cof = [
    76.18009172947146,
    -86.50532032941677,
    24.01409824083091,
    -1.231739572450155,
    0.1208650973866179e-2,
    -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += cof[j] / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-30;
  const EPS = 3e-7;
  const MAXIT = 200;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b). */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(a, b, x)) / a;
  }
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** P(T ≤ t) where T ~ Student-t with `df` degrees of freedom. */
export function studentTCDF(t: number, df: number): number {
  if (df <= 0 || !Number.isFinite(t)) return NaN;
  const x = df / (df + t * t);
  const half = 0.5 * incompleteBeta(df / 2, 0.5, x);
  return t >= 0 ? 1 - half : half;
}

/** Two-sided p-value for a t statistic with `df` degrees of freedom. */
export function twoSidedTPValue(t: number, df: number): number {
  if (df <= 0 || !Number.isFinite(t)) return NaN;
  return 2 * (1 - studentTCDF(Math.abs(t), df));
}

/**
 * P(F > f) where F ~ F-distribution with (d1, d2) degrees of freedom.
 * Useful directly as the p-value of the overall regression F-test.
 */
export function fCDFComplement(f: number, d1: number, d2: number): number {
  if (!Number.isFinite(f) || f <= 0 || d1 <= 0 || d2 <= 0) return NaN;
  const x = d2 / (d2 + d1 * f);
  return incompleteBeta(d2 / 2, d1 / 2, x);
}
