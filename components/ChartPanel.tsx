"use client";

import { useMemo, useState } from "react";
import PlotlyChart from "./PlotlyChart";
import { alignSeries, correlation, correlationMatrix, rollingCorrelation } from "@/lib/stats";
import { cumulativeWealth, summarize } from "@/lib/metrics";
import type { SeriesData } from "@/lib/types";

type Mode = "one-vs-many" | "pair" | "matrix";

const WINDOWS = [12, 24, 30, 36, 60, 120];

export default function ChartPanel({ series }: { series: SeriesData[] }) {
  const [mode, setMode] = useState<Mode>("one-vs-many");
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
            <option value="one-vs-many">Uno vs varios</option>
            <option value="pair">Par individual</option>
            <option value="matrix">Matriz estática</option>
          </select>
        </div>
        {mode !== "matrix" && (
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
      ) : mode === "one-vs-many" ? (
        <OneVsMany
          series={series}
          window={window}
          aligned={aligned}
          benchmark={effectiveBenchmark}
          setBenchmark={setBenchmark}
          excluded={excluded}
          setExcluded={setExcluded}
        />
      ) : mode === "pair" ? (
        <PairView
          series={series}
          window={window}
          aligned={aligned}
          a={effectivePairA}
          b={effectivePairB}
          setA={setPairA}
          setB={setPairB}
        />
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
            <p className="text-[11px] text-zinc-500 mb-2">
              Cálculo sobre toda la historia de cada serie. Anualizado asume retornos mensuales · Sharpe asume rf = 0.
            </p>
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
  const traces = useMemo(
    () =>
      series.map((s) => {
        const w = cumulativeWealth(s.returns, 100);
        return {
          type: "scatter" as const,
          mode: "lines" as const,
          name: s.name,
          x: w.map((p) => p.date),
          y: w.map((p) => p.value),
          hovertemplate: "%{x|%Y-%m} · %{y:.1f}<extra>%{fullData.name}</extra>",
        };
      }),
    [series],
  );
  return (
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
  );
}

function MetricsTable({ series }: { series: SeriesData[] }) {
  const rows = useMemo(
    () => series.map((s) => ({ id: s.id, name: s.name, m: summarize(s.returns) })),
    [series],
  );
  const fmtPct = (v: number | null, d = 2) =>
    v == null ? "—" : `${(v * 100).toFixed(d)}%`;
  const fmtNum = (v: number | null, d = 2) => (v == null ? "—" : v.toFixed(d));

  return (
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
            <th className="px-2 py-1.5 text-right">Sharpe</th>
            <th className="px-2 py-1.5 text-right">Max DD</th>
            <th className="px-2 py-1.5 text-right">% meses +</th>
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
    return {
      type: "scatter" as const,
      mode: "lines" as const,
      name: s.name,
      x: aligned.dates,
      y: rc,
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

function PairView({
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
  const rc = rollingCorrelation(arrA, arrB, window);
  const validRc = rc.filter((v): v is number => v != null);
  const last = validRc.at(-1) ?? null;
  const avg = validRc.length
    ? validRc.reduce((s, v) => s + v, 0) / validRc.length
    : null;
  const min = validRc.length ? Math.min(...validRc) : null;
  const max = validRc.length ? Math.max(...validRc) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 text-sm">
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
      <PlotlyChart
        data={[{
          type: "scatter",
          mode: "lines",
          name: `${series.find(s=>s.id===a)?.name} vs ${series.find(s=>s.id===b)?.name}`,
          x: aligned.dates,
          y: rc,
          hovertemplate: "%{x|%Y-%m} · %{y:.3f}<extra></extra>",
        }]}
        layout={{
          title: `Rolling correlation ${window}m`,
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
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="border rounded p-3 bg-zinc-50">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-xl font-semibold tabular-nums">
        {value == null ? "—" : value.toFixed(3)}
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

function ReturnsTable({
  series,
  aligned,
}: {
  series: SeriesData[];
  aligned: ReturnType<typeof alignSeries>;
}) {
  const last24 = aligned.dates.slice(-24);
  const start = aligned.dates.length - last24.length;
  return (
    <div className="overflow-x-auto mt-2 border rounded">
      <table className="text-[11px] tabular-nums">
        <thead className="bg-zinc-100">
          <tr>
            <th className="px-2 py-1 text-left">Fecha</th>
            {series.map((s) => (
              <th key={s.id} className="px-2 py-1 text-right whitespace-nowrap">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {last24.map((d, idx) => (
            <tr key={d} className="border-t">
              <td className="px-2 py-0.5">{d}</td>
              {series.map((s) => {
                const v = aligned.byId[s.id][start + idx];
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
      <p className="text-[11px] text-zinc-500 p-2">
        Últimos 24 meses · histórico completo en la API.
      </p>
    </div>
  );
}
