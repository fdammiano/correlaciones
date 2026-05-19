// Simple OLS regression: y = α + β·x + ε with Student-t p-values.
// For multi-regressor OLS see lib/multiregression.ts.

import { studentTCDF, twoSidedTPValue } from "./distributions";

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

export { studentTCDF, twoSidedTPValue };

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
