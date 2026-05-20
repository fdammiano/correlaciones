"use client";

import { useMemo, useState } from "react";
import PlotlyChart from "./PlotlyChart";
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

type Mode = "rolling" | "matrix" | "regression";
type RollingSub = "one-vs-many" | "pair";

const WINDOWS = [12, 24, 30, 36, 60, 120];

export default function ChartPanel({ series }: { series: SeriesData[] }) {
  const [mode, setMode] = useState<Mode>("rolling");
  const [rollingSub, setRollingSub] = useState<RollingSub>("one-vs-many");
  const [window, setWindow] = useState(60);
  const [benchmark, setBenchmark] = useState<string>("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [pairA, setPairA] = useState<string>("");
  const [pairB, setPairB] = useState<string>("");
  const [matrixLastN, setMatrixLastN] = useState<number | "all">(60);

  const aligned = useMemo(() => alignSeries(series), [series]);
  const seriesById = useMemo(() => new Map(series.map((s) => [s.id, s])), [series]);

  const effectiveBenchmark = benchmark && seriesById.has(benchmark) ? benchmark : series[0]?.id ?? "";
  const effectivePairA = pairA && seriesById.has(pairA) ? pairA : series[0]?.id ?? "";
  const effectivePairB =
    pairB && seriesById.has(pairB) && pairB !== effectivePairA
      ? pairB
      : series.find((s) => s.id !== effectivePairA)?.id ?? "";

  return (
    <section className="flex-1 p-6 overflow-y-auto h-screen">
      <h1 className="text-xl font-semibold mb-1">Rolling Correlations</h1>
      <p className="text-xs text-zinc-500 mb-4">
        Ken French portfolios + Yahoo Finance · retornos mensuales
      </p>

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
          </select>
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
        />
      ) : mode === "regression" ? (
        <RegressionMode series={series} aligned={aligned} />
      ) : (
        <MatrixView series={series} lastN={matrixLastN} />
      )}

      {series.length > 0 && (
        <>
          <div className="mt-8">
            <h2 className="text-sm font-semibold mb-2">Series individuales (base 100)</h2>
            <p className="text-[11px] text-zinc-500 mb-2">
              Crecimiento acumulado de cada serie normalizado a 100 en el primer mes disponible.
            </p>
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
    </section>
  );
}

function WealthChart({ series }: { series: SeriesData[] }) {
  const common = useMemo(() => commonStartDate(series), [series]);
  const traces = useMemo(
    () =>
      series.map((s) => {
        const trimmedReturns = common
          ? s.returns.filter((r) => r.date >= common)
          : s.returns;
        const w = cumulativeWealth(trimmedReturns, 100);
        return {
          type: "scatter" as const,
          mode: "lines" as const,
          name: s.name,
          x: w.map((p) => p.date),
          y: w.map((p) => p.value),
          hovertemplate: "%{x|%Y-%m} · %{y:.1f}<extra>%{fullData.name}</extra>",
        };
      }),
    [series, common],
  );
  return (
    <>
      {common && (
        <p className="text-[11px] text-zinc-500 mb-1">
          Rebaseo en común desde <b>{common}</b> (primer mes donde todas las series activas tienen dato).
        </p>
      )}
      <PlotlyChart
        data={traces}
        layout={{
          yaxis: { title: "Wealth (base 100)", type: "log" },
          xaxis: { title: "Fecha" },
          hovermode: "x unified",
          legend: { orientation: "h", y: -0.2 },
        }}
        height={420}
      />
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
          <thead className="bg-zinc-100">
            <tr>
              <th className="px-3 py-1.5 text-left">Serie</th>
              <th className="px-2 py-1.5 text-right">Inicio</th>
              <th className="px-2 py-1.5 text-right">Fin</th>
              <th className="px-2 py-1.5 text-right">N</th>
              <th className="px-2 py-1.5 text-right">Retorno total</th>
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
                <td className="px-2 py-1 text-right">{fmtPct(m.totalReturn, 1)}</td>
                <td className="px-2 py-1 text-right">{fmtPct(m.annualReturn)}</td>
                <td className="px-2 py-1 text-right">{fmtPct(m.annualVol)}</td>
                <td className="px-2 py-1 text-right">{fmtNum(m.sharpe)}</td>
                <td className="px-2 py-1 text-right text-red-700">{fmtPct(m.maxDrawdown)}</td>
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
}: {
  series: SeriesData[];
  window: number;
  aligned: ReturnType<typeof alignSeries>;
  benchmark: string;
  setBenchmark: (v: string) => void;
  excluded: Set<string>;
  setExcluded: (s: Set<string>) => void;
}) {
  const others = series.filter((s) => s.id !== benchmark && !excluded.has(s.id));
  const bArr = aligned.byId[benchmark] ?? [];
  const traces = others.map((s) => {
    const rc = rollingCorrelation(bArr, aligned.byId[s.id] ?? [], window);
    const trimmed = trimLeadingNulls(aligned.dates, rc);
    return {
      type: "scatter" as const,
      mode: "lines" as const,
      name: s.name,
      x: trimmed.x,
      y: trimmed.y,
      hovertemplate: "%{x|%Y-%m} · %{y:.3f}<extra>%{fullData.name}</extra>",
    };
  });

  const lastTable = others.map((s) => {
    const o = aligned.byId[s.id] ?? [];
    const slice = (arr: (number | null)[]) => arr.slice(-window);
    const c = correlation(slice(bArr), slice(o));
    return { name: s.name, id: s.id, last: c };
  });
  lastTable.sort((a, b) => (b.last ?? -2) - (a.last ?? -2));

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
      <PlotlyChart
        data={traces}
        layout={{
          title: `Rolling correlation ${window}m`,
          yaxis: { range: [-1, 1], title: "ρ" },
          xaxis: { title: "Fecha" },
          hovermode: "x unified",
          legend: { orientation: "h", y: -0.2 },
        }}
      />
      <div className="border rounded text-xs">
        <table className="w-full">
          <thead className="bg-zinc-100">
            <tr>
              <th className="text-left px-3 py-1.5">Serie</th>
              <th className="text-right px-3 py-1.5">ρ últimos {window}m</th>
              <th className="w-12"></th>
            </tr>
          </thead>
          <tbody>
            {lastTable.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-3 py-1">{r.name}</td>
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
}: {
  series: SeriesData[];
  window: number;
  aligned: ReturnType<typeof alignSeries>;
  a: string;
  b: string;
  setA: (v: string) => void;
  setB: (v: string) => void;
}) {
  const arrA = aligned.byId[a] ?? [];
  const arrB = aligned.byId[b] ?? [];
  const nameA = series.find((s) => s.id === a)?.name ?? "A";
  const nameB = series.find((s) => s.id === b)?.name ?? "B";

  return (
    <div className="space-y-4">
      <PairAB series={series} a={a} b={b} setA={setA} setB={setB} />
      <PearsonRolling
        dates={aligned.dates}
        arrA={arrA}
        arrB={arrB}
        window={window}
        nameA={nameA}
        nameB={nameB}
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
      : { label: "n.s.", cls: "bg-zinc-100 text-zinc-600" };

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
          <thead className="bg-zinc-100">
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
}: {
  dates: string[];
  arrA: (number | null)[];
  arrB: (number | null)[];
  window: number;
  nameA: string;
  nameB: string;
}) {
  const rc = rollingCorrelation(arrA, arrB, window);
  const trimmed = trimLeadingNulls(dates, rc);
  const validRc = rc.filter((v): v is number => v != null);
  const last = validRc.at(-1) ?? null;
  const avg = validRc.length ? validRc.reduce((s, v) => s + v, 0) / validRc.length : null;
  const min = validRc.length ? Math.min(...validRc) : null;
  const max = validRc.length ? Math.max(...validRc) : null;

  return (
    <>
      <PlotlyChart
        data={[
          {
            type: "scatter",
            mode: "lines",
            name: `${nameA} vs ${nameB}`,
            x: trimmed.x,
            y: trimmed.y,
            hovertemplate: "%{x|%Y-%m} · %{y:.3f}<extra></extra>",
          },
        ]}
        layout={{
          title: `Rolling correlation ${window}m (Pearson)`,
          yaxis: { range: [-1, 1], title: "ρ" },
          xaxis: { title: "Fecha" },
        }}
        height={500}
      />
      <div className="grid grid-cols-4 gap-3 text-sm">
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
          <thead className="bg-zinc-100 sticky top-0 shadow-[inset_0_-1px_0_rgba(0,0,0,0.05)]">
            <tr>
              <th className="px-2 py-1 text-left bg-zinc-100">Fecha</th>
              {series.map((s) => (
                <th key={s.id} className="px-2 py-1 text-right whitespace-nowrap bg-zinc-100">
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
