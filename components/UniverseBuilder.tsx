"use client";

import { useEffect, useMemo, useState } from "react";
import type { FrenchDatasetMeta, SeriesData, Region, Family, ReturnPoint } from "@/lib/types";
import { downloadAllSeriesCSV, downloadSeriesCSV } from "@/lib/download";

function monthEndISO(y: number, m: number): string | null {
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12 || y < 1900 || y > 2100) {
    return null;
  }
  const last = new Date(Date.UTC(y, m, 0));
  return last.toISOString().slice(0, 10);
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, ene: 1, enero: 1,
  feb: 2, february: 2, febrero: 2,
  mar: 3, march: 3, marzo: 3,
  apr: 4, april: 4, abr: 4, abril: 4,
  may: 5, mayo: 5,
  jun: 6, june: 6, junio: 6,
  jul: 7, july: 7, julio: 7,
  aug: 8, august: 8, ago: 8, agosto: 8,
  sep: 9, sept: 9, september: 9, set: 9, setiembre: 9, septiembre: 9,
  oct: 10, october: 10, octubre: 10,
  nov: 11, november: 11, noviembre: 11,
  dec: 12, december: 12, dic: 12, diciembre: 12,
};

type DecimalFormat = "comma" | "dot";

function parseNumber(raw: string, fmt: DecimalFormat): number {
  let s = raw.trim().replace(/%/g, "").replace(/\s/g, "");
  if (!s) return NaN;
  const sign = s.startsWith("-") ? -1 : 1;
  if (s.startsWith("+") || s.startsWith("-")) s = s.slice(1);

  const hasDot = s.includes(".");
  const hasComma = s.includes(",");

  if (fmt === "comma") {
    if (hasComma) {
      // proper rioplatense format: dots are thousands, comma is decimal
      s = s.replace(/\./g, "").replace(",", ".");
    } else if (hasDot) {
      // Ambiguous: only dots in "comma" mode. If pattern looks like grouped
      // thousands (e.g. "1.234" or "12.345.678"), strip dots. Otherwise
      // treat as US-style decimal even though user picked comma mode.
      const looksThousand = /^\d{1,3}(\.\d{3})+$/.test(s);
      if (looksThousand) s = s.replace(/\./g, "");
      // else leave as is — parseFloat will use the dot as decimal
    }
  } else {
    if (hasDot) {
      // proper US format: commas are thousands, dot is decimal
      s = s.replace(/,/g, "");
    } else if (hasComma) {
      // Ambiguous: only commas in "dot" mode. Similar grouping check.
      const looksThousand = /^\d{1,3}(,\d{3})+$/.test(s);
      if (looksThousand) s = s.replace(/,/g, "");
      else s = s.replace(",", ".");
    }
  }
  return sign * parseFloat(s);
}

// Convert cryptic Ken French column names into a human-readable position.
// Returns an array of "position labels" (1 for single-sort, 2 for bivariate
// 6_Portfolios datasets) so the sidebar can stack them visually.
function prettifyKenFrenchCol(col: string): string[] {
  const c = col.trim();
  // 6 Portfolios bivariate: Size × {BM, OP, Momentum} — pattern is one of
  //   SMALL Lo*, ME1 *2, SMALL Hi*, BIG Lo*, ME2 *2, BIG Hi*
  if (/^SMALL\s+Lo/i.test(c)) return ["Small", "Low"];
  if (/^SMALL\s+Hi/i.test(c)) return ["Small", "High"];
  if (/^BIG\s+Lo/i.test(c)) return ["Big", "Low"];
  if (/^BIG\s+Hi/i.test(c)) return ["Big", "High"];
  if (/^ME1\b/i.test(c)) return ["Small", "Mid"];
  if (/^ME2\b/i.test(c)) return ["Big", "Mid"];
  // single-sort common patterns
  if (/^Lo\s*\d+$/i.test(c)) return [`Bottom (${c})`];
  if (/^Hi\s*\d+$/i.test(c)) return [`Top (${c})`];
  return [c];
}

function parseDate(raw: string): string | null {
  // strip any trailing time portion (Excel sometimes pastes "01/02/2020 0:00:00")
  const r = raw.trim().split(/\s+/)[0];
  if (!r) return null;
  // ISO: YYYY-MM-DD or YYYY/MM/DD
  let m = r.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (m) return monthEndISO(parseInt(m[1]), parseInt(m[2]));
  // YYYY-MM
  m = r.match(/^(\d{4})[-\/](\d{1,2})$/);
  if (m) return monthEndISO(parseInt(m[1]), parseInt(m[2]));
  // YYYYMM
  m = r.match(/^(\d{4})(\d{2})$/);
  if (m) return monthEndISO(parseInt(m[1]), parseInt(m[2]));
  // dd/mm/yyyy or dd-mm-yyyy (rioplatense por default)
  m = r.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (m) {
    let y = parseInt(m[3]);
    if (y < 100) y += y < 50 ? 2000 : 1900;
    return monthEndISO(y, parseInt(m[2]));
  }
  // dd-MMM-yyyy or MMM-yyyy or dd MMM yy  (mes en letra)
  m = r.match(/^(\d{1,2})[-\/ ]([A-Za-zÁÉÍÓÚáéíóúñ]{3,12})[-\/ ](\d{2,4})$/);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon) {
      let y = parseInt(m[3]);
      if (y < 100) y += y < 50 ? 2000 : 1900;
      return monthEndISO(y, mon);
    }
  }
  // MMM-yy o MMM-yyyy
  m = r.match(/^([A-Za-zÁÉÍÓÚáéíóúñ]{3,12})[-\/ ](\d{2,4})$/);
  if (m) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (mon) {
      let y = parseInt(m[2]);
      if (y < 100) y += y < 50 ? 2000 : 1900;
      return monthEndISO(y, mon);
    }
  }
  return null;
}

type ParsedPaste = {
  rows: { date: string; value: number }[];
  returns: ReturnPoint[];
};

function parsePastedCSV(
  text: string,
  kind: "returns_dec" | "returns_pct" | "prices",
  fmt: DecimalFormat,
): { ok: true; data: ParsedPaste } | { ok: false; error: string } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  type Row = { date: string; value: number };
  const rows: Row[] = [];
  for (const line of lines) {
    // split by tab (Excel paste), comma or semicolon — but only if format is "dot",
    // because in "comma" mode the comma is a decimal separator inside numbers.
    const sep = fmt === "comma" ? /[\t;]/ : /[\t,;]/;
    const parts = line.split(sep).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const iso = parseDate(parts[0]);
    if (!iso) continue;
    const n = parseNumber(parts[parts.length - 1], fmt);
    if (!Number.isFinite(n)) continue;
    rows.push({ date: iso, value: n });
  }
  if (rows.length === 0) {
    return { ok: false, error: "No se reconoció ninguna fila válida (revisá formato de fechas y números)." };
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));

  let returns: ReturnPoint[];
  if (kind === "prices") {
    returns = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1].value;
      const cur = rows[i].value;
      if (prev > 0) returns.push({ date: rows[i].date, value: cur / prev - 1 });
    }
  } else if (kind === "returns_pct") {
    returns = rows.map((r) => ({ date: r.date, value: r.value / 100 }));
  } else {
    returns = rows.map((r) => ({ date: r.date, value: r.value }));
  }
  return { ok: true, data: { rows, returns } };
}

const REGIONS: Region[] = [
  "US",
  "Developed",
  "Developed ex US",
  "Europe",
  "Asia Pacific ex Japan",
  "North America",
  "Emerging Markets",
];

const FAMILIES: Family[] = [
  "Size",
  "Profitability",
  "Momentum",
  "Size / Book-to-Market",
  "Size / Profitability",
  "Size / Momentum",
  "Industry / Sector",
];

type Props = {
  series: SeriesData[];
  onAdd: (s: SeriesData[]) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onToggleActive: (id: string) => void;
  onSetAllActive: (active: boolean) => void;
  storageBadge?: string;
};

export default function UniverseBuilder({
  series,
  onAdd,
  onRemove,
  onClear,
  onToggleActive,
  onSetAllActive,
  storageBadge,
}: Props) {
  const [tab, setTab] = useState<"french" | "paste">("french");
  const [pasteName, setPasteName] = useState("SPY");
  const [pasteKind, setPasteKind] = useState<"returns_dec" | "returns_pct" | "prices">("prices");
  const [pasteText, setPasteText] = useState("");
  const [pasteFmt, setPasteFmt] = useState<DecimalFormat>("comma");
  const [datasets, setDatasets] = useState<FrenchDatasetMeta[]>([]);
  const [region, setRegion] = useState<Region>("US");
  const [family, setFamily] = useState<Family>("Size / Book-to-Market");
  const [datasetId, setDatasetId] = useState<string>("");
  const [columns, setColumns] = useState<string[]>([]);
  const [selectedCols, setSelectedCols] = useState<string[]>([]);
  const [loadingDs, setLoadingDs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/french/list")
      .then((r) => r.json())
      .then((d) => setDatasets(d.datasets ?? []))
      .catch(() => setError("No pude cargar la lista de Ken French."));
  }, []);

  const filtered = useMemo(
    () => datasets.filter((d) => d.region === region && d.family === family),
    [datasets, region, family],
  );

  const pastePreview = useMemo(() => {
    if (!pasteText.trim()) return null;
    return parsePastedCSV(pasteText, pasteKind, pasteFmt);
  }, [pasteText, pasteKind, pasteFmt]);

  useEffect(() => {
    setDatasetId(filtered[0]?.id ?? "");
    setColumns([]);
    setSelectedCols([]);
  }, [region, family, filtered.length]);

  async function loadDataset(id: string) {
    if (!id) return;
    setLoadingDs(true);
    setError(null);
    try {
      const res = await fetch(`/api/french/dataset?name=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      const data = await res.json();
      setColumns(data.columns ?? []);
      setSelectedCols(data.columns ?? []);
    } catch (e: any) {
      setError(e.message ?? "Error bajando dataset");
      setColumns([]);
      setSelectedCols([]);
    } finally {
      setLoadingDs(false);
    }
  }

  useEffect(() => {
    if (datasetId) loadDataset(datasetId);
  }, [datasetId]);

  async function addFrench() {
    if (!datasetId || selectedCols.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/french/dataset?name=${encodeURIComponent(datasetId)}`);
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      const data = await res.json();
      const cols: string[] = data.columns;
      const rows: { date: string; values: (number | null)[] }[] = data.rows;
      const meta = datasets.find((d) => d.id === datasetId);
      const dsLabel = meta?.label ?? datasetId;
      const newSeries: SeriesData[] = selectedCols.map((col) => {
        const idx = cols.indexOf(col);
        const returns = rows
          .map((r) => ({ date: r.date, value: r.values[idx] }))
          .filter((p): p is { date: string; value: number } => p.value != null);
        return {
          id: `${datasetId}::${col}`,
          name: `${dsLabel} · ${col}`,
          source: "french",
          returns,
        };
      });
      onAdd(newSeries);
    } catch (e: any) {
      setError(e.message ?? "Error agregando dataset");
    } finally {
      setBusy(false);
    }
  }

  function toggleCol(c: string) {
    setSelectedCols((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
    );
  }

  return (
    <aside className="w-80 shrink-0 border-r border-zinc-200 bg-zinc-50 p-4 overflow-y-auto h-screen sticky top-0">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold">Universo</h2>
        {storageBadge && (
          <span
            className={`text-[10px] px-2 py-0.5 rounded ${
              storageBadge === "compartido"
                ? "bg-emerald-100 text-emerald-800"
                : storageBadge === "solo local"
                ? "bg-amber-100 text-amber-800"
                : "bg-zinc-100 text-zinc-500"
            }`}
            title={
              storageBadge === "compartido"
                ? "Las series se sincronizan con el server — todos los visitantes ven lo mismo."
                : storageBadge === "solo local"
                ? "Las series solo se guardan en este browser. Activá Upstash Redis en Vercel para compartir."
                : ""
            }
          >
            {storageBadge}
          </span>
        )}
      </div>

      <div className="flex border-b border-zinc-200 mb-3 text-sm">
        <button
          className={`px-3 py-1.5 ${tab === "french" ? "border-b-2 border-zinc-900 font-semibold" : "text-zinc-500"}`}
          onClick={() => setTab("french")}
        >
          Ken French
        </button>
        <button
          className={`px-3 py-1.5 ${tab === "paste" ? "border-b-2 border-zinc-900 font-semibold" : "text-zinc-500"}`}
          onClick={() => setTab("paste")}
        >
          Excel
        </button>
      </div>

      {tab === "french" && (
        <div className="space-y-3 text-sm">
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Región</label>
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value as Region)}
              className="w-full border border-zinc-300 rounded px-2 py-1 bg-white"
            >
              {REGIONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Familia</label>
            <select
              value={family}
              onChange={(e) => setFamily(e.target.value as Family)}
              className="w-full border border-zinc-300 rounded px-2 py-1 bg-white"
            >
              {FAMILIES.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Dataset</label>
            <select
              value={datasetId}
              onChange={(e) => setDatasetId(e.target.value)}
              disabled={filtered.length === 0}
              className="w-full border border-zinc-300 rounded px-2 py-1 bg-white"
            >
              {filtered.length === 0 && <option value="">(sin datasets)</option>}
              {filtered.map((d) => (
                <option key={d.id} value={d.id}>{d.label}</option>
              ))}
            </select>
          </div>
          {loadingDs && <div className="text-xs text-zinc-500">Bajando dataset…</div>}
          {!loadingDs && columns.length > 0 && (
            <div>
              <label className="block text-xs text-zinc-600 mb-1">Sub-portafolios</label>
              <div className="border border-zinc-300 rounded bg-white max-h-48 overflow-y-auto">
                {columns.map((c) => (
                  <label key={c} className="flex items-center gap-2 px-2 py-1 hover:bg-zinc-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedCols.includes(c)}
                      onChange={() => toggleCol(c)}
                    />
                    <span className="text-xs">{c}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <button
            disabled={busy || !datasetId || selectedCols.length === 0}
            onClick={addFrench}
            className="w-full bg-zinc-900 text-white text-sm py-1.5 rounded disabled:opacity-40"
          >
            {busy ? "Agregando…" : "Agregar al universo"}
          </button>
        </div>
      )}

      {tab === "paste" && (
        <div className="space-y-3 text-sm">
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Nombre de la serie</label>
            <input
              value={pasteName}
              onChange={(e) => setPasteName(e.target.value)}
              className="w-full border border-zinc-300 rounded px-2 py-1 bg-white"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Tipo de datos</label>
            <select
              value={pasteKind}
              onChange={(e) => setPasteKind(e.target.value as any)}
              className="w-full border border-zinc-300 rounded px-2 py-1 bg-white"
            >
              <option value="prices">Precios (cierre mensual)</option>
              <option value="returns_dec">Retornos decimales (0.0123)</option>
              <option value="returns_pct">Retornos en % (1.23)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Formato decimal</label>
            <select
              value={pasteFmt}
              onChange={(e) => setPasteFmt(e.target.value as DecimalFormat)}
              className="w-full border border-zinc-300 rounded px-2 py-1 bg-white"
            >
              <option value="comma">Coma decimal — 1.234,56 (Argentina/Uruguay)</option>
              <option value="dot">Punto decimal — 1,234.56 (US/UK)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-600 mb-1">
              Pegá directo desde Excel (fecha + valor)
            </label>
            <textarea
              rows={10}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={"31/01/2020\t321,73\n29/02/2020\t296,26\n31/03/2020\t254,39\n…"}
              className="w-full border border-zinc-300 rounded px-2 py-1 bg-white text-xs font-mono"
            />
            <p className="text-[11px] text-zinc-500 mt-1">
              Seleccioná 2 columnas en Excel y Ctrl+V. Fechas DD/MM/YYYY, YYYY-MM-DD,
              Ene-20, etc.
            </p>
          </div>

          {pastePreview && pastePreview.ok && (
            <div className="border border-zinc-300 bg-white rounded p-2 text-[11px]">
              <p className="font-semibold mb-1">
                Vista previa — {pastePreview.data.rows.length} filas leídas
                {pasteKind === "prices" && ` → ${pastePreview.data.returns.length} retornos`}
              </p>
              <table className="w-full font-mono">
                <thead className="text-zinc-500">
                  <tr>
                    <th className="text-left pr-2">Fecha</th>
                    <th className="text-right pr-2">Valor leído</th>
                    {pasteKind === "prices" && <th className="text-right">Retorno calculado</th>}
                  </tr>
                </thead>
                <tbody>
                  {pastePreview.data.rows.slice(0, 4).map((r, i) => (
                    <tr key={`h${i}`}>
                      <td className="pr-2">{r.date}</td>
                      <td className="pr-2 text-right">{r.value}</td>
                      {pasteKind === "prices" && (
                        <td className="text-right">
                          {i === 0
                            ? "—"
                            : `${(((r.value / pastePreview.data.rows[i - 1].value) - 1) * 100).toFixed(2)}%`}
                        </td>
                      )}
                    </tr>
                  ))}
                  {pastePreview.data.rows.length > 8 && (
                    <tr>
                      <td colSpan={3} className="text-center text-zinc-400 py-0.5">⋮</td>
                    </tr>
                  )}
                  {pastePreview.data.rows.slice(-3).map((r, i) => {
                    const idx = pastePreview.data.rows.length - 3 + i;
                    return (
                      <tr key={`t${i}`}>
                        <td className="pr-2">{r.date}</td>
                        <td className="pr-2 text-right">{r.value}</td>
                        {pasteKind === "prices" && (
                          <td className="text-right">
                            {idx === 0
                              ? "—"
                              : `${(((r.value / pastePreview.data.rows[idx - 1].value) - 1) * 100).toFixed(2)}%`}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="text-zinc-500 mt-1">
                Revisá: los valores deberían coincidir con tu Excel. Si ves todo dividido por 1000 o algo raro,
                cambiá el formato decimal arriba.
              </p>
            </div>
          )}
          {pastePreview && !pastePreview.ok && (
            <p className="text-xs text-red-600">{pastePreview.error}</p>
          )}

          <button
            onClick={() => {
              const parsed = parsePastedCSV(pasteText, pasteKind, pasteFmt);
              if (!parsed.ok) {
                setError(parsed.error);
                return;
              }
              if (parsed.data.returns.length === 0) {
                setError("No se pudo parsear ninguna fila.");
                return;
              }
              setError(null);
              onAdd([
                {
                  id: `paste::${pasteName}::${Date.now()}`,
                  name: pasteName.trim() || "Custom",
                  source: "custom",
                  returns: parsed.data.returns,
                },
              ]);
              setPasteText("");
            }}
            className="w-full bg-zinc-900 text-white text-sm py-1.5 rounded"
          >
            Agregar serie
          </button>
        </div>
      )}

      {error && (
        <p className="mt-3 text-xs text-red-600 break-words">{error}</p>
      )}

      <div className="mt-5 pt-4 border-t border-zinc-200">
        {(() => {
          const activeCount = series.filter((s) => s.active !== false).length;
          return (
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold">
                Biblioteca ({activeCount}/{series.length})
              </h3>
              {series.length > 0 && (
                <button onClick={onClear} className="text-xs text-zinc-500 hover:text-red-600">
                  Borrar todo
                </button>
              )}
            </div>
          );
        })()}
        {series.length === 0 ? (
          <p className="text-xs text-zinc-500">Vacío — agregá series arriba.</p>
        ) : (
          <>
            <div className="flex gap-2 mb-2 text-[11px]">
              <button
                onClick={() => onSetAllActive(true)}
                className="text-zinc-600 hover:text-zinc-900 underline"
              >
                Activar todas
              </button>
              <span className="text-zinc-300">·</span>
              <button
                onClick={() => onSetAllActive(false)}
                className="text-zinc-600 hover:text-zinc-900 underline"
              >
                Desactivar todas
              </button>
            </div>
            <ul className="space-y-2">
              {series.map((s) => {
                const isActive = s.active !== false;
                const sepIdx = s.name.indexOf(" · ");
                const dsPart = sepIdx > 0 ? s.name.slice(0, sepIdx) : null;
                const subPart = sepIdx > 0 ? s.name.slice(sepIdx + 3) : s.name;
                const positions =
                  s.source === "french" ? prettifyKenFrenchCol(subPart) : [subPart];
                return (
                  <li key={s.id} className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={isActive}
                      onChange={() => onToggleActive(s.id)}
                      className="mt-1"
                      title="Incluir en el análisis"
                    />
                    <button
                      onClick={() => downloadSeriesCSV(s)}
                      className="text-zinc-400 hover:text-zinc-900 mt-0.5"
                      title="Descargar CSV"
                    >
                      ⬇
                    </button>
                    <button
                      onClick={() => onRemove(s.id)}
                      className="text-zinc-400 hover:text-red-600 mt-0.5"
                      title="Borrar de la biblioteca"
                    >
                      ✕
                    </button>
                    <div className={`flex-1 leading-tight ${isActive ? "" : "opacity-50"}`}>
                      {dsPart && (
                        <div className="text-[10px] text-zinc-500 break-words">
                          {dsPart}
                        </div>
                      )}
                      {positions.length === 2 ? (
                        <div className="flex items-baseline gap-1.5 break-words">
                          <span className="font-medium">{positions[0]}</span>
                          <span className="text-zinc-400">×</span>
                          <span className="font-medium">{positions[1]}</span>
                          <span className="text-[10px] text-zinc-400 ml-1">({subPart})</span>
                        </div>
                      ) : (
                        <div className="font-medium break-words">
                          {positions[0]}
                          {positions[0] !== subPart && (
                            <span className="text-[10px] text-zinc-400 ml-1">({subPart})</span>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <button
              onClick={() => downloadAllSeriesCSV(series.filter((s) => s.active !== false))}
              disabled={series.filter((s) => s.active !== false).length === 0}
              className="mt-3 w-full bg-zinc-100 hover:bg-zinc-200 text-zinc-900 text-xs py-1.5 rounded border border-zinc-300 disabled:opacity-40"
            >
              ⬇ Descargar activas combinadas (CSV)
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
