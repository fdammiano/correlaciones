"use client";

import { useEffect, useMemo, useState } from "react";
import type { FrenchDatasetMeta, SeriesData, Region, Family, ReturnPoint } from "@/lib/types";
import { downloadAllSeriesCSV, downloadSeriesCSV } from "@/lib/download";
import {
  defaultOpName,
  operate,
  portfolioReturns,
  REBALANCE_LABEL,
  type OpType,
  type RebalanceFreq,
} from "@/lib/operations";

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

// Source badge color/label so the user can see at a glance where each
// series comes from.
function sourceBadge(s: SeriesData): { label: string; cls: string } {
  if (s.source === "french") return { label: "FF", cls: "bg-blue-100 text-blue-800" };
  if (s.source === "yahoo") return { label: "YF", cls: "bg-rose-100 text-rose-800" };
  if (s.id.startsWith("ms::")) return { label: "MS", cls: "bg-emerald-100 text-emerald-800" };
  if (s.id.startsWith("op::")) return { label: "Op", cls: "bg-orange-100 text-orange-800" };
  if (s.id.startsWith("paste::")) return { label: "Excel", cls: "bg-purple-100 text-purple-800" };
  return { label: "—", cls: "bg-brand-50 text-zinc-600" };
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
  "Book-to-Market",
  "Profitability",
  "Momentum",
  "Dividend Yield",
  "Investment",
  "Earnings/Price",
  "Cashflow/Price",
  "Size / Book-to-Market",
  "Size / Profitability",
  "Size / Momentum",
  "Size / Dividend Yield",
  "Industry / Sector",
];

type TabInfo = { id: string; name: string; count: number };

type Props = {
  series: SeriesData[];
  tabs: TabInfo[];
  activeTabId: string;
  isCollection: boolean;
  collectionName: string;
  onSelectTab: (id: string) => void;
  onNewCollection: () => void;
  onSaveActiveAsCollection: () => void;
  onRenameActiveCollection: (name: string) => void;
  onDeleteActiveCollection: () => void;
  onAdd: (s: SeriesData[]) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onToggleActive: (id: string) => void;
  onSetAllActive: (active: boolean) => void;
  onActivateOnly: (ids: string[]) => void;
  onInvert: () => void;
  onToggleHighlight: (id: string) => void;
  onUpdateSeries: (s: SeriesData) => void;
  onReorder: (draggedId: string, targetId: string) => void;
  refreshing?: boolean;
  storageBadge?: string;
};

export default function UniverseBuilder({
  series,
  tabs,
  activeTabId,
  isCollection,
  collectionName,
  onSelectTab,
  onNewCollection,
  onSaveActiveAsCollection,
  onRenameActiveCollection,
  onDeleteActiveCollection,
  onAdd,
  onRemove,
  onClear,
  onToggleActive,
  onSetAllActive,
  onActivateOnly,
  onInvert,
  onToggleHighlight,
  onUpdateSeries,
  onReorder,
  refreshing,
  storageBadge,
}: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [librarySearch, setLibrarySearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [tab, setTab] = useState<"french" | "yahoo" | "ms" | "paste" | "op" | "port">("french");
  const [editingPortfolioId, setEditingPortfolioId] = useState<string | null>(null);
  const [yfTicker, setYfTicker] = useState("");
  const [yfName, setYfName] = useState("");
  const [pasteName, setPasteName] = useState("SPY");
  // operation builder state
  const [opType, setOpType] = useState<OpType>("diff");
  const [opAId, setOpAId] = useState<string>("");
  const [opBId, setOpBId] = useState<string>("");
  const [opWeight, setOpWeight] = useState<number>(0.5);
  const [opScalar, setOpScalar] = useState<number>(1);
  const [opOffsetPct, setOpOffsetPct] = useState<number>(0); // user types in %, converted to decimal
  const [opName, setOpName] = useState<string>("");
  const [msIdType, setMsIdType] = useState<"isin" | "ticker" | "secid">("isin");
  const [msIdValue, setMsIdValue] = useState("");
  const [msName, setMsName] = useState("");
  // Token de Morningstar (vence cada 24 h; se pega acá y se guarda en KV)
  const [msTokenStatus, setMsTokenStatus] = useState<{
    hasToken: boolean;
    updatedAt: string | null;
    requiresPassword: boolean;
    configured: boolean;
  } | null>(null);
  const [msTokenInput, setMsTokenInput] = useState("");
  const [msTokenPassword, setMsTokenPassword] = useState("");
  const [msTokenBusy, setMsTokenBusy] = useState(false);
  const [msTokenMsg, setMsTokenMsg] = useState<string | null>(null);
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
      .catch(() => setError("No pude cargar la lista de Fama French."));
  }, []);

  // Al entrar a una colección, mostrar la lista "Agregar del maestro" desplegada.
  useEffect(() => {
    if (isCollection) setShowInactive(true);
  }, [activeTabId, isCollection]);

  const filtered = useMemo(
    () => datasets.filter((d) => d.region === region && d.family === family),
    [datasets, region, family],
  );

  // Solo ofrecer regiones/familias que EXISTEN en la base de Ken French.
  // Ej: Emerging Markets no tiene Industry/Sector ni single-sorts.
  const availableRegions = useMemo(
    () => REGIONS.filter((r) => datasets.some((d) => d.region === r)),
    [datasets],
  );
  const familiesForRegion = useMemo(
    () => FAMILIES.filter((f) => datasets.some((d) => d.region === region && d.family === f)),
    [datasets, region],
  );

  // Si al cambiar de región la familia actual no existe ahí, saltar a la primera válida.
  useEffect(() => {
    if (familiesForRegion.length > 0 && !familiesForRegion.includes(family)) {
      setFamily(familiesForRegion[0]);
    }
  }, [familiesForRegion, family]);

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
      setSelectedCols([]); // por defecto vacío: el usuario elige cuáles
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

  async function refreshMsTokenStatus() {
    try {
      const res = await fetch("/api/ms-token", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setMsTokenStatus({
        hasToken: !!data.hasToken,
        updatedAt: data.updatedAt ?? null,
        requiresPassword: !!data.requiresPassword,
        configured: !!data.configured,
      });
    } catch {
      // silencioso
    }
  }

  // Cargar el estado del token al entrar a la pestaña Morningstar
  useEffect(() => {
    if (tab === "ms") refreshMsTokenStatus();
  }, [tab]);

  async function saveMsToken() {
    if (!msTokenInput.trim()) return;
    setMsTokenBusy(true);
    setMsTokenMsg(null);
    try {
      const res = await fetch("/api/ms-token", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: msTokenInput.trim(),
          password: msTokenPassword || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      setMsTokenInput("");
      setMsTokenPassword("");
      setMsTokenMsg("Token guardado ✓");
      await refreshMsTokenStatus();
    } catch (e: any) {
      setMsTokenMsg(e.message ?? "No se pudo guardar el token");
    } finally {
      setMsTokenBusy(false);
    }
  }

  function msTokenInfo(): { label: string; tone: "ok" | "warn" | "bad" } {
    const st = msTokenStatus;
    if (!st) return { label: "cargando…", tone: "warn" };
    if (!st.configured) return { label: "KV no configurado en Vercel", tone: "bad" };
    if (!st.hasToken || !st.updatedAt) {
      return { label: "sin token — pegá uno para habilitar Morningstar", tone: "bad" };
    }
    const ageMs = Date.now() - new Date(st.updatedAt).getTime();
    const hours = ageMs / 3_600_000;
    const when = new Date(st.updatedAt).toLocaleString("es-UY", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    if (hours >= 24) {
      return { label: `vencido (${when}) — pegá uno nuevo`, tone: "bad" };
    }
    const age =
      hours < 1 ? `${Math.max(1, Math.round(ageMs / 60000))} min` : `${Math.round(hours)} h`;
    return { label: `activo · hace ${age} (${when})`, tone: "ok" };
  }

  async function addMorningstar() {
    if (!msIdValue.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set(msIdType, msIdValue.trim());
      const res = await fetch(`/api/morningstar?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || data.detail || res.statusText);
      }
      const returns = (data.returns ?? []) as ReturnPoint[];
      if (returns.length === 0) {
        const cols = data.schema_columns ?? [];
        throw new Error(
          `Sin retornos parseables. La SDK devolvió columnas: [${cols.join(", ")}]. ` +
            `Probá otro datapoint id o pasame ese listado.`,
        );
      }
      const label = msName.trim() || `${msIdType.toUpperCase()}:${msIdValue.trim()}`;
      onAdd([
        {
          id: `ms::${msIdType}::${msIdValue.trim()}::${Date.now()}`,
          name: `Morningstar · ${label}`,
          source: "custom",
          returns,
        },
      ]);
      setMsIdValue("");
      setMsName("");
    } catch (e: any) {
      setError(e.message ?? "Error con Morningstar");
    } finally {
      setBusy(false);
    }
  }

  async function addYahoo() {
    const ticker = yfTicker.trim();
    if (!ticker) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/yahoo?ticker=${encodeURIComponent(ticker)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      const returns = (data.returns ?? []) as ReturnPoint[];
      if (returns.length === 0) throw new Error("Sin retornos para ese ticker.");
      onAdd([
        {
          id: `yahoo::${ticker.toUpperCase()}`,
          name: yfName.trim() || ticker.toUpperCase(),
          source: "yahoo",
          returns,
        },
      ]);
      setYfTicker("");
      setYfName("");
    } catch (e: any) {
      setError(e.message ?? "Error con Yahoo Finance");
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
    <aside className="w-96 shrink-0 border-r border-zinc-200 bg-surface p-3 h-screen sticky top-0 flex flex-col gap-2 overflow-hidden">
      {/* ── Cómo funciona (2 pasos, compacto) ── */}
      <div className="shrink-0 rounded-md bg-sky-50 border border-sky-200 px-2.5 py-1 text-[10px] text-zinc-600 leading-tight">
        <b className="text-brand-800">Cómo funciona:</b> 1) elegí activos abajo · 2) correlaciones a la derecha →
      </div>

      {/* ── Pestañas de bibliotecas ── */}
      <div className="shrink-0 bg-zinc-100 border border-zinc-200 rounded-lg p-2">
        <div className="flex items-center gap-1 flex-wrap">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => onSelectTab(t.id)}
              className={`px-2.5 py-1 rounded text-xs transition-colors ${
                activeTabId === t.id
                  ? "bg-brand-700 text-white font-semibold"
                  : "text-zinc-600 hover:bg-brand-50"
              }`}
              title={
                t.id === "master"
                  ? "Catálogo maestro — compartido entre todos"
                  : "Colección — privada de este navegador"
              }
            >
              {t.id === "master" ? "★ " : ""}
              {t.name}
              <span
                className={`ml-1 text-[10px] ${
                  activeTabId === t.id ? "text-brand-100" : "text-zinc-400"
                }`}
              >
                {t.count}
              </span>
            </button>
          ))}
          <button
            onClick={onNewCollection}
            title="Nueva colección"
            className="px-2 py-1 text-sm text-zinc-500 hover:text-brand-700 rounded hover:bg-brand-50"
          >
            ＋
          </button>
        </div>

        {isCollection ? (
          <div className="flex items-center gap-2 mt-2">
            <input
              value={collectionName}
              onChange={(e) => onRenameActiveCollection(e.target.value)}
              className="flex-1 border border-zinc-300 rounded px-2 py-1 text-sm bg-white"
              placeholder="Nombre de la colección"
            />
            <button
              onClick={onDeleteActiveCollection}
              title="Borrar esta colección (no afecta el maestro)"
              className="text-xs text-zinc-500 hover:text-red-600 border border-zinc-300 rounded px-2 py-1"
            >
              Borrar
            </button>
          </div>
        ) : (
          <p className="text-[10px] text-zinc-500 mt-1.5 leading-tight">
            Maestro (compartido) ·{" "}
            <button
              onClick={onSaveActiveAsCollection}
              className="text-brand-700 underline"
              disabled={series.filter((s) => s.active !== false).length === 0}
            >
              guardar activas como colección
            </button>
          </p>
        )}
      </div>

      <div className="shrink-0 flex items-center justify-between">
        <h2 className="text-base font-semibold tracking-tight text-brand-800 flex items-center gap-2">
          {isCollection ? "Colección" : "Universo"}
          {refreshing && (
            <span className="text-[10px] font-normal text-brand-500 animate-pulse">
              actualizando…
            </span>
          )}
        </h2>
        {storageBadge && (
          <span
            className={`text-[10px] px-2 py-0.5 rounded ${
              storageBadge === "compartido"
                ? "bg-emerald-100 text-emerald-800"
                : storageBadge === "solo local"
                ? "bg-amber-100 text-amber-800"
                : "bg-brand-50 text-zinc-500"
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

      <div className="order-2 flex-1 min-h-0 overflow-y-auto bg-blue-100 border border-blue-200 rounded-lg p-3">
      <h3 className="text-sm font-semibold mb-0.5">Agregar activos</h3>
      <p className="text-[11px] text-zinc-500 mb-3">Traé datos de una fuente, o combiná los que ya cargaste.</p>

      <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide mb-1">Datos de mercado</p>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {(
          [
            ["french", "Fama French"],
            ["yahoo", "Yahoo"],
            ["ms", "Morningstar"],
            ["paste", "Excel"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-3 py-1 rounded-full text-xs transition-colors ${
              tab === k ? "bg-brand-700 text-white font-semibold" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide mb-1">Combinar lo que ya tenés</p>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {(
          [
            ["op", "Operar"],
            ["port", "Cartera"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-3 py-1 rounded-full text-xs transition-colors ${
              tab === k ? "bg-brand-700 text-white font-semibold" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
            }`}
          >
            {label}
          </button>
        ))}
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
              {(availableRegions.length ? availableRegions : REGIONS).map((r) => (
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
              {(familiesForRegion.length ? familiesForRegion : FAMILIES).map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
            <p className="text-[10px] text-zinc-400 mt-1">
              Solo se listan las familias que existen para <b>{region}</b> en Ken French.
            </p>
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
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs text-zinc-600">
                  Sub-portafolios <span className="text-zinc-400">({selectedCols.length}/{columns.length})</span>
                </label>
                <button
                  type="button"
                  onClick={() => setSelectedCols(selectedCols.length === columns.length ? [] : [...columns])}
                  className="text-[11px] font-semibold text-brand-700 hover:text-brand-800"
                >
                  {selectedCols.length === columns.length ? "Ninguno" : "Todos"}
                </button>
              </div>
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
            className="w-full bg-brand-700 text-white text-sm py-1.5 rounded disabled:opacity-40"
          >
            {busy ? "Agregando…" : "Agregar al universo"}
          </button>
        </div>
      )}

      {tab === "yahoo" && (
        <div className="space-y-3 text-sm">
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Ticker de Yahoo</label>
            <input
              value={yfTicker}
              onChange={(e) => setYfTicker(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addYahoo();
              }}
              placeholder="SPY, AGG, VT, ^GSPC…"
              className="w-full border border-zinc-300 rounded px-2 py-1 bg-white font-mono text-xs"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Nombre para mostrar (opcional)</label>
            <input
              value={yfName}
              onChange={(e) => setYfName(e.target.value)}
              placeholder="S&P 500 TR"
              className="w-full border border-zinc-300 rounded px-2 py-1 bg-white"
            />
          </div>
          <button
            disabled={busy || !yfTicker.trim()}
            onClick={addYahoo}
            className="w-full bg-brand-700 text-white text-sm py-1.5 rounded disabled:opacity-40"
          >
            {busy ? "Bajando…" : "Bajar de Yahoo (mensual TR)"}
          </button>
          <div className="text-[11px] text-zinc-600 bg-brand-50 border border-zinc-200 rounded p-2 space-y-1">
            <p>
              <b>Qué se baja:</b> retornos <b>mensuales total-return</b> (adjusted close =
              dividendos reinvertidos + splits), con la <b>máxima historia</b> disponible. Se{" "}
              <b>actualiza sola</b> al abrir la página (incorpora los meses nuevos).
            </p>
            <p className="text-zinc-500">
              Ticker tal cual Yahoo: acciones/ETFs (SPY, AGG, VT), índices con ^ (^GSPC), etc.
            </p>
          </div>
        </div>
      )}

      {tab === "ms" && (
        <div className="space-y-3 text-sm">
          {(() => {
            const info = msTokenInfo();
            const toneClass =
              info.tone === "ok"
                ? "text-green-700 bg-green-50 border-green-200"
                : info.tone === "warn"
                  ? "text-amber-700 bg-amber-50 border-amber-200"
                  : "text-red-700 bg-red-50 border-red-200";
            return (
              <div className="border border-zinc-200 rounded p-2 space-y-2 bg-zinc-50">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-zinc-700">Token de Morningstar</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${toneClass}`}>
                    {info.label}
                  </span>
                </div>
                <textarea
                  value={msTokenInput}
                  onChange={(e) => setMsTokenInput(e.target.value)}
                  placeholder="Pegá acá el token fresco de Morningstar Direct…"
                  rows={3}
                  className="w-full border border-zinc-300 rounded px-2 py-1 bg-white font-mono text-[10px] leading-tight"
                />
                {msTokenStatus?.requiresPassword && (
                  <input
                    type="password"
                    value={msTokenPassword}
                    onChange={(e) => setMsTokenPassword(e.target.value)}
                    placeholder="Contraseña"
                    className="w-full border border-zinc-300 rounded px-2 py-1 bg-white text-xs"
                  />
                )}
                <button
                  disabled={msTokenBusy || !msTokenInput.trim()}
                  onClick={saveMsToken}
                  className="w-full bg-zinc-800 text-white text-xs py-1.5 rounded disabled:opacity-40"
                >
                  {msTokenBusy ? "Guardando…" : "Guardar token"}
                </button>
                {msTokenMsg && <p className="text-[11px] text-zinc-600">{msTokenMsg}</p>}
                <p className="text-[10px] text-zinc-500">
                  El token vence cada 24 h. Sacá uno nuevo de Morningstar Direct y pegalo acá; no
                  hace falta redeploy.
                </p>
              </div>
            );
          })()}
          <div className="flex gap-2">
            <div className="w-24">
              <label className="block text-xs text-zinc-600 mb-1">ID type</label>
              <select
                value={msIdType}
                onChange={(e) => setMsIdType(e.target.value as any)}
                className="w-full border border-zinc-300 rounded px-2 py-1 bg-white"
              >
                <option value="isin">ISIN</option>
                <option value="ticker">Ticker</option>
                <option value="secid">SecId</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-xs text-zinc-600 mb-1">Identifier</label>
              <input
                value={msIdValue}
                onChange={(e) => setMsIdValue(e.target.value)}
                placeholder="US12345..."
                className="w-full border border-zinc-300 rounded px-2 py-1 bg-white font-mono text-xs"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Nombre para mostrar</label>
            <input
              value={msName}
              onChange={(e) => setMsName(e.target.value)}
              placeholder="Russell 2000 Value TR"
              className="w-full border border-zinc-300 rounded px-2 py-1 bg-white"
            />
          </div>
          <button
            disabled={busy || !msIdValue.trim()}
            onClick={addMorningstar}
            className="w-full bg-brand-700 text-white text-sm py-1.5 rounded disabled:opacity-40"
          >
            {busy ? "Bajando…" : "Bajar de Morningstar"}
          </button>
          <div className="text-[11px] text-zinc-600 bg-brand-50 border border-zinc-200 rounded p-2 space-y-1">
            <p>
              <b>Lo que se baja:</b> retornos mensuales <b>total return</b> (HP010, NAV-based,
              dividendos reinvertidos), máxima historia disponible para ese security.
              No hay opciones para evitar errores: si querés precio sin dividendos u otra
              frecuencia, usá Bloomberg + pestaña Excel.
            </p>
          </div>
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
            className="w-full bg-brand-700 text-white text-sm py-1.5 rounded"
          >
            Agregar serie
          </button>
        </div>
      )}

      {tab === "op" && (
        <OperationBuilder
          allSeries={series}
          opType={opType}
          setOpType={setOpType}
          opAId={opAId}
          setOpAId={setOpAId}
          opBId={opBId}
          setOpBId={setOpBId}
          opWeight={opWeight}
          setOpWeight={setOpWeight}
          opScalar={opScalar}
          setOpScalar={setOpScalar}
          opOffsetPct={opOffsetPct}
          setOpOffsetPct={setOpOffsetPct}
          opName={opName}
          setOpName={setOpName}
          onCreate={(s) => {
            onAdd([s]);
            setOpName("");
          }}
          onError={setError}
        />
      )}

      {tab === "port" && (
        <PortfolioBuilder
          allSeries={series}
          editing={
            editingPortfolioId ? series.find((s) => s.id === editingPortfolioId) ?? null : null
          }
          onCreate={(s) => onAdd([s])}
          onUpdate={(s) => {
            onUpdateSeries(s);
            setEditingPortfolioId(null);
          }}
          onCancelEdit={() => setEditingPortfolioId(null)}
          onError={setError}
        />
      )}

      {error && (
        <p className="mt-3 text-xs text-red-600 break-words">{error}</p>
      )}
      </div>

      <div className="order-1 flex-1 min-h-0 overflow-y-auto flex flex-col bg-green-50 border border-green-200 rounded-lg p-3">
        {(() => {
          const activeCount = series.filter((s) => s.active !== false).length;
          // tally by source for the subline
          const tally: Record<string, number> = {};
          for (const s of series) {
            const b = sourceBadge(s).label;
            tally[b] = (tally[b] ?? 0) + 1;
          }
          const tallyStr = Object.entries(tally)
            .map(([k, n]) => `${n} ${k}`)
            .join(" · ");
          return (
            <>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Biblioteca</h3>
                {series.length > 0 && (
                  <button onClick={onClear} className="text-xs text-zinc-500 hover:text-red-600">
                    {isCollection ? "Vaciar colección" : "Borrar todo"}
                  </button>
                )}
              </div>
              {series.length > 0 && (
                <div className="text-[11px] text-zinc-500 mb-2">
                  <span className="font-semibold text-zinc-700">{activeCount}</span>
                  <span> activas de </span>
                  <span className="font-semibold text-zinc-700">{series.length}</span>
                  {tallyStr && <span> · {tallyStr}</span>}
                </div>
              )}
            </>
          );
        })()}
        {series.length === 0 ? (
          <p className="text-xs text-zinc-500">Vacío — agregá series abajo.</p>
        ) : (
          <>
            <input
              type="search"
              value={librarySearch}
              onChange={(e) => setLibrarySearch(e.target.value)}
              placeholder="🔍 Filtrar serie…"
              className="w-full border border-zinc-300 rounded px-2 py-1 mb-2 text-xs bg-white"
            />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2 text-[11px]">
              <button
                onClick={() => onSetAllActive(true)}
                className="text-zinc-600 hover:text-zinc-900 underline"
              >
                Todas
              </button>
              <button
                onClick={() => onSetAllActive(false)}
                className="text-zinc-600 hover:text-zinc-900 underline"
              >
                Ninguna
              </button>
              <button
                onClick={onInvert}
                className="text-zinc-600 hover:text-zinc-900 underline"
              >
                Invertir
              </button>
              {librarySearch.trim() && (
                <button
                  onClick={() =>
                    onActivateOnly(
                      series
                        .filter((s) =>
                          s.name.toLowerCase().includes(librarySearch.trim().toLowerCase()),
                        )
                        .map((s) => s.id),
                    )
                  }
                  className="text-brand-700 font-semibold hover:underline"
                  title="Activar solo las que coinciden con el filtro y desactivar el resto"
                >
                  ✓ Solo las filtradas
                </button>
              )}
            </div>
            {(() => {
              const renderRow = (s: SeriesData) => {
                const isActive = s.active !== false;
                const isHl = s.highlighted === true;
                const sepIdx = s.name.indexOf(" · ");
                const dsPart = sepIdx > 0 ? s.name.slice(0, sepIdx) : null;
                const subPart = sepIdx > 0 ? s.name.slice(sepIdx + 3) : s.name;
                const positions =
                  s.source === "french" ? prettifyKenFrenchCol(subPart) : [subPart];
                const isDragOver = overId === s.id && dragId && dragId !== s.id;
                return (
                  <li
                    key={s.id}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (dragId && dragId !== s.id) setOverId(s.id);
                    }}
                    onDragLeave={() => {
                      if (overId === s.id) setOverId(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragId && dragId !== s.id) onReorder(dragId, s.id);
                      setDragId(null);
                      setOverId(null);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverId(null);
                    }}
                    onClick={() => onToggleActive(s.id)}
                    title={isActive ? "Click para sacar del análisis" : "Click para incluir en el análisis"}
                    className={`group flex items-center gap-2 text-xs pl-1.5 pr-1 py-1 rounded cursor-pointer transition-colors hover:bg-brand-50 border-l-2 ${
                      isHl ? "bg-amber-50 border-amber-400" : "border-transparent"
                    } ${dragId === s.id ? "opacity-40" : ""} ${
                      isDragOver ? "border-t-2 border-t-brand-700" : ""
                    } ${isActive ? "" : "opacity-45 hover:opacity-100"}`}
                  >
                    {/* indicador de "en análisis" */}
                    <span
                      className={`shrink-0 w-4 h-4 rounded-sm border flex items-center justify-center text-white text-[10px] leading-none ${
                        isActive ? "bg-brand-700 border-brand-700" : "bg-white border-zinc-300"
                      }`}
                    >
                      {isActive ? "✓" : ""}
                    </span>

                    {/* nombre */}
                    <div className="flex-1 leading-tight min-w-0">
                      <div className="flex items-center gap-1 flex-wrap">
                        <span
                          className={`text-[9px] font-mono font-semibold px-1 py-px rounded ${sourceBadge(s).cls}`}
                          title="Fuente"
                        >
                          {sourceBadge(s).label}
                        </span>
                        {dsPart && (
                          <span className="text-[10px] text-zinc-500 break-words">
                            {dsPart}
                          </span>
                        )}
                      </div>
                      {positions.length === 2 ? (
                        <div className="flex items-baseline gap-1.5 break-words">
                          <span className="font-medium">{positions[0]}</span>
                          <span className="text-zinc-400">×</span>
                          <span className="font-medium">{positions[1]}</span>
                        </div>
                      ) : (
                        <div className="font-medium break-words">{positions[0]}</div>
                      )}
                    </div>

                    {/* acciones secundarias — aparecen al pasar el mouse */}
                    <div
                      className="shrink-0 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => onToggleHighlight(s.id)}
                        className={isHl ? "text-amber-500" : "text-zinc-300 hover:text-amber-500"}
                        title={isHl ? "Quitar destaque" : "Destacar en el gráfico"}
                      >
                        {isHl ? "★" : "☆"}
                      </button>
                      {(s.portfolio || s.id.startsWith("port::")) && (
                        <button
                          onClick={() => {
                            setEditingPortfolioId(s.id);
                            setTab("port");
                          }}
                          className="text-zinc-400 hover:text-brand-700"
                          title="Editar cartera (componentes, pesos, rebalanceo)"
                        >
                          ✎
                        </button>
                      )}
                      <button
                        onClick={() => downloadSeriesCSV(s)}
                        className="text-zinc-400 hover:text-zinc-900"
                        title="Descargar Excel (.xlsx)"
                      >
                        ⬇
                      </button>
                      <button
                        onClick={() => onRemove(s.id)}
                        className="text-zinc-400 hover:text-red-600"
                        title={isCollection ? "Quitar de la colección" : "Borrar de la biblioteca"}
                      >
                        ✕
                      </button>
                      <span
                        draggable
                        onDragStart={(e) => {
                          setDragId(s.id);
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", s.id);
                        }}
                        className="cursor-grab active:cursor-grabbing text-zinc-300 hover:text-zinc-500 select-none"
                        title="Arrastrar para reordenar"
                      >
                        ⋮⋮
                      </span>
                    </div>
                  </li>
                );
              };

              const matchesSearch = (s: SeriesData) =>
                librarySearch.trim()
                  ? s.name.toLowerCase().includes(librarySearch.trim().toLowerCase())
                  : true;
              const filtered = series.filter(matchesSearch);
              const activeRows = filtered.filter((s) => s.active !== false);
              const inactiveRows = filtered.filter((s) => s.active === false);

              return (
                <div className="pr-1">
                  <div className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 rounded px-1.5 py-1 mb-1 mt-1 sticky top-0 z-10 border border-emerald-200">
                    ✓ {isCollection ? "En esta colección" : "En análisis"} ({activeRows.length})
                  </div>
                  {activeRows.length === 0 ? (
                    <p className="text-[11px] text-zinc-500 px-1 py-1 italic">
                      Ninguna serie tildada. Activá una abajo o agregá nuevas.
                    </p>
                  ) : (
                    <ul className="space-y-0.5 mb-3">{activeRows.map(renderRow)}</ul>
                  )}

                  <div
                    className="text-[11px] font-semibold text-zinc-600 bg-brand-50 rounded px-1.5 py-1 mb-1 flex items-center justify-between cursor-pointer hover:bg-zinc-200 sticky top-0 z-10 border border-zinc-200"
                    onClick={() => setShowInactive(!showInactive)}
                  >
                    <span>○ {isCollection ? "Agregar del maestro" : "Disponibles"} ({inactiveRows.length})</span>
                    <span className="text-zinc-500">{showInactive ? "▾" : "▸"}</span>
                  </div>
                  {showInactive && inactiveRows.length > 0 && (
                    <ul className="space-y-0.5">{inactiveRows.map(renderRow)}</ul>
                  )}
                  {showInactive && inactiveRows.length === 0 && (
                    <p className="text-[11px] text-zinc-500 px-1 py-1 italic">
                      Todas las series están activas.
                    </p>
                  )}
                </div>
              );
            })()}
            <button
              onClick={() => downloadAllSeriesCSV(series.filter((s) => s.active !== false))}
              disabled={series.filter((s) => s.active !== false).length === 0}
              className="mt-3 w-full bg-brand-50 hover:bg-zinc-200 text-zinc-900 text-xs py-1.5 rounded border border-zinc-300 disabled:opacity-40"
            >
              ⬇ Descargar activas combinadas (Excel)
            </button>
          </>
        )}
      </div>
    </aside>
  );
}

function OperationBuilder({
  allSeries,
  opType,
  setOpType,
  opAId,
  setOpAId,
  opBId,
  setOpBId,
  opWeight,
  setOpWeight,
  opScalar,
  setOpScalar,
  opOffsetPct,
  setOpOffsetPct,
  opName,
  setOpName,
  onCreate,
  onError,
}: {
  allSeries: SeriesData[];
  opType: OpType;
  setOpType: (v: OpType) => void;
  opAId: string;
  setOpAId: (v: string) => void;
  opBId: string;
  setOpBId: (v: string) => void;
  opWeight: number;
  setOpWeight: (v: number) => void;
  opScalar: number;
  setOpScalar: (v: number) => void;
  opOffsetPct: number;
  setOpOffsetPct: (v: number) => void;
  opName: string;
  setOpName: (v: string) => void;
  onCreate: (s: SeriesData) => void;
  onError: (msg: string | null) => void;
}) {
  const needsB = opType !== "scale" && opType !== "weighted";

  const a = allSeries.find((s) => s.id === opAId) ?? allSeries[0];
  const b = needsB
    ? allSeries.find((s) => s.id === opBId && s.id !== a?.id) ??
      allSeries.find((s) => s.id !== a?.id)
    : undefined;

  // Combinación ponderada de N activos (peso en % por id; estar en el objeto = miembro)
  const [wWeights, setWWeights] = useState<Record<string, number>>({});
  const wMembers = useMemo(
    () => allSeries.filter((s) => s.id in wWeights).map((s) => ({ series: s, weight: wWeights[s.id] || 0 })),
    [allSeries, wWeights],
  );
  const wTotal = wMembers.reduce((acc, m) => acc + m.weight, 0);
  const wPreview = useMemo(
    () => (opType === "weighted" ? portfolioReturns(wMembers, "monthly") : []),
    [wMembers, opType],
  );
  function wToggle(id: string) {
    setWWeights((prev) => {
      const next = { ...prev };
      if (id in next) delete next[id];
      else { const n = Object.keys(next).length + 1; next[id] = Math.round((100 / n) * 100) / 100; }
      return next;
    });
  }
  function wSet(id: string, val: number) { setWWeights((prev) => ({ ...prev, [id]: val })); }
  function wEqual() {
    setWWeights((prev) => {
      const ids = Object.keys(prev);
      if (!ids.length) return prev;
      const w = Math.round((100 / ids.length) * 100) / 100;
      return Object.fromEntries(ids.map((id) => [id, w]));
    });
  }
  const wAutoName = `Combinación (${wMembers.length} activo${wMembers.length === 1 ? "" : "s"})`;

  const auto = useMemo(() => {
    if (!a) return "";
    return defaultOpName({
      type: opType,
      a,
      b,
      weight: opWeight,
      scalar: opScalar,
      offset: opOffsetPct / 100,
    });
  }, [a, b, opType, opWeight, opScalar, opOffsetPct]);

  const opLabel: Record<OpType, string> = {
    diff: "Diferencia (long/short) · r_A − r_B",
    ratio: "Ratio de riqueza (compuesto) · (1+r_A)/(1+r_B) − 1",
    sum: "Suma / overlay · r_A + r_B",
    weighted: "Cartera ponderada · Σ wᵢ·rᵢ",
    scale: "Escala / leverage · c·r_A + offset",
  };

  // Naturaleza matemática de cada operación (para el badge y para no confundir
  // "lineal" con "compuesto"). El compounding EN EL TIEMPO siempre ocurre
  // después, al acumular la serie mensual a Base 100 con ∏(1+r).
  const opKind: Record<OpType, "LINEAL" | "COMPUESTA" | "CARTERA"> = {
    diff: "LINEAL",
    ratio: "COMPUESTA",
    sum: "LINEAL",
    weighted: "CARTERA",
    scale: "LINEAL",
  };

  const opDescription: Record<OpType, string> = {
    diff:
      "Resta directa mes a mes: r_A − r_B. Es la construcción de los factores académicos (SMB, HML, MOM): el P&L de estar long $1 en A y short $1 en B, rebalanceado cada mes.",
    ratio:
      "Cociente de riquezas: (1+r_A)/(1+r_B) − 1 cada mes. Acumulado da EXACTAMENTE Wealth_A(t)/Wealth_B(t) — cuánto más vale A que B en patrimonio. Es la versión geométrica de la diferencia; para retornos chicos (<~5%/mes) casi coincide con r_A − r_B, en meses grandes no.",
    sum: "Suma mes a mes r_A + r_B, SIN el término cruzado r_A·r_B. Representa un overlay: estar 100% en A y además 100% en B (bruto 200%, apalancado). Sirve para sumarle a una base la pata de un factor. NO es una cartera: si querés “tener ambos” con pesos que sumen 100%, usá «Cartera ponderada». (No existe una “suma compuesta” de dos activos simultáneos: el producto (1+r_A)(1+r_B)−1 sería compounding secuencial en el tiempo, que no aplica acá.)",
    weighted:
      "La forma correcta de “tener varios activos a la vez” como cartera: r = Σ wᵢ·rᵢ con los pesos normalizados a 100%, rebalanceo mensual. Elegí activos y pesos abajo.",
    scale:
      "Transforma A: c·r_A + offset mensual fijo. Usos: c=2 → leverage 2x · c=0.5 → des-apalanca · c=−1 → invierte el signo (short lógico) · offset=−0.003 → resta ~3.75% anual (rf) para excess return. Combinable: c=1.5 + offset=−0.001 = leverage con costo de funding.",
  };

  const opKindStyle: Record<string, string> = {
    LINEAL: "bg-blue-50 text-blue-700 border-blue-200",
    COMPUESTA: "bg-violet-50 text-violet-700 border-violet-200",
    CARTERA: "bg-emerald-50 text-emerald-700 border-emerald-200",
  };

  return (
    <div className="space-y-3 text-sm">
      <div>
        <label className="block text-xs text-zinc-600 mb-1">Operación</label>
        <select
          value={opType}
          onChange={(e) => setOpType(e.target.value as OpType)}
          className="w-full border border-zinc-300 rounded px-2 py-1 bg-white"
        >
          {(Object.keys(opLabel) as OpType[]).map((k) => (
            <option key={k} value={k}>
              {opLabel[k]}
            </option>
          ))}
        </select>
        <div className="bg-zinc-50 border border-zinc-200 rounded p-2 mt-1.5">
          <div className="flex items-center gap-2 mb-1">
            <span
              className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border ${opKindStyle[opKind[opType]]}`}
            >
              {opKind[opType]}
            </span>
            {opKind[opType] === "LINEAL" && (
              <span className="text-[10px] text-zinc-400">
                lineal mes a mes · el compounding en el tiempo lo aplica el Base 100
              </span>
            )}
          </div>
          <p className="text-[11px] text-zinc-600 leading-relaxed">{opDescription[opType]}</p>
        </div>
      </div>

      {opType !== "weighted" && (
        <div>
          <label className="block text-xs text-zinc-600 mb-1">Serie A</label>
          <select
            value={a?.id ?? ""}
            onChange={(e) => setOpAId(e.target.value)}
            className="w-full border border-zinc-300 rounded px-2 py-1 bg-white"
          >
            {allSeries.length === 0 && <option value="">(sin series)</option>}
            {allSeries.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
      )}

      {needsB && (
        <div>
          <label className="block text-xs text-zinc-600 mb-1">Serie B</label>
          <select
            value={b?.id ?? ""}
            onChange={(e) => setOpBId(e.target.value)}
            className="w-full border border-zinc-300 rounded px-2 py-1 bg-white"
          >
            {allSeries
              .filter((s) => s.id !== a?.id)
              .map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
          </select>
        </div>
      )}

      {opType === "weighted" && (
        <div className="space-y-2">
          <label className="block text-xs text-zinc-600">Activos y pesos (se normalizan a 100%)</label>
          <div className="border border-zinc-300 rounded bg-white max-h-56 overflow-y-auto divide-y divide-zinc-100">
            {allSeries.length === 0 && (
              <p className="text-xs text-zinc-500 px-2 py-2">Agregá series al universo primero.</p>
            )}
            {allSeries.map((s) => {
              const isMember = s.id in wWeights;
              const norm = isMember && wTotal > 0 ? (wWeights[s.id] / wTotal) * 100 : 0;
              return (
                <div key={s.id} className="flex items-center gap-2 px-2 py-1">
                  <input type="checkbox" checked={isMember} onChange={() => wToggle(s.id)} />
                  <span className="flex-1 text-xs break-words leading-tight">{s.name}</span>
                  {isMember && (
                    <div className="flex items-center gap-1 shrink-0">
                      <input
                        type="number"
                        step={1}
                        value={wWeights[s.id]}
                        onChange={(e) => wSet(s.id, Number(e.target.value))}
                        className="w-16 border border-zinc-300 rounded px-1.5 py-0.5 bg-white text-right tabular-nums text-xs"
                      />
                      <span className="text-[10px] text-zinc-400 w-9 text-right tabular-nums">{norm.toFixed(0)}%</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-between text-[11px] text-zinc-600">
            <span>
              {wMembers.length} activo{wMembers.length === 1 ? "" : "s"} · suma pesos{" "}
              <b className="tabular-nums">{wTotal.toFixed(0)}</b>
            </span>
            <button onClick={wEqual} className="underline hover:text-zinc-900">Pesos iguales</button>
          </div>
          {wPreview.length > 0 ? (
            <p className="text-[11px] text-zinc-500">
              Backtest: <b>{wPreview.length}</b> meses · {wPreview[0].date} → {wPreview[wPreview.length - 1].date}.
            </p>
          ) : wMembers.length >= 2 ? (
            <p className="text-[11px] text-amber-700">Sin meses en común entre los activos elegidos.</p>
          ) : null}
        </div>
      )}

      {opType === "scale" && (
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="block text-xs text-zinc-600 mb-1">Multiplicador (c)</label>
            <input
              type="number"
              step={0.1}
              value={opScalar}
              onChange={(e) => setOpScalar(Number(e.target.value))}
              className="w-full border border-zinc-300 rounded px-2 py-1 bg-white text-right tabular-nums"
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-zinc-600 mb-1">Offset (% mensual)</label>
            <input
              type="number"
              step={0.05}
              value={opOffsetPct}
              onChange={(e) => setOpOffsetPct(Number(e.target.value))}
              className="w-full border border-zinc-300 rounded px-2 py-1 bg-white text-right tabular-nums"
            />
          </div>
        </div>
      )}

      <div>
        <label className="block text-xs text-zinc-600 mb-1">Nombre nuevo</label>
        <input
          value={opName || (opType === "weighted" ? wAutoName : auto)}
          onChange={(e) => setOpName(e.target.value)}
          className="w-full border border-zinc-300 rounded px-2 py-1 bg-white"
          placeholder={(opType === "weighted" ? wAutoName : auto) || "Nombre"}
        />
      </div>

      <button
        disabled={
          opType === "weighted"
            ? wMembers.length < 2 || wPreview.length === 0
            : !a || (needsB && !b)
        }
        onClick={() => {
          if (opType === "weighted") {
            const returns = portfolioReturns(wMembers, "monthly");
            if (returns.length === 0) {
              onError("Sin meses en común entre los activos elegidos.");
              return;
            }
            onError(null);
            const name = (opName || wAutoName).trim() || "Combinación";
            onCreate({ id: `op::${name}::${Date.now()}`, name, source: "custom", returns, active: true });
            return;
          }
          if (!a) return;
          if (needsB && !b) return;
          const returns = operate({
            type: opType,
            a,
            b,
            weight: opWeight,
            scalar: opScalar,
            offset: opOffsetPct / 100,
          });
          if (returns.length === 0) {
            onError("Sin meses en común para esta operación.");
            return;
          }
          onError(null);
          const name = (opName || auto).trim() || "Custom op";
          onCreate({
            id: `op::${name}::${Date.now()}`,
            name,
            source: "custom",
            returns,
            active: true,
          });
        }}
        className="w-full bg-brand-700 text-white text-sm py-1.5 rounded disabled:opacity-40"
      >
        Crear serie derivada
      </button>

      <p className="text-[11px] text-zinc-500">
        Las operaciones se aplican mes por mes sobre el período en común. La serie nueva
        se guarda como cualquier otra y se sincroniza al server compartido.
      </p>
    </div>
  );
}

function PortfolioBuilder({
  allSeries,
  editing,
  onCreate,
  onUpdate,
  onCancelEdit,
  onError,
}: {
  allSeries: SeriesData[];
  editing: SeriesData | null;
  onCreate: (s: SeriesData) => void;
  onUpdate: (s: SeriesData) => void;
  onCancelEdit: () => void;
  onError: (msg: string | null) => void;
}) {
  // peso en % por id; estar en el objeto = ser miembro de la cartera.
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [rebalance, setRebalance] = useState<RebalanceFreq>("monthly");

  // Al entrar/salir de modo edición, cargar (o limpiar) la receta.
  const editingId = editing?.id ?? null;
  useEffect(() => {
    if (editing?.portfolio) {
      // cartera con receta: precargar componentes, pesos y rebalanceo
      const w: Record<string, number> = {};
      for (const m of editing.portfolio.members) w[m.id] = m.weight;
      setWeights(w);
      setName(editing.name);
      setRebalance(editing.portfolio.rebalance);
    } else if (editing) {
      // cartera vieja sin receta: reconstruir en su lugar (mantener el nombre)
      setWeights({});
      setName(editing.name);
      setRebalance("monthly");
    } else {
      setWeights({});
      setName("");
      setRebalance("monthly");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  const members = useMemo(
    () =>
      allSeries
        .filter((s) => s.id in weights)
        .map((s) => ({ series: s, weight: weights[s.id] || 0 })),
    [allSeries, weights],
  );
  const totalW = members.reduce((a, m) => a + m.weight, 0);

  const preview = useMemo(() => portfolioReturns(members, rebalance), [members, rebalance]);

  const filtered = useMemo(
    () =>
      search.trim()
        ? allSeries.filter((s) => s.name.toLowerCase().includes(search.trim().toLowerCase()))
        : allSeries,
    [allSeries, search],
  );

  function toggle(id: string) {
    setWeights((prev) => {
      const next = { ...prev };
      if (id in next) {
        delete next[id];
      } else {
        const n = Object.keys(next).length + 1;
        next[id] = Math.round((100 / n) * 100) / 100;
      }
      return next;
    });
  }

  function setWeight(id: string, val: number) {
    setWeights((prev) => ({ ...prev, [id]: val }));
  }

  function equalize() {
    setWeights((prev) => {
      const ids = Object.keys(prev);
      if (ids.length === 0) return prev;
      const w = Math.round((100 / ids.length) * 100) / 100;
      return Object.fromEntries(ids.map((id) => [id, w]));
    });
  }

  const autoName = `Cartera (${members.length} activo${members.length === 1 ? "" : "s"}${
    rebalance === "monthly" ? "" : ` · ${REBALANCE_LABEL[rebalance]}`
  })`;

  return (
    <div className="space-y-3 text-sm">
      {editing ? (
        <div className="text-[11px] bg-amber-50 border border-amber-300 rounded p-2 flex items-center justify-between gap-2">
          <span className="text-amber-800">
            {editing.portfolio ? (
              <>
                Editando <b>{editing.name}</b> — al guardar se actualiza esta misma cartera.
              </>
            ) : (
              <>
                Reconstruyendo <b>{editing.name}</b> (no tenía receta guardada): reseleccioná
                componentes y pesos. Se guarda en su mismo lugar.
              </>
            )}
          </span>
          <button
            onClick={onCancelEdit}
            className="shrink-0 text-amber-700 underline hover:text-amber-900"
          >
            Cancelar
          </button>
        </div>
      ) : (
        <p className="text-[11px] text-zinc-600 bg-zinc-50 border border-zinc-200 rounded p-2 leading-relaxed">
          Combiná varios activos con pesos fijos en una cartera con el rebalanceo que elijas
          (<span className="font-mono">r = Σ wᵢ·rᵢ</span>). Los pesos se normalizan a 100%
          automáticamente y el cálculo usa los meses en común a todos los miembros.
        </p>
      )}

      {allSeries.length === 0 ? (
        <p className="text-xs text-zinc-500">Agregá series al universo primero.</p>
      ) : (
        <>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 Filtrar activos…"
            className="w-full border border-zinc-300 rounded px-2 py-1 text-xs bg-white"
          />

          <div className="border border-zinc-300 rounded bg-white max-h-56 overflow-y-auto divide-y divide-zinc-100">
            {filtered.map((s) => {
              const isMember = s.id in weights;
              const norm = isMember && totalW > 0 ? (weights[s.id] / totalW) * 100 : 0;
              return (
                <div key={s.id} className="flex items-center gap-2 px-2 py-1">
                  <input
                    type="checkbox"
                    checked={isMember}
                    onChange={() => toggle(s.id)}
                  />
                  <span className="flex-1 text-xs break-words leading-tight">{s.name}</span>
                  {isMember && (
                    <div className="flex items-center gap-1 shrink-0">
                      <input
                        type="number"
                        step={1}
                        value={weights[s.id]}
                        onChange={(e) => setWeight(s.id, Number(e.target.value))}
                        className="w-16 border border-zinc-300 rounded px-1.5 py-0.5 bg-white text-right tabular-nums text-xs"
                      />
                      <span className="text-[10px] text-zinc-400 w-9 text-right tabular-nums">
                        {norm.toFixed(0)}%
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between text-[11px] text-zinc-600">
            <span>
              {members.length} activo{members.length === 1 ? "" : "s"} · suma pesos{" "}
              <b className="tabular-nums">{totalW.toFixed(0)}</b> (se normaliza a 100%)
            </span>
            <button onClick={equalize} className="underline hover:text-zinc-900">
              Pesos iguales
            </button>
          </div>

          {preview.length > 0 ? (
            <p className="text-[11px] text-zinc-500">
              Backtest: <b>{preview.length}</b> meses · {preview[0].date} →{" "}
              {preview[preview.length - 1].date}.
            </p>
          ) : members.length >= 2 ? (
            <p className="text-[11px] text-amber-700">
              Sin meses en común entre los activos elegidos.
            </p>
          ) : null}

          <div>
            <label className="block text-xs text-zinc-600 mb-1">Rebalanceo</label>
            <select
              value={rebalance}
              onChange={(e) => setRebalance(e.target.value as RebalanceFreq)}
              className="w-full border border-zinc-300 rounded px-2 py-1 bg-white"
            >
              <option value="monthly">Mensual — vuelve a los pesos cada mes</option>
              <option value="quarterly">Trimestral — Ene/Abr/Jul/Oct</option>
              <option value="annual">Anual — cada enero</option>
              <option value="hold">Buy &amp; Hold — sin rebalanceo (pesos driftean)</option>
            </select>
            <p className="text-[11px] text-zinc-500 mt-1">
              Cambia la trayectoria y el drawdown aunque los activos sean los mismos. Para
              comparar contra Morningstar, igualá acá su frecuencia de rebalanceo.
            </p>
          </div>

          <div>
            <label className="block text-xs text-zinc-600 mb-1">Nombre de la cartera</label>
            <input
              value={name || autoName}
              onChange={(e) => setName(e.target.value)}
              placeholder={autoName}
              className="w-full border border-zinc-300 rounded px-2 py-1 bg-white"
            />
          </div>

          <button
            disabled={members.length < 2 || preview.length === 0}
            onClick={() => {
              const returns = portfolioReturns(members, rebalance);
              if (returns.length === 0) {
                onError("Sin meses en común para armar la cartera.");
                return;
              }
              onError(null);
              const finalName = (name || autoName).trim() || "Cartera";
              const recipe = {
                members: members.map((m) => ({ id: m.series.id, weight: m.weight })),
                rebalance,
              };
              if (editing) {
                onUpdate({ ...editing, name: finalName, returns, portfolio: recipe });
              } else {
                onCreate({
                  id: `port::${finalName}::${Date.now()}`,
                  name: finalName,
                  source: "custom",
                  returns,
                  active: true,
                  portfolio: recipe,
                });
                setWeights({});
                setName("");
              }
            }}
            className="w-full bg-brand-700 text-white text-sm py-1.5 rounded disabled:opacity-40"
          >
            {editing ? "Guardar cambios" : "Crear cartera"}
          </button>
          <p className="text-[11px] text-zinc-500">
            Elegí al menos 2 activos.{" "}
            {editing
              ? "Se recalcula y actualiza la cartera existente (mantiene su lugar y si está en el análisis)."
              : "La cartera se guarda como una serie más y la podés usar en correlaciones, ratio, Base 100, etc."}
          </p>
        </>
      )}
    </div>
  );
}
