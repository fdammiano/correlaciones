// Multivariate OLS regression: y = α + β₁·x₁ + β₂·x₂ + ... + βₖ·xₖ + ε.
//
// Solves β = (X'X)⁻¹ X'y where X is N × (k+1) with an intercept column,
// computes per-coefficient SEs, t-stats and p-values, plus R², adjusted R²,
// F-stat for overall significance, residuals and fitted values.
//
// Inversion: Gauss–Jordan elimination with partial pivoting. Adequate for
// the column counts we expect here (≤ ~30 regressors); switch to QR if
// numerical conditioning becomes an issue.

import { fCDFComplement, twoSidedTPValue } from "./distributions";

export type MultiCoef = {
  name: string;
  value: number;
  se: number;
  t: number;
  p: number;
};

export type MultiRegression = {
  n: number;
  k: number;
  coefficients: MultiCoef[];
  r2: number;
  adjustedR2: number;
  fStat: number;
  fPValue: number;
  rmse: number;
  meanY: number;
  fitted: number[];
  residuals: number[];
  yObserved: number[];
};

function transpose(A: number[][]): number[][] {
  const m = A.length;
  const n = A[0].length;
  const out: number[][] = [];
  for (let j = 0; j < n; j++) {
    const row = new Array(m);
    for (let i = 0; i < m; i++) row[i] = A[i][j];
    out.push(row);
  }
  return out;
}

function matMul(A: number[][], B: number[][]): number[][] {
  const m = A.length;
  const p = A[0].length;
  const n = B[0].length;
  const out: number[][] = [];
  for (let i = 0; i < m; i++) {
    const row = new Array(n).fill(0);
    for (let kk = 0; kk < p; kk++) {
      const aik = A[i][kk];
      if (aik === 0) continue;
      const Bk = B[kk];
      for (let j = 0; j < n; j++) row[j] += aik * Bk[j];
    }
    out.push(row);
  }
  return out;
}

function matVec(A: number[][], v: number[]): number[] {
  const m = A.length;
  const n = v.length;
  const out = new Array(m).fill(0);
  for (let i = 0; i < m; i++) {
    let s = 0;
    const Ai = A[i];
    for (let j = 0; j < n; j++) s += Ai[j] * v[j];
    out[i] = s;
  }
  return out;
}

function invert(A: number[][]): number[][] | null {
  const n = A.length;
  const M: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(2 * n).fill(0);
    for (let j = 0; j < n; j++) row[j] = A[i][j];
    row[n + i] = 1;
    M.push(row);
  }
  for (let i = 0; i < n; i++) {
    // partial pivot
    let maxRow = i;
    let maxVal = Math.abs(M[i][i]);
    for (let r = i + 1; r < n; r++) {
      const v = Math.abs(M[r][i]);
      if (v > maxVal) {
        maxVal = v;
        maxRow = r;
      }
    }
    if (maxVal < 1e-12) return null;
    if (maxRow !== i) {
      const tmp = M[i];
      M[i] = M[maxRow];
      M[maxRow] = tmp;
    }
    const piv = M[i][i];
    for (let c = 0; c < 2 * n; c++) M[i][c] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const factor = M[r][i];
      if (factor === 0) continue;
      for (let c = 0; c < 2 * n; c++) M[r][c] -= factor * M[i][c];
    }
  }
  const inv: number[][] = [];
  for (let i = 0; i < n; i++) inv.push(M[i].slice(n));
  return inv;
}

/**
 * Regress y on the columns provided in `Xcols` (one regressor per column,
 * each represented as an array aligned with y). Rows where any value is
 * null / non-finite are dropped pairwise. Returns null if fewer than k+2
 * complete observations remain, or if X'X is singular.
 */
export function multiRegress(
  y: (number | null)[],
  Xcols: { name: string; values: (number | null)[] }[],
): MultiRegression | null {
  const k = Xcols.length;
  if (k === 0) return null;

  const X: number[][] = [];
  const yv: number[] = [];
  const N0 = Math.min(y.length, ...Xcols.map((c) => c.values.length));
  for (let i = 0; i < N0; i++) {
    const yi = y[i];
    if (yi == null || !Number.isFinite(yi)) continue;
    let bad = false;
    const row = [1];
    for (let j = 0; j < k; j++) {
      const v = Xcols[j].values[i];
      if (v == null || !Number.isFinite(v)) {
        bad = true;
        break;
      }
      row.push(v as number);
    }
    if (bad) continue;
    X.push(row);
    yv.push(yi as number);
  }

  const N = X.length;
  const dof = N - k - 1;
  if (dof < 1) return null;

  const Xt = transpose(X);
  const XtX = matMul(Xt, X);
  const XtXinv = invert(XtX);
  if (!XtXinv) return null;
  const Xty = matVec(Xt, yv);
  const beta = matVec(XtXinv, Xty);

  const fitted: number[] = new Array(N);
  const residuals: number[] = new Array(N);
  let meanY = 0;
  for (let i = 0; i < N; i++) meanY += yv[i];
  meanY /= N;
  let sse = 0;
  let sst = 0;
  for (let i = 0; i < N; i++) {
    let yhat = 0;
    const Xi = X[i];
    for (let j = 0; j <= k; j++) yhat += Xi[j] * beta[j];
    fitted[i] = yhat;
    const r = yv[i] - yhat;
    residuals[i] = r;
    sse += r * r;
    sst += (yv[i] - meanY) ** 2;
  }
  const sigma2 = sse / dof;
  const rmse = Math.sqrt(sigma2);
  const r2 = sst > 0 ? 1 - sse / sst : 0;
  const adjR2 = 1 - ((1 - r2) * (N - 1)) / dof;

  const names = ["α (intercept)", ...Xcols.map((c) => c.name)];
  const coefficients: MultiCoef[] = beta.map((b, i) => {
    const se = Math.sqrt(Math.max(0, sigma2 * XtXinv[i][i]));
    const t = se > 0 ? b / se : NaN;
    const p = se > 0 ? twoSidedTPValue(t, dof) : NaN;
    return { name: names[i], value: b, se, t, p };
  });

  const fStat = k > 0 && r2 < 1 ? (r2 / k) / ((1 - r2) / dof) : NaN;
  const fPValue = Number.isFinite(fStat) ? fCDFComplement(fStat, k, dof) : NaN;

  return {
    n: N,
    k,
    coefficients,
    r2,
    adjustedR2: adjR2,
    fStat,
    fPValue,
    rmse,
    meanY,
    fitted,
    residuals,
    yObserved: yv,
  };
}
