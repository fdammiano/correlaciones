import type { SeriesData } from "./types";
import { alignSeries } from "./stats";

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
 * Excel (.xlsx) — wide table: Date column + one column per series, dates
 * aligned to the union of all series. Dates as dates, returns as %.
 */
export async function downloadAllSeriesXLSX(series: SeriesData[]): Promise<void> {
  if (series.length === 0) return;
  const XLSX = await import("xlsx");
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
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Retornos");
  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `retornos_${stamp}.xlsx`);
}

// Legacy aliases kept so existing callers that import the CSV names
// keep working — they now produce XLSX too.
export const downloadSeriesCSV = downloadSeriesXLSX;
export const downloadAllSeriesCSV = downloadAllSeriesXLSX;
