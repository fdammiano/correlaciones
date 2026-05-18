import type { ReturnPoint, SeriesData } from "./types";

export type SeriesMetrics = {
  n: number;
  start: string | null;
  end: string | null;
  annualReturn: number | null;
  annualVol: number | null;
  sharpe: number | null;
  maxDrawdown: number | null;
  positivePct: number | null;
  minMonthly: number | null;
  maxMonthly: number | null;
  totalReturn: number | null;
};

export function summarize(returns: ReturnPoint[]): SeriesMetrics {
  const sorted = [...returns]
    .filter((r) => Number.isFinite(r.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  const n = sorted.length;
  if (n < 2) {
    return {
      n,
      start: sorted[0]?.date ?? null,
      end: sorted[n - 1]?.date ?? null,
      annualReturn: null,
      annualVol: null,
      sharpe: null,
      maxDrawdown: null,
      positivePct: null,
      minMonthly: null,
      maxMonthly: null,
      totalReturn: null,
    };
  }
  const vals = sorted.map((r) => r.value);

  const cumProd = vals.reduce((acc, v) => acc * (1 + v), 1);
  const totalReturn = cumProd - 1;
  const annualReturn = Math.pow(cumProd, 12 / n) - 1;

  const mean = vals.reduce((s, v) => s + v, 0) / n;
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const annualVol = sd * Math.sqrt(12);
  const sharpe = annualVol > 0 ? annualReturn / annualVol : null;

  let wealth = 1;
  let peak = 1;
  let maxDD = 0;
  for (const v of vals) {
    wealth *= 1 + v;
    if (wealth > peak) peak = wealth;
    const dd = wealth / peak - 1;
    if (dd < maxDD) maxDD = dd;
  }

  const positivePct = vals.filter((v) => v > 0).length / n;
  const minMonthly = Math.min(...vals);
  const maxMonthly = Math.max(...vals);

  return {
    n,
    start: sorted[0].date,
    end: sorted[n - 1].date,
    annualReturn,
    annualVol,
    sharpe,
    maxDrawdown: maxDD,
    positivePct,
    minMonthly,
    maxMonthly,
    totalReturn,
  };
}

export type WealthPoint = { date: string; value: number };

export function cumulativeWealth(returns: ReturnPoint[], base = 100): WealthPoint[] {
  const sorted = [...returns]
    .filter((r) => Number.isFinite(r.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  const out: WealthPoint[] = [];
  if (sorted.length === 0) return out;
  // Prepend a synthetic anchor at base, one month BEFORE the first return.
  // That way the first return is fully reflected in the chart (it was being dropped).
  const firstDate = new Date(sorted[0].date + "T00:00:00Z");
  const prior = new Date(Date.UTC(firstDate.getUTCFullYear(), firstDate.getUTCMonth(), 0));
  out.push({ date: prior.toISOString().slice(0, 10), value: base });
  let wealth = base;
  for (const r of sorted) {
    wealth *= 1 + r.value;
    out.push({ date: r.date, value: wealth });
  }
  return out;
}

export function summarizeAll(series: SeriesData[]): { id: string; name: string; metrics: SeriesMetrics }[] {
  return series.map((s) => ({ id: s.id, name: s.name, metrics: summarize(s.returns) }));
}
