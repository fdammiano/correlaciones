"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import PlotlyChart from "./PlotlyChart";
import RelationMonitor from "./RelationMonitor";
import RelationRadar from "./RelationRadar";
import {
  alignSeries,
  commonStartDate,
  correlation,
  correlationMatrix,
  rollingCorrelation,
  trimLeadingNulls,
} from "@/lib/stats";
import { cumulativeWealth, DEFAULT_RF, summarize } from "@/lib/metrics";
import { multiRegress, type MultiRegression } from "@/lib/multiregression";
import type { SeriesData } from "@/lib/types";

type Mode = "rolling" | "matrix" | "regression" | "ratio";
type RollingSub = "one-vs-many" | "pair";

const WINDOWS = [12, 24, 30, 36, 60, 120];

// Medias móviles tipo SMA50/SMA200. La data es mensual, así que traducimos:
//   200 días de trading ≈ 10 meses · 50 días ≈ 2 meses (convención trend-following / Faber).
const MA_FAST_MONTHS = 2; // "50d"
const MA_SLOW_MONTHS = 10; // "200d"

// Paleta fija para las series de datos.
const PALETTE = [
  "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
  "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf",
];

// Colores neutros y fijos para las medias móviles, distintos del color de la
// serie: gris (50d) y casi-negro (200d). Así se leen como "referencia" y no se
// confunden con las líneas de datos.
const MA_FAST_COLOR = "#9ca3af"; // 50d ≈ 2 meses — gris
const MA_SLOW_COLOR = "#111827"; // 200d ≈ 10 meses — casi negro

// ── Colores de fondo tipo heatmap para el Monitor de correlaciones ──
// Tintes claros para que el número (texto oscuro) siga siendo legible.
function clampN(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
function mixRGB(
  from: [number, number, number],
  to: [number, number, number],
  t: number,
): string {
  const r = Math.round(from[0] + (to[0] - from[0]) * t);
  const g = Math.round(from[1] + (to[1] - from[1]) * t);
  const b = Math.round(from[2] + (to[2] - from[2]) * t);
  return `rgb(${r}, ${g}, ${b})`;
}
const HM_WHITE: [number, number, number] = [255, 255, 255];
const HM_GREEN: [number, number, number] = [34, 197, 94]; // green-500 — mucha correlación
const HM_RED: [number, number, number] = [239, 68, 68]; // red-500 — poca / negativa
// Correlación en [-1,1]: alta → verde, baja/negativa → rojo.
function corrBg(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "transparent";
  const t = clampN(v, -1, 1);
  return t >= 0 ? mixRGB(HM_WHITE, HM_GREEN, t * 0.55) : mixRGB(HM_WHITE, HM_RED, -t * 0.55);
}
// Δ centrado en 0; saturamos el color a ±0.5 para que se noten cambios chicos.
// Verde = la correlación subió (más correlacionado ahora); rojo = bajó.
function deltaBg(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "transparent";
  const t = clampN(v / 0.5, -1, 1);
  return t >= 0 ? mixRGB(HM_WHITE, HM_GREEN, t * 0.6) : mixRGB(HM_WHITE, HM_RED, -t * 0.6);
}

// Media móvil simple (trailing) sobre una serie de valores; null hasta tener `window` puntos.
function sma(values: (number | null)[], window: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  const buf: number[] = [];
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) {
      out.push(null);
      continue;
    }
    buf.push(v);
    sum += v;
    if (buf.length > window) sum -= buf.shift()!;
    out.push(buf.length === window ? sum / window : null);
  }
  return out;
}

export default function ChartPanel({
  series: inputSeries,
  library,
}: {
  series: SeriesData[];
  library?: SeriesData[];
}) {
  const monitorLibrary = library ?? inputSeries;
  const [mode, setMode] = useState<Mode>("rolling");
  const [from, setFrom] = useState(""); // "YYYY-MM" o ""
  const [to, setTo] = useState(""); // "YYYY-MM" o ""
  const [rollingSub, setRollingSub] = useState<RollingSub>("one-vs-many");
  const [window, setWindow] = useState(60);
  const [benchmark, setBenchmark] = useState<string>("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [pairA, setPairA] = useState<string>("");
  const [pairB, setPairB] = useState<string>("");
  const [matrixLastN, setMatrixLastN] = useState<number | "all">(60);
  const [showCorrMA, setShowCorrMA] = useState(false);
  const [ratioNum, setRatioNum] = useState<string>("");
  const [ratioDen, setRatioDen] = useState<string>("");

  // Límites de fechas disponibles (para inputs y presets).
  const bounds = useMemo(() => {
    let min: string | null = null;
    let max: string | null = null;
    for (const s of inputSeries)
      for (const r of s.returns) {
        const ym = r.date.slice(0, 7);
        if (min === null || ym < min) min = ym;
        if (max === null || ym > max) max = ym;
      }
    return { min, max };
  }, [inputSeries]);

  // Recorte global de período: todas las series se filtran a [from, to] (por mes).
  // Todo lo de abajo usa `series` ya recortada, así que Base 100, drawdown,
  // correlaciones y métricas quedan en línea con la ventana elegida.
  const series = useMemo(() => {
    if (!from && !to) return inputSeries;
    return inputSeries.map((s) => ({
      ...s,
      returns: s.returns.filter((r) => {
        const ym = r.date.slice(0, 7);
        if (from && ym < from) return false;
        if (to && ym > to) return false;
        return true;
      }),
    }));
  }, [inputSeries, from, to]);

  const aligned = useMemo(() => alignSeries(series), [series]);
  const seriesById = useMemo(() => new Map(series.map((s) => [s.id, s])), [series]);

  const effectiveBenchmark = benchmark && seriesById.has(benchmark) ? benchmark : series[0]?.id ?? "";
  const effectivePairA = pairA && seriesById.has(pairA) ? pairA : series[0]?.id ?? "";
  const effectivePairB =
    pairB && seriesById.has(pairB) && pairB !== effectivePairA
      ? pairB
      : series.find((s) => s.id !== effectivePairA)?.id ?? "";

  const effRatioNum = ratioNum && seriesById.has(ratioNum) ? ratioNum : series[0]?.id ?? "";
  const effRatioDen =
    ratioDen && seriesById.has(ratioDen) && ratioDen !== effRatioNum
      ? ratioDen
      : series.find((s) => s.id !== effRatioNum)?.id ?? "";

  // Abre el modo Ratio con un par puntual (numerador, denominador).
  function showRatioFor(numId: string, denId: string) {
    setRatioNum(numId);
    setRatioDen(denId);
    setMode("ratio");
  }

  // Presets de período. Horizontes relativos al último dato disponible; crisis fijas.
  const yearsBack = (n: number) =>
    bounds.max ? `${Number(bounds.max.slice(0, 4)) - n}${bounds.max.slice(4)}` : "";
  const horizonPresets = [
    { label: "Todo", f: "", t: "" },
    { label: "50a", f: yearsBack(50), t: "" },
    { label: "30a", f: yearsBack(30), t: "" },
    { label: "10a", f: yearsBack(10), t: "" },
    { label: "5a", f: yearsBack(5), t: "" },
    { label: "3a", f: yearsBack(3), t: "" },
    { label: "1a", f: yearsBack(1), t: "" },
  ];
  const crisisPresets = [
    { label: "Gran Depresión 1929", f: "1929-09", t: "1932-06" },
    { label: "Recesión 1937", f: "1937-03", t: "1938-04" },
    { label: "Petróleo 1973", f: "1973-01", t: "1974-12" },
    { label: "Lunes Negro 1987", f: "1987-09", t: "1987-11" },
    { label: "LTCM 1998", f: "1998-07", t: "1998-09" },
    { label: "Dot-com 2000", f: "2000-03", t: "2002-10" },
    { label: "GFC 2008", f: "2007-10", t: "2009-06" },
    { label: "Euro 2011", f: "2011-05", t: "2011-12" },
    { label: "COVID 2020", f: "2020-01", t: "2020-12" },
    { label: "2022", f: "2022-01", t: "2022-12" },
  ];
  const presetBtn = (p: { label: string; f: string; t: string }) => (
    <button
      key={p.label}
      onClick={() => {
        setFrom(p.f);
        setTo(p.t);
      }}
      className={`px-1.5 py-0.5 rounded border ${
        from === p.f && to === p.t
          ? "bg-brand-700 text-white border-brand-700"
          : "border-zinc-200 text-zinc-600 hover:bg-zinc-100"
      }`}
    >
      {p.label}
    </button>
  );

  return (
    <section className="flex-1 p-6 overflow-y-auto h-screen bg-white">
      <div className="mb-5 border-b border-zinc-200 pb-4">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[11px] font-semibold text-brand-600 uppercase tracking-widest mb-1">
            Paso 2 · Análisis
          </p>
          <a
            href="/screener"
            className="shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold text-brand-700 border border-brand-200 bg-brand-50 hover:bg-brand-100 rounded px-2.5 py-1 transition-colors"
            title="Explorá qué factores/sectores están arriba o abajo de su promedio"
          >
            🔎 Screener de leads
          </a>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-brand-800">
          Rolling Correlations
        </h1>
        <div className="mt-1.5 h-0.5 w-10 rounded-full bg-gold-500" />
        <p className="text-xs text-zinc-500 mt-2">
          Correlaciones, matriz, regresión y ratio de los activos que elijas a la izquierda.
        </p>
      </div>

      {monitorLibrary.length >= 2 && (
        <CorrelationMonitor activeSeries={inputSeries} library={monitorLibrary} />
      )}

      {monitorLibrary.length >= 2 && (
        <RelationRadar activeSeries={inputSeries} library={monitorLibrary} />
      )}

      {monitorLibrary.length >= 2 && (
        <RelationMonitor activeSeries={inputSeries} library={monitorLibrary} />
      )}

      {series.length === 0 && (
        <div className="mb-6 rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-4 py-8 text-center text-sm text-zinc-500">
          <p className="font-medium text-zinc-700 mb-1">Todavía no elegiste activos</p>
          <p>← Agregalos desde el panel de la izquierda (Paso 1) para ver acá sus correlaciones.</p>
        </div>
      )}

      <div className="flex flex-wrap gap-3 items-end mb-5 text-sm">
        <div>
          <label className="block text-xs text-zinc-600 mb-1">Modo</label>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as Mode)}
            className="border border-zinc-300 rounded px-2 py-1 bg-white"
          >
            <option value="rolling">Rolling correlation</option>
            <option value="matrix">Matriz</option>
            <option value="regression">Regresión</option>
            <option value="ratio">Ratio (precios)</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-zinc-600 mb-1">Período</label>
          <div className="flex items-center gap-1">
            <input
              type="month"
              value={from}
              min={bounds.min ?? undefined}
              max={to || bounds.max || undefined}
              onChange={(e) => setFrom(e.target.value)}
              className="border border-zinc-300 rounded px-2 py-1 bg-white text-xs"
            />
            <span className="text-zinc-400 text-xs">→</span>
            <input
              type="month"
              value={to}
              min={from || bounds.min || undefined}
              max={bounds.max ?? undefined}
              onChange={(e) => setTo(e.target.value)}
              className="border border-zinc-300 rounded px-2 py-1 bg-white text-xs"
            />
          </div>
          <div className="mt-1 space-y-1 text-[10px]">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-zinc-400 w-14 shrink-0">Horizonte</span>
              {horizonPresets.map(presetBtn)}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-zinc-400 w-14 shrink-0">Crisis</span>
              {crisisPresets.map(presetBtn)}
            </div>
          </div>
        </div>
        {mode === "rolling" && (
          <>
            <div>
              <label className="block text-xs text-zinc-600 mb-1">Vista</label>
              <select
                value={rollingSub}
                onChange={(e) => setRollingSub(e.target.value as RollingSub)}
                className="border border-zinc-300 rounded px-2 py-1 bg-white"
              >
                <option value="one-vs-many">Uno vs varios</option>
                <option value="pair">Par individual</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-600 mb-1">Ventana (meses)</label>
              <select
                value={window}
                onChange={(e) => setWindow(Number(e.target.value))}
                className="border border-zinc-300 rounded px-2 py-1 bg-white"
              >
                {WINDOWS.map((w) => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-1 text-[11px] text-zinc-600 cursor-pointer select-none pb-1">
              <input
                type="checkbox"
                checked={showCorrMA}
                onChange={(e) => setShowCorrMA(e.target.checked)}
              />
              Medias 50d/200d
            </label>
          </>
        )}
        {mode === "matrix" && (
          <div>
            <label className="block text-xs text-zinc-600 mb-1">Período</label>
            <select
              value={String(matrixLastN)}
              onChange={(e) =>
                setMatrixLastN(e.target.value === "all" ? "all" : Number(e.target.value))
              }
              className="border border-zinc-300 rounded px-2 py-1 bg-white"
            >
              <option value="12">Últimos 12 m</option>
              <option value="24">Últimos 24 m</option>
              <option value="60">Últimos 60 m</option>
              <option value="120">Últimos 120 m</option>
              <option value="all">Todo</option>
            </select>
          </div>
        )}
      </div>

      {series.length < 2 ? (
        <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Agregá al menos 2 series para calcular correlaciones.
        </div>
      ) : mode === "rolling" && rollingSub === "one-vs-many" ? (
        <OneVsMany
          series={series}
          window={window}
          aligned={aligned}
          benchmark={effectiveBenchmark}
          setBenchmark={setBenchmark}
          excluded={excluded}
          setExcluded={setExcluded}
          showMA={showCorrMA}
        />
      ) : mode === "rolling" && rollingSub === "pair" ? (
        <PairRolling
          series={series}
          window={window}
          aligned={aligned}
          a={effectivePairA}
          b={effectivePairB}
          setA={setPairA}
          setB={setPairB}
          showMA={showCorrMA}
          onShowRatio={showRatioFor}
        />
      ) : mode === "regression" ? (
        <RegressionMode series={series} aligned={aligned} />
      ) : mode === "ratio" ? (
        <RatioView
          series={series}
          num={effRatioNum}
          den={effRatioDen}
          setNum={setRatioNum}
          setDen={setRatioDen}
        />
      ) : (
        <MatrixView series={series} lastN={matrixLastN} />
      )}

      {series.length > 0 && (
        <>
          <div className="mt-8">
            <h2 className="text-sm font-semibold mb-2">Series individuales</h2>
            <WealthChart series={series} />
          </div>

          <div className="mt-8">
            <h2 className="text-sm font-semibold mb-2">Métricas resumen</h2>
            <MetricsTable series={series} />
          </div>
        </>
      )}

      <div className="mt-6">
        <details className="text-xs">
          <summary className="cursor-pointer text-zinc-500">Ver tabla de retornos crudos</summary>
          <ReturnsTable series={series} aligned={aligned} />
        </details>
      </div>

      {series.length > 0 && (
        <div className="mt-4">
          <details className="text-xs">
            <summary className="cursor-pointer text-zinc-500">Ver gráfico de drawdown (underwater)</summary>
            <DrawdownPanel series={series} />
          </details>
        </div>
      )}
    </section>
  );
}

function WealthChart({ series }: { series: SeriesData[] }) {
  const [view, setView] = useState<"wealth" | "monthly">("wealth");
  const [showMA, setShowMA] = useState(false);
  const [logScale, setLogScale] = useState(false);
  const common = useMemo(() => commonStartDate(series), [series]);

  // Base 100 por serie (con color fijo), para reusar en la línea y en sus medias.
  const wealthBySeries = useMemo(
    () =>
      series.map((s, i) => {
        const trimmed = common ? s.returns.filter((r) => r.date >= common) : s.returns;
        const w = cumulativeWealth(trimmed, 100);
        return {
          name: s.name,
          color: PALETTE[i % PALETTE.length],
          dates: w.map((p) => p.date),
          vals: w.map((p) => p.value),
        };
      }),
    [series, common],
  );

  const wealthTraces = useMemo(() => {
    const out: any[] = [];
    for (const { name, color, dates, vals } of wealthBySeries) {
      out.push({
        type: "scatter" as const,
        mode: "lines" as const,
        name,
        legendgroup: name,
        x: dates,
        y: vals,
        line: { color },
        hovertemplate: "%{x|%Y-%m} · %{y:.1f}<extra>%{fullData.name}</extra>",
      });
      if (showMA) {
        const fast = sma(vals, MA_FAST_MONTHS);
        const slow = sma(vals, MA_SLOW_MONTHS);
        out.push({
          type: "scatter" as const,
          mode: "lines" as const,
          name: `${name} · 50d`,
          legendgroup: name,
          showlegend: false,
          x: dates,
          y: fast,
          line: { color: MA_FAST_COLOR, width: 1, dash: "dot" },
          hovertemplate: `%{x|%Y-%m} · 50d %{y:.1f}<extra>${name}</extra>`,
        });
        out.push({
          type: "scatter" as const,
          mode: "lines" as const,
          name: `${name} · 200d`,
          legendgroup: name,
          showlegend: false,
          x: dates,
          y: slow,
          line: { color: MA_SLOW_COLOR, width: 1.6, dash: "dash" },
          hovertemplate: `%{x|%Y-%m} · 200d %{y:.1f}<extra>${name}</extra>`,
        });
      }
    }
    return out;
  }, [wealthBySeries, showMA]);

  const monthlyTraces = useMemo(
    () =>
      series.map((s) => {
        const sorted = [...s.returns]
          .filter((r) => Number.isFinite(r.value))
          .sort((a, b) => a.date.localeCompare(b.date));
        return {
          type: "scatter" as const,
          mode: "lines" as const,
          name: s.name,
          x: sorted.map((r) => r.date),
          y: sorted.map((r) => r.value),
          hovertemplate: "%{x|%Y-%m} · %{y:.2%}<extra>%{fullData.name}</extra>",
        };
      }),
    [series],
  );

  return (
    <>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[11px] text-zinc-500">
          {view === "wealth"
            ? common
              ? (
                <>
                  Rebaseo en común desde <b>{common}</b> (primer mes donde todas las series activas tienen dato).
                </>
              )
              : "Sin series activas."
            : "Retorno de cada mes sin acumular — cada serie en su historia completa."}
        </p>
        <div className="flex items-center gap-3">
          {view === "wealth" && (
            <label className="flex items-center gap-1 text-[11px] text-zinc-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showMA}
                onChange={(e) => setShowMA(e.target.checked)}
              />
              Medias 50d/200d
            </label>
          )}
          {view === "wealth" && (
            <div className="inline-flex rounded border border-zinc-300 overflow-hidden text-[11px]">
              <button
                className={`px-2 py-0.5 ${!logScale ? "bg-brand-700 text-white" : "bg-white text-zinc-700"}`}
                onClick={() => setLogScale(false)}
                title="Escala lineal: la altura refleja el valor en $ (100 → 130 = +30%)."
              >
                Lineal
              </button>
              <button
                className={`px-2 py-0.5 ${logScale ? "bg-brand-700 text-white" : "bg-white text-zinc-700"}`}
                onClick={() => setLogScale(true)}
                title="Escala log: la altura refleja % de cambio; útil para comparar horizontes largos."
              >
                Log
              </button>
            </div>
          )}
          <div className="inline-flex rounded border border-zinc-300 overflow-hidden text-[11px]">
            <button
              className={`px-2 py-0.5 ${view === "wealth" ? "bg-brand-700 text-white" : "bg-white text-zinc-700"}`}
              onClick={() => setView("wealth")}
            >
              Base 100
            </button>
            <button
              className={`px-2 py-0.5 ${view === "monthly" ? "bg-brand-700 text-white" : "bg-white text-zinc-700"}`}
              onClick={() => setView("monthly")}
            >
              Retornos
            </button>
          </div>
        </div>
      </div>
      {view === "wealth" && showMA && (
        <p className="text-[10px] text-zinc-400 mb-1">
          Medias móviles sobre el Base 100 · data mensual: <b>50d ≈ 2 meses</b> (punteada) y{" "}
          <b>200d ≈ 10 meses</b> (rayada). 50d en gris, 200d en negro (iguales para todas las series).
        </p>
      )}
      {view === "wealth" ? (
        <PlotlyChart
          data={wealthTraces}
          layout={{
            yaxis: { title: "Base 100", type: logScale ? "log" : "linear" },
            xaxis: { title: "Fecha" },
            hovermode: "x unified",
            legend: { orientation: "h", y: -0.2 },
          }}
          height={420}
        />
      ) : (
        <PlotlyChart
          data={monthlyTraces}
          layout={{
            yaxis: { title: "Retorno mensual", tickformat: ".1%", zeroline: true },
            xaxis: { title: "Fecha" },
            hovermode: "x unified",
            legend: { orientation: "h", y: -0.2 },
          }}
          height={420}
        />
      )}
    </>
  );
}

function MetricsTable({ series }: { series: SeriesData[] }) {
  const [rfPct, setRfPct] = useState<number>(DEFAULT_RF * 100); // % anual
  const rf = rfPct / 100;
  const rows = useMemo(
    () => series.map((s) => ({ id: s.id, name: s.name, m: summarize(s.returns, rf) })),
    [series, rf],
  );
  const fmtPct = (v: number | null, d = 2) =>
    v == null ? "—" : `${(v * 100).toFixed(d)}%`;
  const fmtNum = (v: number | null, d = 2) => (v == null ? "—" : v.toFixed(d));

  return (
    <>
      <div className="flex flex-wrap items-end gap-3 mb-2 text-[11px] text-zinc-600">
        <p className="flex-1">
          Cálculo sobre toda la historia de cada serie. Retornos y vol anualizados desde mensuales.
        </p>
        <label className="flex items-center gap-2">
          <span>Risk-free anual (Sharpe):</span>
          <input
            type="number"
            value={rfPct}
            step={0.25}
            onChange={(e) => setRfPct(Number(e.target.value))}
            className="w-16 border border-zinc-300 rounded px-2 py-0.5 bg-white text-right tabular-nums"
          />
          <span>%</span>
        </label>
      </div>
      <div className="overflow-x-auto border rounded">
        <table className="w-full text-xs tabular-nums">
          <thead className="bg-brand-50">
            <tr>
              <th className="px-3 py-1.5 text-left">Serie</th>
              <th className="px-2 py-1.5 text-right">Inicio</th>
              <th className="px-2 py-1.5 text-right">Fin</th>
              <th className="px-2 py-1.5 text-right">N</th>
              <th className="px-2 py-1.5 text-right">Ret. anual</th>
              <th className="px-2 py-1.5 text-right">Vol anual</th>
              <th className="px-2 py-1.5 text-right" title={`Sharpe = (Ret. anual − ${rfPct}%) / Vol anual`}>
                Sharpe
              </th>
              <th className="px-2 py-1.5 text-right">Max DD</th>
              <th className="px-2 py-1.5 text-right">% meses con retorno positivo</th>
              <th className="px-2 py-1.5 text-right">Peor mes</th>
              <th className="px-2 py-1.5 text-right">Mejor mes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ id, name, m }) => (
              <tr key={id} className="border-t">
                <td className="px-3 py-1 text-left">{name}</td>
                <td className="px-2 py-1 text-right">{m.start ?? "—"}</td>
                <td className="px-2 py-1 text-right">{m.end ?? "—"}</td>
                <td className="px-2 py-1 text-right">{m.n}</td>
                <td className="px-2 py-1 text-right">{fmtPct(m.annualReturn)}</td>
                <td className="px-2 py-1 text-right">{fmtPct(m.annualVol)}</td>
                <td className="px-2 py-1 text-right">{fmtNum(m.sharpe)}</td>
                <td className="px-2 py-1 text-right text-red-700">
                  {fmtPct(m.maxDrawdown)}
                  {m.maxDrawdownDate && (
                    <div className="text-[9px] font-normal text-zinc-400">
                      {m.maxDrawdownDate.slice(0, 7)}
                    </div>
                  )}
                </td>
                <td className="px-2 py-1 text-right">{fmtPct(m.positivePct, 1)}</td>
                <td className="px-2 py-1 text-right text-red-700">{fmtPct(m.minMonthly)}</td>
                <td className="px-2 py-1 text-right text-emerald-700">{fmtPct(m.maxMonthly)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function OneVsMany({
  series,
  window,
  aligned,
  benchmark,
  setBenchmark,
  excluded,
  setExcluded,
  showMA,
}: {
  series: SeriesData[];
  window: number;
  aligned: ReturnType<typeof alignSeries>;
  benchmark: string;
  setBenchmark: (v: string) => void;
  excluded: Set<string>;
  setExcluded: (s: Set<string>) => void;
  showMA: boolean;
}) {
  const others = series.filter((s) => s.id !== benchmark && !excluded.has(s.id));
  const bArr = aligned.byId[benchmark] ?? [];
  // Si el período elegido es más corto que la ventana, la rolling no puede
  // calcularse (necesita `window` meses). En ese caso mostramos la correlación
  // ESTÁTICA del período como línea plana, así siempre hay un dato del período.
  const canRoll = aligned.dates.length >= window;
  const traces = others.flatMap((s, i) => {
    const color = PALETTE[i % PALETTE.length];
    const oArr = aligned.byId[s.id] ?? [];
    if (!canRoll) {
      const stat = correlation(bArr, oArr);
      if (stat == null || aligned.dates.length < 2) return [];
      return [
        {
          type: "scatter" as const,
          mode: "lines" as const,
          name: s.name,
          legendgroup: s.name,
          x: [aligned.dates[0], aligned.dates[aligned.dates.length - 1]],
          y: [stat, stat],
          line: { color, dash: "dash" },
          hovertemplate: `ρ período %{y:.3f}<extra>%{fullData.name}</extra>`,
        },
      ];
    }
    const rc = rollingCorrelation(bArr, oArr, window);
    const trimmed = trimLeadingNulls(aligned.dates, rc);
    const out: any[] = [
      {
        type: "scatter" as const,
        mode: "lines" as const,
        name: s.name,
        legendgroup: s.name,
        x: trimmed.x,
        y: trimmed.y,
        line: { color },
        hovertemplate: "%{x|%Y-%m} · %{y:.3f}<extra>%{fullData.name}</extra>",
      },
    ];
    if (showMA) {
      out.push(
        {
          type: "scatter" as const,
          mode: "lines" as const,
          name: `${s.name} · 50d`,
          legendgroup: s.name,
          showlegend: false,
          x: trimmed.x,
          y: sma(trimmed.y, MA_FAST_MONTHS),
          line: { color: MA_FAST_COLOR, width: 1, dash: "dot" },
          hovertemplate: `%{x|%Y-%m} · 50d %{y:.3f}<extra>${s.name}</extra>`,
        },
        {
          type: "scatter" as const,
          mode: "lines" as const,
          name: `${s.name} · 200d`,
          legendgroup: s.name,
          showlegend: false,
          x: trimmed.x,
          y: sma(trimmed.y, MA_SLOW_MONTHS),
          line: { color: MA_SLOW_COLOR, width: 1.6, dash: "dash" },
          hovertemplate: `%{x|%Y-%m} · 200d %{y:.3f}<extra>${s.name}</extra>`,
        },
      );
    }
    return out;
  });

  const lastTable = others.map((s) => {
    const o = aligned.byId[s.id] ?? [];
    const slice = (arr: (number | null)[]) => arr.slice(-window);
    const cLast = correlation(slice(bArr), slice(o));
    const cFull = correlation(bArr, o);
    return { name: s.name, id: s.id, last: cLast, full: cFull };
  });
  lastTable.sort((a, b) => (b.full ?? -2) - (a.full ?? -2));

  const benchmarkSeries = series.find((s) => s.id === benchmark);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <div>
          <label className="block text-xs text-zinc-600 mb-1">Benchmark</label>
          <select
            value={benchmark}
            onChange={(e) => setBenchmark(e.target.value)}
            className="border border-zinc-300 rounded px-2 py-1 bg-white min-w-[260px]"
          >
            {series.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
        <div className="text-xs text-zinc-500">
          {others.length} series vs <b>{benchmarkSeries?.name ?? "—"}</b>
        </div>
      </div>
      {!canRoll && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          El período tiene {aligned.dates.length} meses, menos que la ventana de {window}m: se
          muestra la <b>correlación estática del período</b> (línea punteada, un valor por serie).
          Bajá la ventana para ver una rolling.
        </p>
      )}
      <PlotlyChart
        data={traces}
        layout={{
          title: canRoll
            ? `Rolling correlation ${window}m`
            : `Correlación del período (${aligned.dates.length}m)`,
          yaxis: { range: [-1, 1], title: "ρ" },
          xaxis: { title: "Fecha" },
          hovermode: "x unified",
          legend: { orientation: "h", y: -0.2 },
        }}
      />
      {showMA && canRoll && (
        <p className="text-[10px] text-zinc-400 -mt-2">
          Medias móviles de la correlación · data mensual: <b>50d ≈ 2 meses</b> (punteada) y{" "}
          <b>200d ≈ 10 meses</b> (rayada). 50d en gris, 200d en negro (iguales para todas las series).
        </p>
      )}
      <div className="border rounded text-xs">
        <table className="w-full">
          <thead className="bg-brand-50">
            <tr>
              <th className="text-left px-3 py-1.5">Serie</th>
              <th className="text-right px-3 py-1.5">ρ histórico (todo)</th>
              <th className="text-right px-3 py-1.5">ρ últimos {window}m</th>
              <th className="w-12"></th>
            </tr>
          </thead>
          <tbody>
            {lastTable.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-3 py-1">{r.name}</td>
                <td className="px-3 py-1 text-right tabular-nums">
                  {r.full == null ? "—" : r.full.toFixed(3)}
                </td>
                <td className="px-3 py-1 text-right tabular-nums">
                  {r.last == null ? "—" : r.last.toFixed(3)}
                </td>
                <td className="px-3 py-1 text-right">
                  <button
                    className="text-zinc-400 hover:text-red-600"
                    onClick={() => {
                      const next = new Set(excluded);
                      next.add(r.id);
                      setExcluded(next);
                    }}
                    title="Ocultar"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {excluded.size > 0 && (
          <button
            onClick={() => setExcluded(new Set())}
            className="text-xs text-zinc-500 px-3 py-1.5 hover:text-zinc-900"
          >
            Restaurar series ocultas ({excluded.size})
          </button>
        )}
      </div>
    </div>
  );
}

function PairAB({
  series,
  a,
  b,
  setA,
  setB,
}: {
  series: SeriesData[];
  a: string;
  b: string;
  setA: (v: string) => void;
  setB: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-3 text-sm items-end">
      <div>
        <label className="block text-xs text-zinc-600 mb-1">Serie A</label>
        <select value={a} onChange={(e) => setA(e.target.value)} className="border border-zinc-300 rounded px-2 py-1 bg-white min-w-[260px]">
          {series.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs text-zinc-600 mb-1">Serie B</label>
        <select value={b} onChange={(e) => setB(e.target.value)} className="border border-zinc-300 rounded px-2 py-1 bg-white min-w-[260px]">
          {series.filter((s) => s.id !== a).map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

function PairRolling({
  series,
  window,
  aligned,
  a,
  b,
  setA,
  setB,
  showMA,
  onShowRatio,
}: {
  series: SeriesData[];
  window: number;
  aligned: ReturnType<typeof alignSeries>;
  a: string;
  b: string;
  setA: (v: string) => void;
  setB: (v: string) => void;
  showMA: boolean;
  onShowRatio: (numId: string, denId: string) => void;
}) {
  const arrA = aligned.byId[a] ?? [];
  const arrB = aligned.byId[b] ?? [];
  const nameA = series.find((s) => s.id === a)?.name ?? "A";
  const nameB = series.find((s) => s.id === b)?.name ?? "B";

  return (
    <div className="space-y-4">
      <PairAB series={series} a={a} b={b} setA={setA} setB={setB} />
      <button
        onClick={() => onShowRatio(a, b)}
        title={`Numerador: ${nameA} · Denominador: ${nameB}`}
        className="inline-flex items-center gap-1.5 rounded border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-800 hover:bg-brand-100"
      >
        Ver ratio de precios:&nbsp;<b>{nameA}</b>&nbsp;÷&nbsp;<b>{nameB}</b>&nbsp;→
      </button>
      <PearsonRolling
        dates={aligned.dates}
        arrA={arrA}
        arrB={arrB}
        window={window}
        nameA={nameA}
        nameB={nameB}
        showMA={showMA}
      />
    </div>
  );
}

function RegressionMode({
  series,
  aligned,
}: {
  series: SeriesData[];
  aligned: ReturnType<typeof alignSeries>;
}) {
  const [yId, setYId] = useState<string>("");
  const [xIds, setXIds] = useState<Set<string>>(new Set());

  // Sensible defaults: first series as Y, second as the only X.
  const effectiveY = yId && series.some((s) => s.id === yId) ? yId : series[0]?.id ?? "";
  const effectiveX = useMemo(() => {
    const filtered = new Set<string>();
    for (const id of xIds) {
      if (id !== effectiveY && series.some((s) => s.id === id)) filtered.add(id);
    }
    if (filtered.size === 0) {
      const fallback = series.find((s) => s.id !== effectiveY);
      if (fallback) filtered.add(fallback.id);
    }
    return filtered;
  }, [xIds, effectiveY, series]);

  const yName = series.find((s) => s.id === effectiveY)?.name ?? "Y";
  const yArr = aligned.byId[effectiveY] ?? [];

  const xCols = useMemo(
    () =>
      Array.from(effectiveX).map((id) => ({
        id,
        name: series.find((s) => s.id === id)?.name ?? id,
        values: aligned.byId[id] ?? [],
      })),
    [effectiveX, series, aligned],
  );

  const reg = useMemo(
    () => multiRegress(yArr, xCols.map((c) => ({ name: c.name, values: c.values }))),
    [yArr, xCols],
  );

  function toggleX(id: string) {
    setXIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4 items-start text-sm">
        <div>
          <label className="block text-xs text-zinc-600 mb-1">Dependiente (Y)</label>
          <select
            value={effectiveY}
            onChange={(e) => setYId(e.target.value)}
            className="border border-zinc-300 rounded px-2 py-1 bg-white min-w-[260px]"
          >
            {series.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
        <div className="flex-1 min-w-[280px]">
          <label className="block text-xs text-zinc-600 mb-1">
            Independientes (X) — {effectiveX.size} seleccionada{effectiveX.size === 1 ? "" : "s"}
          </label>
          <div className="border border-zinc-300 rounded bg-white max-h-44 overflow-y-auto">
            {series
              .filter((s) => s.id !== effectiveY)
              .map((s) => {
                const checked = effectiveX.has(s.id);
                return (
                  <label
                    key={s.id}
                    className="flex items-start gap-2 px-2 py-1 text-xs hover:bg-zinc-50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleX(s.id)}
                      className="mt-0.5"
                    />
                    <span className="break-words">{s.name}</span>
                  </label>
                );
              })}
          </div>
        </div>
      </div>

      <RegressionResults reg={reg} yName={yName} xCols={xCols} />
    </div>
  );
}

function RegressionResults({
  reg,
  yName,
  xCols,
}: {
  reg: MultiRegression | null;
  yName: string;
  xCols: { id: string; name: string; values: (number | null)[] }[];
}) {
  if (!reg) {
    return (
      <div className="border rounded bg-amber-50 border-amber-200 p-4 text-sm text-amber-900">
        No hay suficientes observaciones superpuestas para regresar (necesitás al menos k+2 meses
        en común entre Y y todas las X seleccionadas).
      </div>
    );
  }

  const fmtP = (p: number) =>
    !Number.isFinite(p) ? "—" : p < 1e-4 ? "<0.0001" : p.toFixed(4);
  const sigBadge = (p: number) =>
    p < 0.001
      ? { label: "***", cls: "bg-emerald-100 text-emerald-800" }
      : p < 0.01
      ? { label: "**", cls: "bg-emerald-100 text-emerald-800" }
      : p < 0.05
      ? { label: "*", cls: "bg-emerald-100 text-emerald-800" }
      : { label: "n.s.", cls: "bg-brand-50 text-zinc-600" };

  const isInterceptLike = (i: number) => i === 0;

  // Scatter visual:
  //  k=1 → classic Y vs X with OLS line
  //  k>1 → actual vs fitted (45° line)
  let plotData: any[];
  let plotLayout: any;
  if (reg.k === 1) {
    // For the X axis in the k=1 case we recover the regressor values in
    // the same filtered order as fitted/residuals by inverting the fit:
    //   x_i = (fitted_i − α) / β
    // multiRegress already pairwise-dropped any missing rows.
    const ys = reg.yObserved.slice();
    const xs: number[] = [];
    const a = reg.coefficients[0].value;
    const b = reg.coefficients[1].value;
    for (let i = 0; i < reg.fitted.length; i++) {
      xs.push((reg.fitted[i] - a) / (b || 1));
    }
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    plotData = [
      {
        type: "scatter",
        mode: "markers",
        name: "Observaciones",
        x: xs,
        y: ys,
        marker: { size: 5, opacity: 0.55 },
        hovertemplate: `${xCols[0].name}: %{x:.2%} · ${yName}: %{y:.2%}<extra></extra>`,
      },
      {
        type: "scatter",
        mode: "lines",
        name: "OLS fit",
        x: [xMin, xMax],
        y: [a + b * xMin, a + b * xMax],
        line: { color: "#dc2626", width: 2 },
        hoverinfo: "skip",
      },
    ];
    plotLayout = {
      title: `OLS: ${yName} = α + β · ${xCols[0].name}`,
      xaxis: { title: xCols[0].name, tickformat: ".0%" },
      yaxis: { title: yName, tickformat: ".0%" },
      legend: { orientation: "h", y: -0.2 },
    };
  } else {
    const mn = Math.min(...reg.yObserved, ...reg.fitted);
    const mx = Math.max(...reg.yObserved, ...reg.fitted);
    plotData = [
      {
        type: "scatter",
        mode: "markers",
        name: "Observaciones",
        x: reg.fitted,
        y: reg.yObserved,
        marker: { size: 5, opacity: 0.55 },
        hovertemplate: `fitted: %{x:.2%} · ${yName}: %{y:.2%}<extra></extra>`,
      },
      {
        type: "scatter",
        mode: "lines",
        name: "45° (perfecto)",
        x: [mn, mx],
        y: [mn, mx],
        line: { color: "#dc2626", width: 2, dash: "dot" },
        hoverinfo: "skip",
      },
    ];
    plotLayout = {
      title: `Actual vs Fitted — ${yName} = α + Σ βᵢ · Xᵢ (k=${reg.k})`,
      xaxis: { title: `Fitted ${yName}`, tickformat: ".0%" },
      yaxis: { title: `Observed ${yName}`, tickformat: ".0%" },
      legend: { orientation: "h", y: -0.2 },
    };
  }

  return (
    <>
      <PlotlyChart data={plotData} layout={plotLayout} height={500} />

      <div className="overflow-x-auto border rounded">
        <table className="w-full text-xs tabular-nums">
          <thead className="bg-brand-50">
            <tr>
              <th className="px-3 py-1.5 text-left">Coeficiente</th>
              <th className="px-2 py-1.5 text-right">Valor</th>
              <th className="px-2 py-1.5 text-right">Error std</th>
              <th className="px-2 py-1.5 text-right">t</th>
              <th className="px-2 py-1.5 text-right">p-value</th>
              <th className="px-2 py-1.5 text-center">Sig. (α=0.05)</th>
            </tr>
          </thead>
          <tbody>
            {reg.coefficients.map((c, i) => {
              const badge = sigBadge(c.p);
              const asPct = isInterceptLike(i);
              return (
                <tr key={c.name} className="border-t">
                  <td className="px-3 py-1.5 text-left">{c.name}</td>
                  <td className="px-2 py-1.5 text-right">
                    {asPct ? `${(c.value * 100).toFixed(3)}%` : c.value.toFixed(4)}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {asPct ? `${(c.se * 100).toFixed(3)}%` : c.se.toFixed(4)}
                  </td>
                  <td className="px-2 py-1.5 text-right">{c.t.toFixed(3)}</td>
                  <td className="px-2 py-1.5 text-right">{fmtP(c.p)}</td>
                  <td className="px-2 py-1.5 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded ${badge.cls}`}>
                      {badge.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-5 gap-3 text-sm">
        <Metric label="R²" value={reg.r2} />
        <Metric label="R² ajustado" value={reg.adjustedR2} />
        <Metric label="N" value={reg.n} integer />
        <Metric label="RMSE" value={reg.rmse} asPct />
        <Metric
          label="F-test"
          stringValue={
            Number.isFinite(reg.fStat)
              ? `F=${reg.fStat.toFixed(2)} · p=${fmtP(reg.fPValue)}`
              : "—"
          }
        />
      </div>

      <p className="text-[11px] text-zinc-500">
        Significancia: *** p&lt;0.001 · ** p&lt;0.01 · * p&lt;0.05 · n.s. no significativa.
        F-test = significancia conjunta de todas las β.
      </p>
    </>
  );
}

function PearsonRolling({
  dates,
  arrA,
  arrB,
  window,
  nameA,
  nameB,
  showMA,
}: {
  dates: string[];
  arrA: (number | null)[];
  arrB: (number | null)[];
  window: number;
  nameA: string;
  nameB: string;
  showMA: boolean;
}) {
  const rc = rollingCorrelation(arrA, arrB, window);
  const trimmed = trimLeadingNulls(dates, rc);
  const validRc = rc.filter((v): v is number => v != null);
  const last = validRc.at(-1) ?? null;
  const avg = validRc.length ? validRc.reduce((s, v) => s + v, 0) / validRc.length : null;
  const min = validRc.length ? Math.min(...validRc) : null;
  const max = validRc.length ? Math.max(...validRc) : null;
  const full = correlation(arrA, arrB);

  const corrColor = PALETTE[0];
  // Período más corto que la ventana → correlación estática del período (línea plana).
  const canRoll = dates.length >= window;
  const data: any[] = canRoll
    ? [
        {
          type: "scatter",
          mode: "lines",
          name: `${nameA} vs ${nameB}`,
          x: trimmed.x,
          y: trimmed.y,
          line: { color: corrColor },
          hovertemplate: "%{x|%Y-%m} · %{y:.3f}<extra></extra>",
        },
      ]
    : full != null && dates.length >= 2
    ? [
        {
          type: "scatter",
          mode: "lines",
          name: `${nameA} vs ${nameB}`,
          x: [dates[0], dates[dates.length - 1]],
          y: [full, full],
          line: { color: corrColor, dash: "dash" },
          hovertemplate: "ρ período %{y:.3f}<extra></extra>",
        },
      ]
    : [];
  if (showMA && canRoll) {
    data.push(
      {
        type: "scatter",
        mode: "lines",
        name: "50d",
        x: trimmed.x,
        y: sma(trimmed.y, MA_FAST_MONTHS),
        line: { color: MA_FAST_COLOR, width: 1, dash: "dot" },
        hovertemplate: "%{x|%Y-%m} · 50d %{y:.3f}<extra></extra>",
      },
      {
        type: "scatter",
        mode: "lines",
        name: "200d",
        x: trimmed.x,
        y: sma(trimmed.y, MA_SLOW_MONTHS),
        line: { color: MA_SLOW_COLOR, width: 1.6, dash: "dash" },
        hovertemplate: "%{x|%Y-%m} · 200d %{y:.3f}<extra></extra>",
      },
    );
  }

  return (
    <>
      {!canRoll && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-2">
          El período tiene {dates.length} meses, menos que la ventana de {window}m: se muestra la{" "}
          <b>correlación estática del período</b> (línea punteada). Bajá la ventana para ver una
          rolling.
        </p>
      )}
      <PlotlyChart
        data={data}
        layout={{
          title: canRoll
            ? `Rolling correlation ${window}m (Pearson)`
            : `Correlación del período (${dates.length}m, Pearson)`,
          yaxis: { range: [-1, 1], title: "ρ" },
          xaxis: { title: "Fecha" },
          legend: showMA ? { orientation: "h", y: -0.2 } : undefined,
        }}
        height={500}
      />
      {showMA && canRoll && (
        <p className="text-[10px] text-zinc-400 -mt-2">
          Medias móviles de la correlación · data mensual: <b>50d ≈ 2 meses</b> (punteada, gris) y{" "}
          <b>200d ≈ 10 meses</b> (rayada, negra).
        </p>
      )}
      <div className="grid grid-cols-5 gap-3 text-sm">
        <Metric label="ρ histórico (todo)" value={full} />
        <Metric label="ρ última" value={last} />
        <Metric label="ρ promedio" value={avg} />
        <Metric label="ρ mínima" value={min} />
        <Metric label="ρ máxima" value={max} />
      </div>
    </>
  );
}

function Metric({
  label,
  value,
  stringValue,
  integer,
  asPct,
}: {
  label: string;
  value?: number | null;
  stringValue?: string;
  integer?: boolean;
  asPct?: boolean;
}) {
  let body: string;
  if (stringValue != null) {
    body = stringValue;
  } else if (value == null || !Number.isFinite(value)) {
    body = "—";
  } else if (asPct) {
    body = `${(value * 100).toFixed(2)}%`;
  } else if (integer) {
    body = Math.round(value).toString();
  } else {
    body = value.toFixed(3);
  }
  return (
    <div className="border rounded p-3 bg-zinc-50">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{body}</div>
    </div>
  );
}

function RatioView({
  series,
  num,
  den,
  setNum,
  setDen,
}: {
  series: SeriesData[];
  num: string;
  den: string;
  setNum: (v: string) => void;
  setDen: (v: string) => void;
}) {
  const a = series.find((s) => s.id === num);
  const b = series.find((s) => s.id === den);

  const ratio = useMemo(() => {
    if (!a || !b) return { x: [] as string[], y: [] as number[], start: null as string | null };
    // Inicio común y Base 100 de cada serie sobre ese tramo → el ratio arranca en 1.0.
    const common = commonStartDate([a, b]);
    const keep = (r: { date: string; value: number }) =>
      Number.isFinite(r.value) && (!common || r.date >= common);
    const wa = cumulativeWealth(a.returns.filter(keep), 100);
    const mapB = new Map(cumulativeWealth(b.returns.filter(keep), 100).map((p) => [p.date, p.value]));
    const x: string[] = [];
    const y: number[] = [];
    for (const p of wa) {
      const vb = mapB.get(p.date);
      if (vb == null || vb === 0) continue;
      x.push(p.date);
      y.push(p.value / vb);
    }
    return { x, y, start: common };
  }, [a, b]);

  const last = ratio.y.at(-1) ?? null;
  const min = ratio.y.length ? Math.min(...ratio.y) : null;
  const max = ratio.y.length ? Math.max(...ratio.y) : null;
  const nameA = a?.name ?? "A";
  const nameB = b?.name ?? "B";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 text-sm items-end">
        <div>
          <label className="block text-xs text-zinc-600 mb-1">Numerador (A)</label>
          <select
            value={num}
            onChange={(e) => setNum(e.target.value)}
            className="border border-zinc-300 rounded px-2 py-1 bg-white min-w-[260px]"
          >
            {series.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
        <div className="text-zinc-400 pb-1 text-lg">÷</div>
        <div>
          <label className="block text-xs text-zinc-600 mb-1">Denominador (B)</label>
          <select
            value={den}
            onChange={(e) => setDen(e.target.value)}
            className="border border-zinc-300 rounded px-2 py-1 bg-white min-w-[260px]"
          >
            {series
              .filter((s) => s.id !== num)
              .map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
          </select>
        </div>
        <button
          onClick={() => {
            const prevNum = num;
            setNum(den);
            setDen(prevNum);
          }}
          title="Invertir numerador y denominador"
          className="rounded border border-zinc-300 bg-white px-3 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
        >
          ⇄ Invertir
        </button>
      </div>
      <p className="text-xs text-zinc-600">
        Numerador: <b>{nameA}</b> · Denominador: <b>{nameB}</b>
      </p>

      <PlotlyChart
        data={[
          {
            type: "scatter",
            mode: "lines",
            name: `${nameA} / ${nameB}`,
            x: ratio.x,
            y: ratio.y,
            line: { color: PALETTE[0] },
            hovertemplate: "%{x|%Y-%m} · %{y:.3f}<extra></extra>",
          },
        ]}
        layout={{
          title: `Ratio de precios: ${nameA} / ${nameB}`,
          yaxis: { title: "Ratio (rebase 1.0)" },
          xaxis: { title: "Fecha" },
          shapes: [
            {
              type: "line",
              xref: "paper",
              x0: 0,
              x1: 1,
              y0: 1,
              y1: 1,
              line: { color: "#9ca3af", width: 1, dash: "dot" },
            },
          ],
        }}
        height={500}
      />
      <p className="text-[11px] text-zinc-500">
        División de los Base 100 de ambas series desde el inicio común
        {ratio.start ? ` (${ratio.start})` : ""}. Arranca en <b>1.0</b>: si sube, <b>{nameA}</b>{" "}
        rinde más que <b>{nameB}</b>; si baja, al revés.
      </p>
      <div className="grid grid-cols-4 gap-3 text-sm">
        <Metric label="Ratio actual" value={last} />
        <Metric label="A vs B desde inicio" value={last == null ? null : last - 1} asPct />
        <Metric label="Mínimo" value={min} />
        <Metric label="Máximo" value={max} />
      </div>
    </div>
  );
}

function MatrixView({ series, lastN }: { series: SeriesData[]; lastN: number | "all" }) {
  const { names, matrix } = correlationMatrix(series, lastN === "all" ? undefined : lastN);
  const text = matrix.map((row) => row.map((v) => (v == null ? "" : v.toFixed(2))));
  return (
    <PlotlyChart
      data={[
        {
          type: "heatmap",
          x: names,
          y: names,
          z: matrix.map((r) => r.map((v) => (v == null ? null : v))),
          zmin: -1,
          zmax: 1,
          colorscale: "RdBu",
          reversescale: true,
          text: text as any,
          texttemplate: "%{text}",
          hovertemplate: "%{y} ↔ %{x}: %{z:.3f}<extra></extra>",
        },
      ]}
      layout={{
        title: `Matriz de correlación (${lastN === "all" ? "histórico completo" : `últimos ${lastN}m`})`,
        margin: { l: 200, b: 200 },
      }}
      height={Math.max(500, 40 * names.length + 200)}
    />
  );
}

// ── Monitor de correlaciones (panel superior) ──
// Herramienta de observación rápida. Dos vistas que comparten activo-foco y
// dos períodos configurables (base y reciente):
//   • "Vs activo": para el activo elegido (SPY por defecto), tabla con ρ del
//     período base, ρ del período reciente y Δ.
//   • "Matriz": NxN de todos los activos, con toggle base / reciente / Δ.
// Cada período puede ser: todo el solapamiento, los últimos N meses, o un
// rango de fechas discrecional.
// Δ = ρ reciente − ρ base  → positivo (verde): la correlación SUBIÓ; negativo
// (rojo): bajó. Usa la historia completa de cada serie (no el recorte de abajo).

// Un período de comparación: todo, trailing N meses, o un rango [from,to] (YYYY-MM).
type MonitorPeriod =
  | { kind: "all" }
  | { kind: "last"; n: number }
  | { kind: "range"; from: string; to: string };

// Presets de meses para "últimos N" (más granularidad que antes).
const RECENT_PRESETS = [3, 6, 9, 12, 18, 24, 36, 48, 60, 84, 120, 180];

// Índices de `dates` (ordenadas asc) que caen dentro del período.
function periodIndices(dates: string[], p: MonitorPeriod): number[] {
  if (p.kind === "all") return dates.map((_, i) => i);
  if (p.kind === "last") {
    const start = Math.max(0, dates.length - p.n);
    const out: number[] = [];
    for (let i = start; i < dates.length; i++) out.push(i);
    return out;
  }
  const out: number[] = [];
  for (let i = 0; i < dates.length; i++) {
    const ym = dates[i].slice(0, 7);
    if (p.from && ym < p.from) continue;
    if (p.to && ym > p.to) continue;
    out.push(i);
  }
  return out;
}

function periodLabel(p: MonitorPeriod): string {
  if (p.kind === "all") return "todo";
  if (p.kind === "last") return `últ. ${p.n}m`;
  return `${p.from || "…"} → ${p.to || "…"}`;
}

// Un tablero guardado: conjunto fijo de activos + configuración, independiente
// de lo seleccionado en la biblioteca de la izquierda. Se listan como pestañas.
type MonitorBoard = {
  id: string;
  name: string;
  assetIds: string[];
  focus: string;
  base: MonitorPeriod;
  recent: MonitorPeriod;
  view: "focus" | "matrix";
  sortBy: "full" | "recent" | "delta" | "absdelta" | "name";
  matrixVal: "full" | "recent" | "delta";
};

const BOARDS_KEY = "correlations-app:monitor-boards:v1";

// Correlación de dos series index-alineadas, restringida a un set de índices.
function corrOver(
  a: (number | null)[],
  b: (number | null)[],
  idx: number[],
): number | null {
  const aa = idx.map((i) => a[i] ?? null);
  const bb = idx.map((i) => b[i] ?? null);
  return correlation(aa, bb);
}

function fmtCorr(v: number | null): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(2);
}
function fmtDelta(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return (v > 0 ? "+" : "") + v.toFixed(2);
}
function shortLabel(name: string): string {
  return name.length > 16 ? name.slice(0, 15) + "…" : name;
}

function CorrelationMonitor({
  activeSeries,
  library,
}: {
  activeSeries: SeriesData[];
  library: SeriesData[];
}) {
  const [view, setView] = useState<"focus" | "matrix">("focus");
  const [focus, setFocus] = useState<string>("");
  const [basePeriod, setBasePeriod] = useState<MonitorPeriod>({ kind: "all" });
  const [recentPeriod, setRecentPeriod] = useState<MonitorPeriod>({ kind: "last", n: 60 });
  const [sortBy, setSortBy] = useState<"full" | "recent" | "delta" | "absdelta" | "name">(
    "full",
  );
  const [matrixVal, setMatrixVal] = useState<"full" | "recent" | "delta">("full");

  // ── Tableros (pestañas) ──
  const [boards, setBoards] = useState<MonitorBoard[]>([]);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [editingAssets, setEditingAssets] = useState(false);
  const [assetQuery, setAssetQuery] = useState("");

  // Cargar tableros del navegador
  useEffect(() => {
    try {
      const raw = localStorage.getItem(BOARDS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setBoards(parsed as MonitorBoard[]);
      }
    } catch {
      // ignore
    }
    setHydrated(true);
  }, []);

  // Persistir tableros
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(BOARDS_KEY, JSON.stringify(boards));
    } catch {
      // ignore
    }
  }, [boards, hydrated]);

  const activeBoard = boards.find((b) => b.id === activeBoardId) ?? null;

  // Escribir cambios de configuración al tablero activo (auto-guardado)
  useEffect(() => {
    if (!activeBoardId) return;
    setBoards((prev) =>
      prev.map((b) =>
        b.id === activeBoardId
          ? { ...b, view, focus, base: basePeriod, recent: recentPeriod, sortBy, matrixVal }
          : b,
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, focus, basePeriod, recentPeriod, sortBy, matrixVal, activeBoardId]);

  // Pool de activos: el tablero activo (fijo) o la selección actual (viva).
  const series = useMemo(() => {
    if (!activeBoard) return activeSeries;
    const byId = new Map(library.map((s) => [s.id, s]));
    return activeBoard.assetIds
      .map((id) => byId.get(id))
      .filter((s): s is SeriesData => !!s);
  }, [activeBoard, activeSeries, library]);

  function openBoard(b: MonitorBoard) {
    setActiveBoardId(b.id);
    setEditingAssets(false);
    setView(b.view);
    setFocus(b.focus);
    setBasePeriod(b.base);
    setRecentPeriod(b.recent);
    setSortBy(b.sortBy);
    setMatrixVal(b.matrixVal);
  }

  function newBoard() {
    const name = window.prompt("Nombre del tablero", "SPY vs …");
    if (!name) return;
    const id = `board-${Date.now()}`;
    const seedAssets = (activeBoard ? series : activeSeries).map((s) => s.id);
    const b: MonitorBoard = {
      id,
      name: name.trim(),
      assetIds: seedAssets,
      focus,
      base: basePeriod,
      recent: recentPeriod,
      view,
      sortBy,
      matrixVal,
    };
    setBoards((prev) => [...prev, b]);
    setActiveBoardId(id);
  }

  function renameBoard() {
    if (!activeBoard) return;
    const name = window.prompt("Nuevo nombre", activeBoard.name);
    if (!name) return;
    setBoards((prev) =>
      prev.map((b) => (b.id === activeBoard.id ? { ...b, name: name.trim() } : b)),
    );
  }

  function deleteBoard(id: string) {
    setBoards((prev) => prev.filter((b) => b.id !== id));
    if (activeBoardId === id) setActiveBoardId(null);
  }

  function toggleBoardAsset(assetId: string) {
    if (!activeBoard) return;
    setBoards((prev) =>
      prev.map((b) => {
        if (b.id !== activeBoard.id) return b;
        const has = b.assetIds.includes(assetId);
        return {
          ...b,
          assetIds: has ? b.assetIds.filter((x) => x !== assetId) : [...b.assetIds, assetId],
        };
      }),
    );
  }

  const aligned = useMemo(() => alignSeries(series), [series]);

  // Límites de fecha (YYYY-MM) para los selectores de rango.
  const bounds = useMemo(() => {
    const ds = aligned.dates;
    return {
      min: ds.length ? ds[0].slice(0, 7) : null,
      max: ds.length ? ds[ds.length - 1].slice(0, 7) : null,
    };
  }, [aligned]);

  const baseIdx = useMemo(() => periodIndices(aligned.dates, basePeriod), [aligned, basePeriod]);
  const recentIdx = useMemo(
    () => periodIndices(aligned.dates, recentPeriod),
    [aligned, recentPeriod],
  );

  // Foco por defecto: algo que parezca SPY / S&P 500; si no, la primera serie.
  const effFocus = useMemo(() => {
    if (focus && series.some((s) => s.id === focus)) return focus;
    const spy = series.find(
      (s) => /spy|s&p\s*500|sp500|sp-500/i.test(s.name) || /spy/i.test(s.id),
    );
    return spy?.id ?? series[0]?.id ?? "";
  }, [focus, series]);

  const cell = (
    a: (number | null)[],
    b: (number | null)[],
  ): { full: number | null; recent: number | null; delta: number | null; n: number } => {
    const full = corrOver(a, b, baseIdx);
    const recent = corrOver(a, b, recentIdx);
    const delta = full != null && recent != null ? recent - full : null;
    let n = 0;
    for (const i of baseIdx) if (a[i] != null && b[i] != null) n++;
    return { full, recent, delta, n };
  };

  // Filas de la vista "Vs activo"
  const focusRows = useMemo(() => {
    const fArr = aligned.byId[effFocus] ?? [];
    const rows = series
      .filter((s) => s.id !== effFocus)
      .map((s) => {
        const c = cell(fArr, aligned.byId[s.id] ?? []);
        return { id: s.id, name: s.name, ...c };
      });
    const num = (v: number | null) => (v == null || !Number.isFinite(v) ? -Infinity : v);
    rows.sort((a, b) => {
      switch (sortBy) {
        case "name":
          return a.name.localeCompare(b.name);
        case "recent":
          return num(b.recent) - num(a.recent);
        case "delta":
          return num(b.delta) - num(a.delta);
        case "absdelta":
          return Math.abs(num(b.delta)) - Math.abs(num(a.delta));
        default:
          return num(b.full) - num(a.full);
      }
    });
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aligned, effFocus, series, baseIdx, recentIdx, sortBy]);

  // Matriz NxN
  const matrix = useMemo(() => {
    const ids = series.map((s) => s.id);
    const names = series.map((s) => s.name);
    const arrs = ids.map((id) => aligned.byId[id] ?? []);
    const z: (number | null)[][] = ids.map((_, i) =>
      ids.map((__, j) => {
        if (i === j) return matrixVal === "delta" ? 0 : 1;
        const c = cell(arrs[i], arrs[j]);
        return matrixVal === "full" ? c.full : matrixVal === "recent" ? c.recent : c.delta;
      }),
    );
    return { names, z };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aligned, series, baseIdx, recentIdx, matrixVal]);

  const focusName = series.find((s) => s.id === effFocus)?.name ?? "—";
  const bg = matrixVal === "delta" ? deltaBg : corrBg;
  const fmt = matrixVal === "delta" ? fmtDelta : fmtCorr;

  const sortHeader = (key: typeof sortBy, label: ReactNode, extra = "") => (
    <button
      onClick={() => setSortBy(key)}
      className={`w-full text-right hover:underline ${extra} ${
        sortBy === key ? "text-brand-800 font-semibold" : "text-zinc-600"
      }`}
      title="Ordenar por esta columna"
    >
      {label} {sortBy === key ? "▾" : ""}
    </button>
  );

  return (
    <details open className="mb-6 rounded-lg border border-brand-200 bg-brand-50/40">
      <summary className="cursor-pointer select-none px-4 py-2.5 flex items-center gap-2">
        <span className="text-sm font-semibold text-brand-800">🔭 Monitor de correlaciones</span>
        <span className="text-[11px] text-zinc-500">
          {activeBoard ? activeBoard.name : "Selección actual"} · base {periodLabel(basePeriod)} vs{" "}
          {periodLabel(recentPeriod)} · {series.length} activos
        </span>
      </summary>

      <div className="px-4 pb-4 pt-1 space-y-3">
        {/* Pestañas de tableros */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-brand-200 pb-2">
          <button
            onClick={() => setActiveBoardId(null)}
            className={`px-2.5 py-1 rounded-t text-xs border ${
              activeBoardId === null
                ? "bg-white border-brand-300 text-brand-800 font-semibold"
                : "bg-brand-50 border-transparent text-zinc-600 hover:bg-white"
            }`}
            title="Usa los activos seleccionados a la izquierda (vivo)"
          >
            Selección actual
          </button>
          {boards.map((b) => (
            <button
              key={b.id}
              onClick={() => openBoard(b)}
              className={`px-2.5 py-1 rounded-t text-xs border ${
                activeBoardId === b.id
                  ? "bg-white border-brand-300 text-brand-800 font-semibold"
                  : "bg-brand-50 border-transparent text-zinc-600 hover:bg-white"
              }`}
              title={`${b.assetIds.length} activos`}
            >
              {b.name}
            </button>
          ))}
          <button
            onClick={newBoard}
            className="px-2 py-1 rounded text-xs text-brand-700 hover:bg-brand-100"
            title="Guardar la configuración actual como tablero nuevo"
          >
            ＋ Nuevo tablero
          </button>
        </div>

        {/* Barra de tablero activo */}
        {activeBoard ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              onClick={() => setEditingAssets((v) => !v)}
              className="rounded border border-brand-300 bg-white px-2.5 py-1 text-brand-800 hover:bg-brand-50"
            >
              Activos del tablero ({activeBoard.assetIds.length}) {editingAssets ? "▴" : "▾"}
            </button>
            <button
              onClick={renameBoard}
              className="rounded border border-zinc-300 bg-white px-2.5 py-1 text-zinc-700 hover:bg-zinc-50"
            >
              Renombrar
            </button>
            <button
              onClick={() => deleteBoard(activeBoard.id)}
              className="rounded border border-red-200 bg-white px-2.5 py-1 text-red-700 hover:bg-red-50"
            >
              Eliminar
            </button>
            <span className="text-zinc-400">Guarda automáticamente los cambios.</span>
          </div>
        ) : (
          <p className="text-[11px] text-zinc-500">
            Estás sobre la <b>selección actual</b> (los activos activos de la izquierda). Configurá
            foco/períodos y tocá <b>＋ Nuevo tablero</b> para fijarlos como una pestaña reutilizable.
          </p>
        )}

        {/* Editor de activos del tablero */}
        {activeBoard &&
          editingAssets &&
          (() => {
            const q = assetQuery.trim().toLowerCase();
            const filtered = q
              ? library.filter((s) => s.name.toLowerCase().includes(q))
              : library;
            const filteredIds = filtered.map((s) => s.id);
            const allShownIn = filteredIds.every((id) => activeBoard.assetIds.includes(id));
            const setBulk = (add: boolean) =>
              setBoards((prev) =>
                prev.map((b) => {
                  if (b.id !== activeBoard.id) return b;
                  const set = new Set(b.assetIds);
                  if (add) filteredIds.forEach((id) => set.add(id));
                  else filteredIds.forEach((id) => set.delete(id));
                  // preservar orden de la biblioteca
                  return { ...b, assetIds: library.map((s) => s.id).filter((id) => set.has(id)) };
                }),
              );
            return (
              <div className="border border-zinc-200 rounded bg-white p-2">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <input
                    autoFocus
                    value={assetQuery}
                    onChange={(e) => setAssetQuery(e.target.value)}
                    placeholder="Buscar… (ej: SPY, sector, small)"
                    className="flex-1 min-w-[200px] border border-zinc-300 rounded px-2 py-1 bg-white text-xs"
                  />
                  {filtered.length > 0 && (
                    <button
                      onClick={() => setBulk(!allShownIn)}
                      className="rounded border border-brand-300 bg-brand-50 px-2 py-1 text-[11px] text-brand-800 hover:bg-brand-100"
                    >
                      {allShownIn ? "Quitar" : "Agregar"} {q ? "filtrados" : "todos"} ({filtered.length})
                    </button>
                  )}
                  <span className="text-[10px] text-zinc-400">
                    {activeBoard.assetIds.length}/{library.length}
                  </span>
                </div>
                <div className="max-h-52 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-x-4">
                  {filtered.length === 0 ? (
                    <p className="text-[11px] text-zinc-400 px-1 py-2">Nada coincide con «{assetQuery}».</p>
                  ) : (
                    filtered.map((s) => {
                      const checked = activeBoard.assetIds.includes(s.id);
                      return (
                        <label
                          key={s.id}
                          className="flex items-center gap-2 px-1 py-0.5 text-xs hover:bg-zinc-50 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleBoardAsset(s.id)}
                          />
                          <span className="truncate" title={s.name}>{s.name}</span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })()}

        {/* Controles */}
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <div className="inline-flex rounded border border-zinc-300 overflow-hidden text-xs">
            <button
              className={`px-3 py-1 ${view === "focus" ? "bg-brand-700 text-white" : "bg-white text-zinc-700"}`}
              onClick={() => setView("focus")}
            >
              Vs activo
            </button>
            <button
              className={`px-3 py-1 ${view === "matrix" ? "bg-brand-700 text-white" : "bg-white text-zinc-700"}`}
              onClick={() => setView("matrix")}
            >
              Matriz completa
            </button>
          </div>
          {view === "focus" && (
            <div>
              <label className="block text-[11px] text-zinc-600 mb-1">Activo foco</label>
              <select
                value={effFocus}
                onChange={(e) => setFocus(e.target.value)}
                className="border border-zinc-300 rounded px-2 py-1 bg-white min-w-[220px]"
              >
                {series.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}
          {view === "matrix" && (
            <div>
              <label className="block text-[11px] text-zinc-600 mb-1">Valor</label>
              <select
                value={matrixVal}
                onChange={(e) => setMatrixVal(e.target.value as any)}
                className="border border-zinc-300 rounded px-2 py-1 bg-white"
              >
                <option value="full">ρ base ({periodLabel(basePeriod)})</option>
                <option value="recent">ρ reciente ({periodLabel(recentPeriod)})</option>
                <option value="delta">Δ (reciente − base)</option>
              </select>
            </div>
          )}
          <PeriodPicker
            label="Base histórica"
            value={basePeriod}
            onChange={setBasePeriod}
            bounds={bounds}
            allowAll
          />
          <PeriodPicker
            label="Reciente"
            value={recentPeriod}
            onChange={setRecentPeriod}
            bounds={bounds}
            allowAll
          />
        </div>

        {series.length < 2 ? (
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-2">
            {activeBoard
              ? "Este tablero tiene menos de 2 activos. Abrí «Activos del tablero» y agregá al menos 2."
              : "Seleccioná al menos 2 activos a la izquierda (o creá un tablero)."}
          </p>
        ) : view === "focus" ? (
          <>
            <div className="overflow-x-auto border rounded bg-white">
              <table className="w-full text-xs tabular-nums">
                <thead className="bg-brand-50">
                  <tr>
                    <th className="px-3 py-1.5 text-left">
                      <button
                        onClick={() => setSortBy("name")}
                        className={`hover:underline ${sortBy === "name" ? "text-brand-800 font-semibold" : "text-zinc-600"}`}
                      >
                        Activo {sortBy === "name" ? "▾" : ""}
                      </button>
                    </th>
                    <th className="px-3 py-1.5">
                      {sortHeader(
                        "full",
                        <>
                          ρ base
                          <span className="block font-normal text-[9px] text-zinc-400">
                            {periodLabel(basePeriod)}
                          </span>
                        </>,
                      )}
                    </th>
                    <th className="px-3 py-1.5">
                      {sortHeader(
                        "recent",
                        <>
                          ρ reciente
                          <span className="block font-normal text-[9px] text-zinc-400">
                            {periodLabel(recentPeriod)}
                          </span>
                        </>,
                      )}
                    </th>
                    <th className="px-3 py-1.5">{sortHeader("delta", "Δ")}</th>
                    <th className="px-2 py-1.5 text-right text-zinc-400 font-normal">N</th>
                  </tr>
                </thead>
                <tbody>
                  {focusRows.map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="px-3 py-1 text-left" title={r.name}>{r.name}</td>
                      <td
                        className="px-3 py-1 text-right"
                        style={{ backgroundColor: corrBg(r.full) }}
                      >
                        {fmtCorr(r.full)}
                      </td>
                      <td
                        className="px-3 py-1 text-right"
                        style={{ backgroundColor: corrBg(r.recent) }}
                      >
                        {fmtCorr(r.recent)}
                      </td>
                      <td
                        className="px-3 py-1 text-right font-medium"
                        style={{ backgroundColor: deltaBg(r.delta) }}
                      >
                        {fmtDelta(r.delta)}
                      </td>
                      <td className="px-2 py-1 text-right text-zinc-400">{r.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-zinc-500">
              Correlación de cada activo contra <b>{focusName}</b>. <b>ρ base</b> ={" "}
              {periodLabel(basePeriod)}; <b>ρ reciente</b> = {periodLabel(recentPeriod)}.{" "}
              <b>Δ = reciente − base</b>: <span className="text-emerald-700">verde/+</span> la
              correlación subió; <span className="text-red-700">rojo/−</span> bajó. <b>N</b> = meses
              de solapamiento en la base.
            </p>

            <DiffOverTime
              series={series}
              aligned={aligned}
              focus={effFocus}
              baseIdx={baseIdx}
              basePeriod={basePeriod}
            />
          </>
        ) : (
          <>
            <div className="overflow-x-auto border rounded bg-white max-h-[70vh] overflow-y-auto">
              <table className="text-xs tabular-nums border-collapse">
                <thead>
                  <tr>
                    <th className="sticky left-0 z-10 bg-brand-50 px-2 py-1.5 text-left" />
                    {matrix.names.map((n, j) => (
                      <th
                        key={j}
                        className="px-2 py-1.5 text-right bg-brand-50 whitespace-nowrap"
                        title={n}
                      >
                        {shortLabel(n)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrix.names.map((rowName, i) => (
                    <tr key={i}>
                      <th
                        className="sticky left-0 z-10 bg-brand-50 px-2 py-1 text-left whitespace-nowrap font-medium"
                        title={rowName}
                      >
                        {shortLabel(rowName)}
                      </th>
                      {matrix.z[i].map((v, j) => (
                        <td
                          key={j}
                          className="px-2 py-1 text-right border border-zinc-100"
                          style={{ backgroundColor: i === j ? "#f4f4f5" : bg(v) }}
                          title={`${rowName} ↔ ${matrix.names[j]}: ${fmt(v)}`}
                        >
                          {i === j ? "—" : fmt(v)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-zinc-500">
              Matriz de{" "}
              {matrixVal === "full"
                ? `correlación del período base (${periodLabel(basePeriod)})`
                : matrixVal === "recent"
                  ? `correlación del período reciente (${periodLabel(recentPeriod)})`
                  : "cambio Δ = ρ reciente − ρ base"}
              . <span className="text-emerald-700">Verde</span> = correlación alta (o Δ+, subió);{" "}
              <span className="text-red-700">rojo</span> = baja/negativa (o Δ−, bajó).
            </p>
          </>
        )}
      </div>
    </details>
  );
}

// Selector de período reutilizable: Todo / Últimos N meses / Rango de fechas.
function PeriodPicker({
  label,
  value,
  onChange,
  bounds,
  allowAll,
}: {
  label: string;
  value: MonitorPeriod;
  onChange: (p: MonitorPeriod) => void;
  bounds: { min: string | null; max: string | null };
  allowAll?: boolean;
}) {
  return (
    <div>
      <label className="block text-[11px] text-zinc-600 mb-1">{label}</label>
      <div className="flex items-center gap-1">
        <select
          value={value.kind}
          onChange={(e) => {
            const k = e.target.value as MonitorPeriod["kind"];
            if (k === "all") onChange({ kind: "all" });
            else if (k === "last")
              onChange({ kind: "last", n: value.kind === "last" ? value.n : 60 });
            else
              onChange({
                kind: "range",
                from: value.kind === "range" ? value.from : "",
                to: value.kind === "range" ? value.to : "",
              });
          }}
          className="border border-zinc-300 rounded px-2 py-1 bg-white text-xs"
        >
          {allowAll && <option value="all">Todo</option>}
          <option value="last">Últimos N meses</option>
          <option value="range">Rango de fechas</option>
        </select>
        {value.kind === "last" && (
          <select
            value={value.n}
            onChange={(e) => onChange({ kind: "last", n: Number(e.target.value) })}
            className="border border-zinc-300 rounded px-2 py-1 bg-white text-xs"
          >
            {RECENT_PRESETS.map((w) => (
              <option key={w} value={w}>{w}m</option>
            ))}
          </select>
        )}
        {value.kind === "range" && (
          <div className="flex items-center gap-1">
            <input
              type="month"
              value={value.from}
              min={bounds.min ?? undefined}
              max={value.to || bounds.max || undefined}
              onChange={(e) => onChange({ ...value, from: e.target.value })}
              className="border border-zinc-300 rounded px-1.5 py-1 bg-white text-xs"
            />
            <span className="text-zinc-400 text-xs">→</span>
            <input
              type="month"
              value={value.to}
              min={value.from || bounds.min || undefined}
              max={bounds.max ?? undefined}
              onChange={(e) => onChange({ ...value, to: e.target.value })}
              className="border border-zinc-300 rounded px-1.5 py-1 bg-white text-xs"
            />
          </div>
        )}
      </div>
    </div>
  );
}

// Gráfico colapsable: diferencia en el tiempo entre la correlación base (una
// constante del período base) y la rolling correlation. diff(t) = ρ base −
// rolling(t). Positivo ⇒ ahora MENOS correlacionado que su base; negativo ⇒ más.
function DiffOverTime({
  series,
  aligned,
  focus,
  baseIdx,
  basePeriod,
}: {
  series: SeriesData[];
  aligned: ReturnType<typeof alignSeries>;
  focus: string;
  baseIdx: number[];
  basePeriod: MonitorPeriod;
}) {
  const [rollWindow, setRollWindow] = useState<number>(36);

  const focusName = series.find((s) => s.id === focus)?.name ?? "—";
  const { traces, empty } = useMemo(() => {
    const fArr = aligned.byId[focus] ?? [];
    const others = series.filter((s) => s.id !== focus);
    const traces: any[] = [];
    for (let i = 0; i < others.length; i++) {
      const s = others[i];
      const oArr = aligned.byId[s.id] ?? [];
      const hist = corrOver(fArr, oArr, baseIdx);
      if (hist == null) continue;
      const rc = rollingCorrelation(fArr, oArr, rollWindow);
      const diff = rc.map((v) => (v == null ? null : hist - v));
      const trimmed = trimLeadingNulls(aligned.dates, diff);
      if (trimmed.x.length === 0) continue;
      traces.push({
        type: "scatter" as const,
        mode: "lines" as const,
        name: s.name,
        x: trimmed.x,
        y: trimmed.y,
        line: { color: PALETTE[i % PALETTE.length] },
        hovertemplate: "%{x|%Y-%m} · %{y:.3f}<extra>%{fullData.name}</extra>",
      });
    }
    return { traces, empty: traces.length === 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aligned, series, focus, baseIdx, rollWindow]);

  return (
    <details className="mt-1 rounded border border-zinc-200 bg-white">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-zinc-700">
        📈 Ver diferencia en el tiempo (ρ base − rolling)
      </summary>
      <div className="px-3 pb-3 pt-1 space-y-2">
        <div className="flex items-end gap-3">
          <div>
            <label className="block text-[11px] text-zinc-600 mb-1">Ventana rolling</label>
            <select
              value={rollWindow}
              onChange={(e) => setRollWindow(Number(e.target.value))}
              className="border border-zinc-300 rounded px-2 py-1 bg-white text-xs"
            >
              {RECENT_PRESETS.filter((w) => w <= 120).map((w) => (
                <option key={w} value={w}>{w}m</option>
              ))}
            </select>
          </div>
          <p className="text-[11px] text-zinc-500 flex-1">
            Cada línea es <b>ρ base ({periodLabel(basePeriod)})</b> menos la rolling correlation de{" "}
            {rollWindow}m de cada activo contra <b>{focusName}</b>. Arriba de 0 ⇒ ahora{" "}
            <b>menos</b> correlacionado que su base; abajo de 0 ⇒ <b>más</b>.
          </p>
        </div>
        {empty ? (
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
            No hay suficiente historia para una rolling de {rollWindow}m. Bajá la ventana.
          </p>
        ) : (
          <PlotlyChart
            data={traces}
            layout={{
              yaxis: { title: "ρ base − rolling", zeroline: true },
              xaxis: { title: "Fecha" },
              hovermode: "x unified",
              legend: { orientation: "h", y: -0.2 },
              shapes: [
                {
                  type: "line",
                  xref: "paper",
                  x0: 0,
                  x1: 1,
                  y0: 0,
                  y1: 0,
                  line: { color: "#9ca3af", width: 1, dash: "dot" },
                },
              ],
            }}
            height={380}
          />
        )}
      </div>
    </details>
  );
}

function DrawdownPanel({ series }: { series: SeriesData[] }) {
  const { traces, maxDD } = useMemo(() => {
    const traces: any[] = [];
    const maxDD: { name: string; dd: number; date: string | null }[] = [];
    series.forEach((s, i) => {
      const sorted = [...s.returns]
        .filter((r) => Number.isFinite(r.value))
        .sort((a, b) => a.date.localeCompare(b.date));
      const color = PALETTE[i % PALETTE.length];
      let wealth = 1;
      let peak = 1;
      let worst = 0;
      let worstDate: string | null = null;
      const x: string[] = [];
      const y: number[] = [];
      for (const r of sorted) {
        wealth *= 1 + r.value;
        if (wealth > peak) peak = wealth;
        const dd = wealth / peak - 1;
        x.push(r.date);
        y.push(dd * 100);
        if (dd < worst) {
          worst = dd;
          worstDate = r.date;
        }
      }
      traces.push({
        type: "scatter" as const,
        mode: "lines" as const,
        name: s.name,
        x,
        y,
        line: { color, width: 1.5 },
        hovertemplate: "%{x|%Y-%m} · %{y:.2f}%<extra>%{fullData.name}</extra>",
      });
      maxDD.push({ name: s.name, dd: worst * 100, date: worstDate });
    });
    return { traces, maxDD };
  }, [series]);

  return (
    <div className="mt-2">
      <PlotlyChart
        data={traces}
        layout={{
          title: "Drawdown (underwater)",
          yaxis: { title: "Caída desde el máximo", ticksuffix: "%", rangemode: "tozero" },
          xaxis: { title: "Fecha" },
          hovermode: "x unified",
          legend: { orientation: "h", y: -0.2 },
        }}
        height={380}
      />
      <p className="text-[11px] text-zinc-500 mt-1">
        Drawdown = caída acumulada desde el máximo previo (pico → valle) en cada momento, sobre la
        historia completa de cada serie. El mínimo de cada línea es el <b>Max DD</b> que aparece en la
        tabla de métricas.
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
        {maxDD.map((m) => (
          <div key={m.name} className="border rounded p-2 bg-zinc-50">
            <div className="text-[10px] text-zinc-500 truncate" title={m.name}>{m.name}</div>
            <div className="text-sm font-semibold tabular-nums text-red-700">
              {m.dd.toFixed(2)}%
            </div>
            <div className="text-[10px] text-zinc-400">{m.date ? `valle ${m.date}` : "—"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReturnsTable({
  series,
  aligned,
}: {
  series: SeriesData[];
  aligned: ReturnType<typeof alignSeries>;
}) {
  const [order, setOrder] = useState<"desc" | "asc">("desc");
  const dates = useMemo(() => {
    const idx = aligned.dates.map((d, i) => ({ d, i }));
    return order === "desc" ? idx.slice().reverse() : idx;
  }, [aligned.dates, order]);

  return (
    <div className="mt-2 border rounded">
      <div className="flex items-center justify-between px-2 py-1 text-[11px] bg-zinc-50 border-b">
        <span className="text-zinc-600">
          {aligned.dates.length} meses · {aligned.dates[0] ?? "—"} → {aligned.dates.at(-1) ?? "—"}
        </span>
        <button
          onClick={() => setOrder((o) => (o === "desc" ? "asc" : "desc"))}
          className="text-zinc-600 hover:text-zinc-900 underline"
        >
          Orden: {order === "desc" ? "reciente → antiguo" : "antiguo → reciente"}
        </button>
      </div>
      <div className="overflow-auto max-h-[60vh]">
        <table className="text-[11px] tabular-nums w-full">
          <thead className="bg-brand-50 sticky top-0 shadow-[inset_0_-1px_0_rgba(0,0,0,0.05)]">
            <tr>
              <th className="px-2 py-1 text-left bg-brand-50">Fecha</th>
              {series.map((s) => (
                <th key={s.id} className="px-2 py-1 text-right whitespace-nowrap bg-brand-50">
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dates.map(({ d, i }) => (
              <tr key={d} className="border-t">
                <td className="px-2 py-0.5">{d}</td>
                {series.map((s) => {
                  const v = aligned.byId[s.id][i];
                  return (
                    <td key={s.id} className="px-2 py-0.5 text-right">
                      {v == null ? "—" : (v * 100).toFixed(2) + "%"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
