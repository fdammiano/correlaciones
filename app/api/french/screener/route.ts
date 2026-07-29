import { NextResponse } from "next/server";
import { fetchFrenchDataset } from "@/lib/french";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Datasets que entran al screener. allCols = usar todas las columnas (sectores /
// 6-portfolios); si no, se eligen los terciles Lo30/Med40/Hi30 (o los extremos).
const SCREEN: { id: string; family: string; region: string; allCols?: boolean }[] = [
  { id: "Portfolios_Formed_on_ME", family: "Size", region: "US" },
  { id: "Portfolios_Formed_on_BE-ME", family: "Value (B/M)", region: "US" },
  { id: "Portfolios_Formed_on_OP", family: "Profitability", region: "US" },
  { id: "Portfolios_Formed_on_INV", family: "Investment", region: "US" },
  { id: "Portfolios_Formed_on_E-P", family: "Earnings/Price", region: "US" },
  { id: "Portfolios_Formed_on_CF-P", family: "Cashflow/Price", region: "US" },
  { id: "Portfolios_Formed_on_D-P", family: "Dividend Yield", region: "US" },
  { id: "10_Portfolios_Prior_12_2", family: "Momentum", region: "US" },
  { id: "12_Industry_Portfolios", family: "Sectores", region: "US", allCols: true },
  { id: "Developed_ex_US_6_Portfolios_ME_BE-ME", family: "Value (B/M)", region: "Dev ex-US", allCols: true },
  { id: "Developed_ex_US_6_Portfolios_ME_Prior_12_2", family: "Momentum", region: "Dev ex-US", allCols: true },
];

function pickCols(columns: string[], allCols?: boolean): string[] {
  const clean = columns.map((c) => c.trim());
  if (allCols) return clean.filter((c) => c && !/^<?=|^>/.test(c));
  const terc = clean.filter((c) => /^(lo 30|med 40|hi 30)$/i.test(c));
  if (terc.length) return terc;
  // fallback: extremos (primer y última columna “de portafolio”)
  const nonMeta = clean.filter((c) => c && !/^<?=|^>/.test(c));
  if (nonMeta.length >= 2) return [nonMeta[0], nonMeta[nonMeta.length - 1]];
  return nonMeta.slice(0, 3);
}

export async function GET() {
  try {
    // Benchmark: retorno del mercado US = Mkt-RF + RF (ambos ya en decimal)
    const factors = await fetchFrenchDataset("F-F_Research_Data_Factors");
    const iMkt = factors.columns.findIndex((c) => /mkt-?rf/i.test(c));
    const iRf = factors.columns.findIndex((c) => /^rf$/i.test(c.trim()));
    const mkt = new Map<string, number>();
    for (const r of factors.rows) {
      const m = r.values[iMkt];
      const rf = r.values[iRf];
      if (m == null || rf == null) continue;
      mkt.set(r.date, m + rf);
    }

    const results = await Promise.all(
      SCREEN.map(async (d) => {
        try {
          const tbl = await fetchFrenchDataset(d.id);
          const cols = pickCols(tbl.columns, d.allCols);
          const items = cols.map((col) => {
            const idx = tbl.columns.findIndex((c) => c.trim() === col);
            if (idx < 0) return null;
            // ratio de riqueza acumulado vs mercado sobre meses en común
            const vals: number[] = [];
            for (const row of tbl.rows) {
              const rp = row.values[idx];
              const rm = mkt.get(row.date);
              if (rp == null || rm == null) continue;
              vals.push((1 + rp) / (1 + rm));
            }
            if (vals.length < 24) return null;
            const ratio: number[] = [];
            let acc = 1;
            for (const v of vals) {
              acc *= v;
              ratio.push(acc);
            }
            const now = ratio[ratio.length - 1];
            const mean = ratio.reduce((s, x) => s + x, 0) / ratio.length;
            const pct = mean > 0 ? (now / mean - 1) * 100 : 0;
            return { portfolio: col, pct: Math.round(pct * 10) / 10, months: vals.length };
          });
          return {
            family: d.family,
            region: d.region,
            items: items.filter(Boolean) as { portfolio: string; pct: number; months: number }[],
          };
        } catch {
          return { family: d.family, region: d.region, items: [] };
        }
      }),
    );

    return NextResponse.json({
      ok: true,
      benchmark: "Mercado US (Fama-French)",
      metric: "% del ratio de riqueza actual vs su promedio histórico",
      groups: results.filter((g) => g.items.length > 0),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "error" },
      { status: 500 },
    );
  }
}
