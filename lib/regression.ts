// Linear regression y = α + β·x + ε with Student-t p-values for α and β.

export type Regression = {
  n: number;
  alpha: number;
  beta: number;
  seAlpha: number;
  seBeta: number;
  tAlpha: number;
  tBeta: number;
  pAlpha: number;
  pBeta: number;
  r2: number;
  rmse: number;
  meanX: number;
  meanY: number;
};

function logGamma(x: number): number {
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

function incompleteBeta(a: number, b: number, x: number): number {
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

/** Two-sided p-value for a t statistic. */
export function twoSidedTPValue(t: number, df: number): number {
  if (df <= 0 || !Number.isFinite(t)) return NaN;
  return 2 * (1 - studentTCDF(Math.abs(t), df));
}

/** Regress y on x using OLS. Pairs with non-finite values are dropped. */
export function regress(y: number[], x: number[]): Regression | null {
  const n = Math.min(x.length, y.length);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(x[i]) && Number.isFinite(y[i])) {
      xs.push(x[i]);
      ys.push(y[i]);
    }
  }
  const N = xs.length;
  if (N < 3) return null;

  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < N; i++) {
    meanX += xs[i];
    meanY += ys[i];
  }
  meanX /= N;
  meanY /= N;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < N; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return null;
  const beta = sxy / sxx;
  const alpha = meanY - beta * meanX;

  let sse = 0;
  for (let i = 0; i < N; i++) {
    const pred = alpha + beta * xs[i];
    const e = ys[i] - pred;
    sse += e * e;
  }
  const dof = N - 2;
  const sigma2 = sse / dof;
  const seBeta = Math.sqrt(sigma2 / sxx);
  const seAlpha = Math.sqrt(sigma2 * (1 / N + (meanX * meanX) / sxx));
  const tBeta = beta / seBeta;
  const tAlpha = alpha / seAlpha;
  const pBeta = twoSidedTPValue(tBeta, dof);
  const pAlpha = twoSidedTPValue(tAlpha, dof);
  const r2 = syy > 0 ? 1 - sse / syy : 0;
  const rmse = Math.sqrt(sigma2);

  return {
    n: N,
    alpha,
    beta,
    seAlpha,
    seBeta,
    tAlpha,
    tBeta,
    pAlpha,
    pBeta,
    r2,
    rmse,
    meanX,
    meanY,
  };
}
