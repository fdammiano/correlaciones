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

  // Use adjclose strictly — falling back to close would silently drop
  // dividends and give price return instead of total return.
  const withAdj = quotes.filter(
    (q) => q.adjclose != null && Number.isFinite(q.adjclose as number),
  );
  if (withAdj.length === 0) {
    throw new Error(
      `${ticker}: Yahoo no devolvió adjusted close. Para total return usá un ETF (SPY, DIA, QQQ, IWN, EEM…) en vez del índice price.`,
    );
  }
  const out: ReturnPoint[] = [];
  for (let i = 1; i < withAdj.length; i++) {
    const prev = withAdj[i - 1].adjclose as number;
    const cur = withAdj[i].adjclose as number;
    if (prev > 0) {
      out.push({ date: monthEndISO(withAdj[i].date), value: cur / prev - 1 });
    }
  }
  if (out.length === 0) {
    throw new Error(`Yahoo no devolvió suficientes datos para ${ticker}`);
  }
  return out;
}
