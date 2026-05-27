import type { SeriesData } from "./types";
import { alignSeries, commonStartDate, correlationMatrix } from "./stats";
import { cumulativeWealth } from "./metrics";

function sanitizeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120);
}

function parseISODate(iso: string): Date {
  // dates from F-F / pasted data are normalized to YYYY-MM-DD month-end.
  // Use a UTC parse so spreadsheet apps don't shift by timezone.
  return new Date(iso + "T00:00:00Z");
}

/**
 * Excel (.xlsx) — one sheet with the date column and a single return column.
 * Numbers stay numeric so Excel can format them as % via the user's locale.
 * SheetJS is loaded dynamically so it doesn't bloat the initial JS bundle.
 */
export async function downloadSeriesXLSX(s: SeriesData): Promise<void> {
  const XLSX = await import("xlsx");
  const sorted = [...s.returns].sort((a, b) => a.date.localeCompare(b.date));
  const rows: (string | Date | number)[][] = [["Fecha", "Retorno"]];
  for (const r of sorted) rows.push([parseISODate(r.date), r.value]);
  const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
  ws["!cols"] = [{ wch: 12 }, { wch: 14 }];
  // format the date column as YYYY-MM-DD and the return column as 0.00%
  for (let i = 1; i < rows.length; i++) {
    const dateAddr = XLSX.utils.encode_cell({ r: i, c: 0 });
    const valAddr = XLSX.utils.encode_cell({ r: i, c: 1 });
    if (ws[dateAddr]) ws[dateAddr].z = "yyyy-mm-dd";
    if (ws[valAddr]) ws[valAddr].z = "0.00%";
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sanitizeFilename(s.name).slice(0, 31) || "Serie");
  XLSX.writeFile(wb, `${sanitizeFilename(s.name)}.xlsx`);
}

/**
 * Excel (.xlsx) — combined export with 3 sheets:
 *   1. Retornos    → wide table, one column per series, % format
 *   2. Correlación → full-sample NxN Pearson correlation matrix
 *   3. Base 100    → wealth values rebased to the common start month
 */
export async function downloadAllSeriesXLSX(series: SeriesData[]): Promise<void> {
  if (series.length === 0) return;
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();

  // ---------- Sheet 1: Retornos ----------
  {
    const aligned = alignSeries(series);
    const header: string[] = ["Fecha", ...series.map((s) => s.name)];
    const rows: (string | Date | number | null)[][] = [header];
    for (let i = 0; i < aligned.dates.length; i++) {
      const row: (string | Date | number | null)[] = [parseISODate(aligned.dates[i])];
      for (const s of series) row.push(aligned.byId[s.id][i]);
      rows.push(row);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
    ws["!cols"] = [{ wch: 12 }, ...series.map(() => ({ wch: 18 }))];
    for (let i = 1; i < rows.length; i++) {
      const dateAddr = XLSX.utils.encode_cell({ r: i, c: 0 });
      if (ws[dateAddr]) ws[dateAddr].z = "yyyy-mm-dd";
      for (let j = 0; j < series.length; j++) {
        const addr = XLSX.utils.encode_cell({ r: i, c: 1 + j });
        if (ws[addr]) ws[addr].z = "0.00%";
      }
    }
    XLSX.utils.book_append_sheet(wb, ws, "Retornos");
  }

  // ---------- Sheet 2: Correlación ----------
  {
    const m = correlationMatrix(series);
    const rows: (string | number | null)[][] = [];
    rows.push(["", ...m.names]);
    for (let i = 0; i < m.ids.length; i++) {
      rows.push([m.names[i], ...m.matrix[i]]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 26 }, ...m.names.map(() => ({ wch: 14 }))];
    // format correlation cells with 3 decimals
    for (let r = 1; r < rows.length; r++) {
      for (let c = 1; c < rows[r].length; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (ws[addr] && typeof ws[addr].v === "number") {
          ws[addr].z = "0.000";
        }
      }
    }
    XLSX.utils.book_append_sheet(wb, ws, "Correlación");
  }

  // ---------- Sheet 3: Base 100 ----------
  {
    const common = commonStartDate(series);
    const wealthBySeries = series.map((s) => {
      const trimmed = common ? s.returns.filter((r) => r.date >= common) : s.returns;
      return { id: s.id, name: s.name, w: cumulativeWealth(trimmed, 100) };
    });
    const dateSet = new Set<string>();
    for (const sw of wealthBySeries) for (const p of sw.w) dateSet.add(p.date);
    const dates = Array.from(dateSet).sort();
    const wealthHeader: string[] = ["Fecha", ...wealthBySeries.map((s) => s.name)];
    const wealthRows: (string | Date | number | null)[][] = [wealthHeader];
    // Per-series wealth lookup maps for fast access
    const lookups = wealthBySeries.map((s) => new Map(s.w.map((p) => [p.date, p.value])));
    for (const d of dates) {
      const row: (string | Date | number | null)[] = [parseISODate(d)];
      for (let i = 0; i < wealthBySeries.length; i++) {
        const v = lookups[i].get(d);
        row.push(v ?? null);
      }
      wealthRows.push(row);
    }
    const ws = XLSX.utils.aoa_to_sheet(wealthRows, { cellDates: true });
    ws["!cols"] = [{ wch: 12 }, ...wealthBySeries.map(() => ({ wch: 16 }))];
    for (let i = 1; i < wealthRows.length; i++) {
      const dateAddr = XLSX.utils.encode_cell({ r: i, c: 0 });
      if (ws[dateAddr]) ws[dateAddr].z = "yyyy-mm-dd";
      for (let j = 0; j < wealthBySeries.length; j++) {
        const addr = XLSX.utils.encode_cell({ r: i, c: 1 + j });
        if (ws[addr] && typeof ws[addr].v === "number") {
          ws[addr].z = "0.00";
        }
      }
    }
    XLSX.utils.book_append_sheet(wb, ws, "Base 100");
  }

  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `retornos_${stamp}.xlsx`);
}

// Legacy aliases kept so existing callers that import the CSV names
// keep working — they now produce XLSX too.
export const downloadSeriesCSV = downloadSeriesXLSX;
export const downloadAllSeriesCSV = downloadAllSeriesXLSX;
