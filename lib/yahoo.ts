import yahooFinance from "yahoo-finance2";
import type { ReturnPoint } from "./types";

function monthEndISO(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const last = new Date(Date.UTC(y, m + 1, 0));
  return last.toISOString().slice(0, 10);
}

// ------- Yahoo -------

async function fetchFromYahoo(ticker: string, startISO: string): Promise<ReturnPoint[]> {
  const period1 = new Date(startISO);
  const result = await yahooFinance.chart(ticker, { period1, interval: "1mo" });
  const quotes = (result.quotes ?? []).filter(
    (q): q is typeof q & { date: Date } => q.date != null,
  );
  quotes.sort((a, b) => a.date.getTime() - b.date.getTime());
  const out: ReturnPoint[] = [];
  for (let i = 1; i < quotes.length; i++) {
    const prev = (quotes[i - 1].adjclose ?? quotes[i - 1].close) as number | null;
    const cur = (quotes[i].adjclose ?? quotes[i].close) as number | null;
    if (prev && cur && prev > 0 && Number.isFinite(prev) && Number.isFinite(cur)) {
      out.push({ date: monthEndISO(quotes[i].date), value: cur / prev - 1 });
    }
  }
  if (out.length === 0) throw new Error("Yahoo: empty series");
  return out;
}

// ------- Stooq (fallback, no auth) -------

const STOOQ_INDEX_MAP: Record<string, string> = {
  "^GSPC": "^spx",
  "^DJI": "^dji",
  "^IXIC": "^ndq",
  "^RUT": "^rut",
  "^STOXX50E": "^stx50",
  "^FTSE": "^ftm",
  "^N225": "^nkx",
  "^GDAXI": "^dax",
  "^HSI": "^hsi",
  "^BVSP": "^bvp",
  "^MERV": "^mrv",
};

function mapToStooq(ticker: string): string {
  const t = ticker.trim();
  const u = t.toUpperCase();
  if (u.startsWith("^")) return STOOQ_INDEX_MAP[u] ?? u.toLowerCase();
  if (t.includes(".")) return t.toLowerCase();
  return `${t.toLowerCase()}.us`;
}

async function fetchFromStooq(ticker: string, startISO: string): Promise<ReturnPoint[]> {
  const sym = mapToStooq(ticker);
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=m`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (CorrelationsApp/1.0)" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Stooq HTTP ${res.status}`);
  const text = await res.text();
  if (!text || text.startsWith("No data") || text.length < 20) {
    throw new Error(`Stooq: sin datos para ${sym}`);
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  // Header: Date,Open,High,Low,Close,Volume
  const header = lines[0].split(",").map((s) => s.trim().toLowerCase());
  const dateIdx = header.indexOf("date");
  const closeIdx = header.indexOf("close");
  if (dateIdx < 0 || closeIdx < 0) throw new Error("Stooq: formato inesperado");

  type Row = { date: string; close: number };
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const date = cells[dateIdx];
    const close = parseFloat(cells[closeIdx]);
    if (!date || Number.isNaN(close)) continue;
    if (date < startISO) continue;
    rows.push({ date, close });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));

  const out: ReturnPoint[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].close;
    const cur = rows[i].close;
    if (prev > 0) {
      // normalize to month-end ISO
      const d = new Date(rows[i].date + "T00:00:00Z");
      out.push({ date: monthEndISO(d), value: cur / prev - 1 });
    }
  }
  if (out.length === 0) throw new Error("Stooq: serie vacía tras parsear");
  return out;
}

// ------- Public: tries Yahoo, falls back to Stooq -------

export async function fetchMonthlyReturns(
  ticker: string,
  startISO = "1990-01-01",
): Promise<{ returns: ReturnPoint[]; source: "yahoo" | "stooq" }> {
  try {
    const returns = await fetchFromYahoo(ticker, startISO);
    return { returns, source: "yahoo" };
  } catch (yahooErr) {
    try {
      const returns = await fetchFromStooq(ticker, startISO);
      return { returns, source: "stooq" };
    } catch (stooqErr) {
      const yMsg = yahooErr instanceof Error ? yahooErr.message : String(yahooErr);
      const sMsg = stooqErr instanceof Error ? stooqErr.message : String(stooqErr);
      throw new Error(`No pude bajar ${ticker}. Yahoo: ${yMsg}. Stooq: ${sMsg}`);
    }
  }
}
