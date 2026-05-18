"use client";

import { useEffect, useMemo, useState } from "react";
import type { FrenchDatasetMeta, SeriesData, Region, Family, ReturnPoint } from "@/lib/types";

function monthEndISO(y: number, m: number): string {
  const last = new Date(Date.UTC(y, m, 0));
  return last.toISOString().slice(0, 10);
}

function parsePastedCSV(
  text: string,
  kind: "returns_dec" | "returns_pct" | "prices",
): { ok: true; returns: ReturnPoint[] } | { ok: false; error: string } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  type Row = { date: string; value: number };
  const rows: Row[] = [];
  for (const line of lines) {
    const parts = line.split(/[,;\t]/).map((p) => p.trim());
    if (parts.length < 2) continue;
    const rawDate = parts[0];
    const rawValue = parts[parts.length - 1].replace(/%/g, "").replace(/,/g, ".");
    const n = parseFloat(rawValue);
    if (!Number.isFinite(n)) continue;

    let iso: string | null = null;
    const ymd = rawDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    const ym = rawDate.match(/^(\d{4})-(\d{1,2})$/);
    const yyyymm = rawDate.match(/^(\d{4})(\d{2})$/);
    const dmy = rawDate.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (ymd) {
      iso = monthEndISO(parseInt(ymd[1]), parseInt(ymd[2]));
    } else if (ym) {
      iso = monthEndISO(parseInt(ym[1]), parseInt(ym[2]));
    } else if (yyyymm) {
      iso = monthEndISO(parseInt(yyyymm[1]), parseInt(yyyymm[2]));
    } else if (dmy) {
      iso = monthEndISO(parseInt(dmy[3]), parseInt(dmy[2]));
    } else {
      continue;
    }
    rows.push({ date: iso, value: n });
  }
  if (rows.length === 0) {
    return { ok: false, error: "No se reconoció ninguna fila válida." };
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
  return { ok: true, returns };
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
  "Size / Book-to-Market",
  "Size / Profitability",
  "Industry / Sector",
];

type Props = {
  series: SeriesData[];
  onAdd: (s: SeriesData[]) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
};

export default function UniverseBuilder({ series, onAdd, onRemove, onClear }: Props) {
  const [tab, setTab] = useState<"french" | "yahoo" | "paste">("french");
  const [pasteName, setPasteName] = useState("SPY");
  const [pasteKind, setPasteKind] = useState<"returns_dec" | "returns_pct" | "prices">("prices");
  const [pasteText, setPasteText] = useState("");
  const [datasets, setDatasets] = useState<FrenchDatasetMeta[]>([]);
  const [region, setRegion] = useState<Region>("US");
  const [family, setFamily] = useState<Family>("Size / Book-to-Market");
  const [datasetId, setDatasetId] = useState<string>("");
  const [columns, setColumns] = useState<string[]>([]);
  const [selectedCols, setSelectedCols] = useState<string[]>([]);
  const [loadingDs, setLoadingDs] = useState(false);
  const [tickerInput, setTickerInput] = useState("SPY, ^DJI, ^GSPC");
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
      const newSeries: SeriesData[] = selectedCols.map((col) => {
        const idx = cols.indexOf(col);
        const returns = rows
          .map((r) => ({ date: r.date, value: r.values[idx] }))
          .filter((p): p is { date: string; value: number } => p.value != null);
        return {
          id: `${datasetId}::${col}`,
          name: `${datasetId} · ${col}`,
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

  async function addTickers() {
    const tickers = tickerInput.split(",").map((t) => t.trim()).filter(Boolean);
    if (tickers.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const results = await Promise.all(
        tickers.map(async (t) => {
          const res = await fetch(`/api/yahoo?ticker=${encodeURIComponent(t)}`);
          if (!res.ok) {
            const msg = (await res.json()).error || res.statusText;
            throw new Error(`${t}: ${msg}`);
          }
          const data = await res.json();
          const returns = (data.returns ?? []) as { date: string; value: number }[];
          return {
            id: `yf::${t}`,
            name: t,
            source: "yahoo" as const,
            returns,
          };
        }),
      );
      onAdd(results.filter((r) => r.returns.length > 0));
    } catch (e: any) {
      setError(e.message ?? "Error con tickers");
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
      <h2 className="text-base font-semibold mb-3">Universo</h2>

      <div className="flex border-b border-zinc-200 mb-3 text-sm">
        <button
          className={`px-3 py-1.5 ${tab === "french" ? "border-b-2 border-zinc-900 font-semibold" : "text-zinc-500"}`}
          onClick={() => setTab("french")}
        >
          Ken French
        </button>
        <button
          className={`px-3 py-1.5 ${tab === "yahoo" ? "border-b-2 border-zinc-900 font-semibold" : "text-zinc-500"}`}
          onClick={() => setTab("yahoo")}
        >
          Yahoo
        </button>
        <button
          className={`px-3 py-1.5 ${tab === "paste" ? "border-b-2 border-zinc-900 font-semibold" : "text-zinc-500"}`}
          onClick={() => setTab("paste")}
        >
          Pegar
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

      {tab === "yahoo" && (
        <div className="space-y-3 text-sm">
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Tickers (coma)</label>
            <textarea
              rows={3}
              value={tickerInput}
              onChange={(e) => setTickerInput(e.target.value)}
              className="w-full border border-zinc-300 rounded px-2 py-1 bg-white text-xs"
              placeholder="SPY, ^DJI, ^GSPC, EEM"
            />
            <p className="text-[11px] text-zinc-500 mt-1">
              Ej: SPY, QQQ, ^GSPC, ^DJI, ^STOXX50E, EEM, EWZ
            </p>
          </div>
          <button
            disabled={busy}
            onClick={addTickers}
            className="w-full bg-zinc-900 text-white text-sm py-1.5 rounded disabled:opacity-40"
          >
            {busy ? "Bajando…" : "Agregar tickers"}
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
            <label className="block text-xs text-zinc-600 mb-1">Pegá CSV (fecha, valor)</label>
            <textarea
              rows={10}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={"2020-01-31, 321.73\n2020-02-29, 296.26\n2020-03-31, 254.39\n…"}
              className="w-full border border-zinc-300 rounded px-2 py-1 bg-white text-xs font-mono"
            />
            <p className="text-[11px] text-zinc-500 mt-1">
              Fechas: YYYY-MM-DD, YYYY-MM o YYYYMM. Acepta coma, tab o punto y coma como separador.
            </p>
          </div>
          <button
            onClick={() => {
              const parsed = parsePastedCSV(pasteText, pasteKind);
              if (!parsed.ok) {
                setError(parsed.error);
                return;
              }
              if (parsed.returns.length === 0) {
                setError("No se pudo parsear ninguna fila.");
                return;
              }
              setError(null);
              onAdd([
                {
                  id: `paste::${pasteName}::${Date.now()}`,
                  name: pasteName.trim() || "Custom",
                  source: "custom",
                  returns: parsed.returns,
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
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Series ({series.length})</h3>
          {series.length > 0 && (
            <button onClick={onClear} className="text-xs text-zinc-500 hover:text-red-600">
              Limpiar
            </button>
          )}
        </div>
        {series.length === 0 ? (
          <p className="text-xs text-zinc-500">Vacío — agregá series arriba.</p>
        ) : (
          <ul className="space-y-1">
            {series.map((s) => (
              <li key={s.id} className="flex items-start gap-2 text-xs">
                <button
                  onClick={() => onRemove(s.id)}
                  className="text-zinc-400 hover:text-red-600 mt-0.5"
                  title="Quitar"
                >
                  ✕
                </button>
                <span className="flex-1 break-words">{s.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
