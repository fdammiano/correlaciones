import type { SeriesData } from "./types";
import { alignSeries } from "./stats";

function csvEscape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCSV(rows: (string | number | null)[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          if (cell == null) return "";
          if (typeof cell === "number") {
            return Number.isFinite(cell) ? cell.toString() : "";
          }
          return csvEscape(cell);
        })
        .join(","),
    )
    .join("\r\n");
}

function sanitizeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120);
}

function triggerDownload(filename: string, content: string) {
  const blob = new Blob(["﻿" + content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

export function downloadSeriesCSV(s: SeriesData) {
  const rows: (string | number | null)[][] = [["Fecha", "Retorno"]];
  const sorted = [...s.returns].sort((a, b) => a.date.localeCompare(b.date));
  for (const r of sorted) rows.push([r.date, r.value]);
  triggerDownload(`${sanitizeFilename(s.name)}.csv`, toCSV(rows));
}

export function downloadAllSeriesCSV(series: SeriesData[]) {
  if (series.length === 0) return;
  const aligned = alignSeries(series);
  const header: string[] = ["Fecha", ...series.map((s) => s.name)];
  const rows: (string | number | null)[][] = [header];
  for (let i = 0; i < aligned.dates.length; i++) {
    const row: (string | number | null)[] = [aligned.dates[i]];
    for (const s of series) row.push(aligned.byId[s.id][i]);
    rows.push(row);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  triggerDownload(`retornos_${stamp}.csv`, toCSV(rows));
}
