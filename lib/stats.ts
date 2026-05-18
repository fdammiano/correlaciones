import type { ReturnPoint, SeriesData } from "./types";

export type AlignedReturns = {
  dates: string[];
  byId: Record<string, (number | null)[]>;
};

export function alignSeries(series: SeriesData[]): AlignedReturns {
  if (series.length === 0) return { dates: [], byId: {} };
  const dateSet = new Set<string>();
  series.forEach((s) => s.returns.forEach((r) => dateSet.add(r.date)));
  const dates = Array.from(dateSet).sort();
  const byId: Record<string, (number | null)[]> = {};
  for (const s of series) {
    const map = new Map(s.returns.map((r) => [r.date, r.value]));
    byId[s.id] = dates.map((d) => {
      const v = map.get(d);
      return v == null || !Number.isFinite(v) ? null : v;
    });
  }
  return { dates, byId };
}

export function rollingCorrelation(
  a: (number | null)[],
  b: (number | null)[],
  window: number,
): (number | null)[] {
  const n = a.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (window < 2 || n < window) return out;

  for (let i = window - 1; i < n; i++) {
    let sumA = 0,
      sumB = 0,
      sumAA = 0,
      sumBB = 0,
      sumAB = 0,
      count = 0;
    for (let k = i - window + 1; k <= i; k++) {
      const va = a[k];
      const vb = b[k];
      if (va == null || vb == null) continue;
      sumA += va;
      sumB += vb;
      sumAA += va * va;
      sumBB += vb * vb;
      sumAB += va * vb;
      count++;
    }
    if (count < Math.max(3, Math.floor(window * 0.6))) continue;
    const meanA = sumA / count;
    const meanB = sumB / count;
    const cov = sumAB / count - meanA * meanB;
    const varA = sumAA / count - meanA * meanA;
    const varB = sumBB / count - meanB * meanB;
    const denom = Math.sqrt(Math.max(varA, 0) * Math.max(varB, 0));
    if (denom > 0) out[i] = cov / denom;
  }
  return out;
}

export function correlation(
  a: (number | null)[],
  b: (number | null)[],
): number | null {
  let sumA = 0,
    sumB = 0,
    sumAA = 0,
    sumBB = 0,
    sumAB = 0,
    count = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i];
    const vb = b[i];
    if (va == null || vb == null) continue;
    sumA += va;
    sumB += vb;
    sumAA += va * va;
    sumBB += vb * vb;
    sumAB += va * vb;
    count++;
  }
  if (count < 3) return null;
  const meanA = sumA / count;
  const meanB = sumB / count;
  const cov = sumAB / count - meanA * meanB;
  const varA = sumAA / count - meanA * meanA;
  const varB = sumBB / count - meanB * meanB;
  const denom = Math.sqrt(Math.max(varA, 0) * Math.max(varB, 0));
  if (denom === 0) return null;
  return cov / denom;
}

export function correlationMatrix(
  series: SeriesData[],
  lastN?: number,
): { ids: string[]; names: string[]; matrix: (number | null)[][] } {
  const aligned = alignSeries(series);
  const start = lastN ? Math.max(0, aligned.dates.length - lastN) : 0;
  const ids = series.map((s) => s.id);
  const names = series.map((s) => s.name);
  const slices = ids.map((id) => aligned.byId[id].slice(start));
  const m: (number | null)[][] = ids.map(() => new Array(ids.length).fill(null));
  for (let i = 0; i < ids.length; i++) {
    for (let j = i; j < ids.length; j++) {
      const c = i === j ? 1 : correlation(slices[i], slices[j]);
      m[i][j] = c;
      m[j][i] = c;
    }
  }
  return { ids, names, matrix: m };
}
