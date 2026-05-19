import yahooFinance from "yahoo-finance2";
import type { ReturnPoint } from "./types";

function monthEndISO(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const last = new Date(Date.UTC(y, m + 1, 0));
  return last.toISOString().slice(0, 10);
}

type Quote = {
  date: Date | string | null | undefined;
  adjclose?: number | null;
  close?: number | null;
};

// Total returns from monthly adjusted-close (adjclose accounts for
// dividends and splits, so r_t = adjclose_t / adjclose_{t-1} - 1 is the
// per-period total return).
export async function fetchMonthlyTotalReturns(
  ticker: string,
  startISO = "1990-01-01",
): Promise<ReturnPoint[]> {
  const period1 = new Date(startISO);
  // Cast to any: the chart() overload typing in yahoo-finance2 v2.13
  // doesn't surface .quotes cleanly for our usage; the underlying shape is
  // { quotes: Quote[], meta, events }. Behavior is stable.
  const result = (await yahooFinance.chart(ticker, {
    period1,
    interval: "1mo",
  } as any)) as { quotes?: Quote[] };

  const raw = (result?.quotes ?? []) as Quote[];
  const quotes: { date: Date; adjclose?: number | null; close?: number | null }[] = [];
  for (const q of raw) {
    if (q.date == null) continue;
    const d = q.date instanceof Date ? q.date : new Date(q.date);
    if (Number.isNaN(d.getTime())) continue;
    quotes.push({ date: d, adjclose: q.adjclose, close: q.close });
  }
  quotes.sort((a, b) => a.date.getTime() - b.date.getTime());

  const out: ReturnPoint[] = [];
  for (let i = 1; i < quotes.length; i++) {
    const prev = (quotes[i - 1].adjclose ?? quotes[i - 1].close) as number | null;
    const cur = (quotes[i].adjclose ?? quotes[i].close) as number | null;
    if (
      prev != null &&
      cur != null &&
      Number.isFinite(prev) &&
      Number.isFinite(cur) &&
      prev > 0
    ) {
      out.push({ date: monthEndISO(quotes[i].date), value: cur / prev - 1 });
    }
  }
  if (out.length === 0) {
    throw new Error(`Yahoo no devolvió datos para ${ticker}`);
  }
  return out;
}
