"use client";

// ── Monitor de relaciones (long-short) ──────────────────────────────────────
// Debajo del Monitor de correlaciones. La idea: definir "relaciones" long/short
// (una pierna long y otra short, cada una puede ser un factor suelto o una
// cartera ya armada) y restarlas de forma COMPUESTA: ratio = (1+r_long)/(1+r_short)−1.
// El acumulado de ese ratio (Base 100) muestra la performance relativa en el
// tiempo. La tabla monitorea cuándo una relación "se rompe" con 3 señales
// simultáneas + un semáforo combinado:
//   1) Tendencia vs media móvil del ratio (cruce reciente = quiebre).
//   2) Reciente vs histórico (retorno anualizado del spread; signo opuesto = quiebre).
//   3) Z-score del movimiento reciente vs su historia (|z| grande = extremo).

import { useEffect, useMemo, useState } from "react";
import PlotlyChart from "./PlotlyChart";
import { operate } from "@/lib/operations";
import { cumulativeWealth, summarize } from "@/lib/metrics";
import type { SeriesData } from "@/lib/types";

const RELATIONS_KEY = "correlations-app:relations:v1";

type Relation = { id: string; longId: string; shortId: string };

type Signal = "ok" | "warn" | "break";

// Media móvil simple (trailing) sobre valores; null hasta tener `window` puntos.
function sma(values: (number | null)[], window: number): (number | null)[] {
  const out: (number | null)[] = [];
  const buf: number[] = [];
  let sum = 0;
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

function fmtPct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
}
function fmtNum(v: number | null, d = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(d);
}

const SIGNAL_DOT: Record<Signal, string> = { ok: "🟢", warn: "🟠", break: "🔴" };
const SIGNAL_TEXT: Record<Signal, string> = { ok: "text-emerald-700", warn: "text-amber-600", break: "text-red-600" };

type RelStats = {
  ok: boolean;
  n: number;
  ratioNow: number | null; // Base 100 del ratio (último)
  baseAnn: number | null; // retorno anualizado del spread (todo el historial)
  recentAnn: number | null; // retorno anualizado del spread reciente
  aboveMA: boolean | null;
  crossed: boolean; // hubo cruce del ratio con su MA dentro de la ventana reciente
  z: number | null;
  sTrend: Signal;
  sRecent: Signal;
  sZ: Signal;
  verdict: Signal;
  line: number[]; // ratio Base 100
  ma: (number | null)[];
  dates: string[];
};

function computeRelation(
  long: SeriesData | undefined,
  short: SeriesData | undefined,
  recentMonths: number,
  maWindow: number,
  zThreshold: number,
): RelStats {
  const empty: RelStats = {
    ok: false, n: 0, ratioNow: null, baseAnn: null, recentAnn: null,
    aboveMA: null, crossed: false, z: null,
    sTrend: "ok", sRecent: "ok", sZ: "ok", verdict: "ok",
    line: [], ma: [], dates: [],
  };
  if (!long || !short) return empty;

  // Spread compuesto mensual: (1+r_long)/(1+r_short) − 1 (intersección de fechas).
  const spread = operate({ type: "ratio", a: long, b: short });
  if (spread.length < 3) return { ...empty, n: spread.length };

  // Ratio acumulado Base 100 (performance relativa long vs short).
  const wealth = cumulativeWealth(spread, 100);
  const dates = wealth.map((p) => p.date);
  const line = wealth.map((p) => p.value);
  const ma = sma(line, maWindow);

  const ratioNow = line.at(-1) ?? null;
  const lastMa = ma.at(-1) ?? null;
  const aboveMA = ratioNow != null && lastMa != null ? ratioNow >= lastMa : null;

  // Cruce del ratio con su MA dentro de la ventana reciente → quiebre de tendencia.
  let crossed = false;
  let lastSign: number | null = null;
  const startCross = Math.max(0, line.length - recentMonths);
  for (let i = startCross; i < line.length; i++) {
    const m = ma[i];
    if (m == null) continue;
    const s = Math.sign(line[i] - m);
    if (s === 0) continue;
    if (lastSign !== null && s !== lastSign) crossed = true;
    lastSign = s;
  }

  // Retornos anualizados del spread: todo vs reciente.
  const vals = spread.map((r) => r.value);
  const full = summarize(spread);
  const recentSlice = spread.slice(-Math.min(recentMonths, spread.length));
  const rec = summarize(recentSlice);
  const baseAnn = full.annualReturn;
  const recentAnn = rec.annualReturn;

  // Z-score: media mensual reciente vs media/desvío histórico.
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, vals.length - 1);
  const sd = Math.sqrt(variance);
  const recentVals = recentSlice.map((r) => r.value);
  const recentMean = recentVals.reduce((s, v) => s + v, 0) / Math.max(1, recentVals.length);
  const z = sd > 0 ? (recentMean - mean) / sd : null;

  // ── Señales ──
  // 1) Tendencia vs MA
  let sTrend: Signal = "ok";
  if (crossed) sTrend = "break";
  else if (aboveMA === false) sTrend = "warn";
  else sTrend = "ok";

  // 2) Reciente vs histórico
  let sRecent: Signal = "ok";
  if (baseAnn != null && recentAnn != null) {
    const opposite = Math.sign(recentAnn) !== 0 && Math.sign(baseAnn) !== 0 && Math.sign(recentAnn) !== Math.sign(baseAnn);
    const weakening = Math.abs(recentAnn) < 0.5 * Math.abs(baseAnn);
    if (opposite) sRecent = "break";
    else if (weakening) sRecent = "warn";
    else sRecent = "ok";
  }

  // 3) Z-score
  let sZ: Signal = "ok";
  if (z != null) {
    const az = Math.abs(z);
    if (az >= zThreshold) sZ = "break";
    else if (az >= 1) sZ = "warn";
    else sZ = "ok";
  }

  // Combinado
  const reds = [sTrend, sRecent, sZ].filter((s) => s === "break").length;
  const oranges = [sTrend, sRecent, sZ].filter((s) => s === "warn").length;
  let verdict: Signal = "ok";
  if (reds >= 2) verdict = "break";
  else if (reds === 1 || oranges >= 2) verdict = "warn";
  else verdict = "ok";

  return {
    ok: true, n: spread.length, ratioNow, baseAnn, recentAnn,
    aboveMA, crossed, z, sTrend, sRecent, sZ, verdict, line, ma, dates,
  };
}

export default function RelationMonitor({
  activeSeries,
  library,
}: {
  activeSeries: SeriesData[];
  library: SeriesData[];
}) {
  const pool = library.length ? library : activeSeries;
  const byId = useMemo(() => new Map(pool.map((s) => [s.id, s])), [pool]);

  const [relations, setRelations] = useState<Relation[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [longSel, setLongSel] = useState("");
  const [shortSel, setShortSel] = useState("");

  const [recentMonths, setRecentMonths] = useState(6);
  const [maWindow, setMaWindow] = useState(12);
  const [zThreshold, setZThreshold] = useState(2);

  // Cargar relaciones guardadas.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RELATIONS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setRelations(parsed);
      }
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, []);

  // Guardar.
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(RELATIONS_KEY, JSON.stringify(relations));
    } catch {
      /* ignore */
    }
  }, [relations, hydrated]);

  // Defaults del formulario de alta.
  useEffect(() => {
    if (!longSel && pool[0]) setLongSel(pool[0].id);
    if (!shortSel && pool[1]) setShortSel(pool[1].id);
  }, [pool, longSel, shortSel]);

  const rows = useMemo(
    () =>
      relations.map((rel) => ({
        rel,
        long: byId.get(rel.longId),
        short: byId.get(rel.shortId),
        stats: computeRelation(byId.get(rel.longId), byId.get(rel.shortId), recentMonths, maWindow, zThreshold),
      })),
    [relations, byId, recentMonths, maWindow, zThreshold],
  );

  const selected = rows.find((r) => r.rel.id === selectedId) || rows[0] || null;

  function addRelation() {
    if (!longSel || !shortSel || longSel === shortSel) return;
    const id = `r-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setRelations((prev) => [...prev, { id, longId: longSel, shortId: shortSel }]);
    setSelectedId(id);
  }
  function removeRelation(id: string) {
    setRelations((prev) => prev.filter((r) => r.id !== id));
  }

  const th = "px-2 py-1.5 text-[11px] font-semibold text-zinc-600 whitespace-nowrap";
  const td = "px-2 py-1.5 text-[12px] tabular-nums whitespace-nowrap";

  return (
    <details open className="mb-6 rounded-lg border border-brand-200 bg-brand-50/40">
      <summary className="cursor-pointer select-none px-4 py-2.5 flex items-center gap-2">
        <span className="text-sm font-semibold text-brand-800">🔗 Monitor de relaciones (long-short)</span>
        <span className="text-[11px] text-zinc-500">
          {relations.length} {relations.length === 1 ? "relación" : "relaciones"} · reciente {recentMonths}m · MA {maWindow}m
        </span>
      </summary>

      <div className="px-4 pb-4 pt-1 space-y-3">
        <p className="text-[11px] text-zinc-500 leading-relaxed">
          Cada relación es un <b>ratio compuesto</b> long ÷ short: (1+r<sub>long</sub>)/(1+r<sub>short</sub>)−1, acumulado en Base 100.
          Si sube, el <b>long</b> le gana al <b>short</b>. Las columnas monitorean cuándo la relación se rompe.
        </p>

        {/* Controles globales */}
        <div className="flex flex-wrap items-end gap-3 text-sm border-b border-brand-200 pb-3">
          <div>
            <label className="block text-[11px] text-zinc-600 mb-1">Ventana reciente</label>
            <select
              value={recentMonths}
              onChange={(e) => setRecentMonths(Number(e.target.value))}
              className="border border-zinc-300 rounded px-2 py-1 bg-white text-sm"
            >
              {[3, 6, 9, 12, 18, 24].map((n) => (
                <option key={n} value={n}>{n} meses</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-zinc-600 mb-1">Media móvil (ratio)</label>
            <select
              value={maWindow}
              onChange={(e) => setMaWindow(Number(e.target.value))}
              className="border border-zinc-300 rounded px-2 py-1 bg-white text-sm"
            >
              {[6, 12, 24, 36].map((n) => (
                <option key={n} value={n}>{n} meses</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-zinc-600 mb-1">Umbral z-score</label>
            <select
              value={zThreshold}
              onChange={(e) => setZThreshold(Number(e.target.value))}
              className="border border-zinc-300 rounded px-2 py-1 bg-white text-sm"
            >
              {[1.5, 2, 2.5, 3].map((n) => (
                <option key={n} value={n}>|z| ≥ {n}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Alta de relación */}
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <div>
            <label className="block text-[11px] text-emerald-700 font-semibold mb-1">Long</label>
            <select
              value={longSel}
              onChange={(e) => setLongSel(e.target.value)}
              className="border border-zinc-300 rounded px-2 py-1 bg-white min-w-[200px] max-w-[260px]"
            >
              {pool.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div className="text-zinc-400 pb-1.5 text-base">−</div>
          <div>
            <label className="block text-[11px] text-red-600 font-semibold mb-1">Short</label>
            <select
              value={shortSel}
              onChange={(e) => setShortSel(e.target.value)}
              className="border border-zinc-300 rounded px-2 py-1 bg-white min-w-[200px] max-w-[260px]"
            >
              {pool.filter((s) => s.id !== longSel).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <button
            onClick={addRelation}
            disabled={!longSel || !shortSel || longSel === shortSel}
            className="rounded bg-brand-700 text-white px-3 py-1.5 text-xs font-semibold hover:bg-brand-800 disabled:opacity-40"
          >
            + Agregar relación
          </button>
        </div>

        {relations.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 bg-white px-4 py-6 text-center text-sm text-zinc-500">
            Todavía no hay relaciones. Elegí una pierna <b className="text-emerald-700">long</b> y una{" "}
            <b className="text-red-600">short</b> arriba y agregala. Tip: si querés una canasta, armala primero en el
            Constructor de Cartera y después elegila acá como pierna.
          </div>
        ) : (
          <>
            {/* Tabla de relaciones */}
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-brand-200 text-left">
                    <th className={th}>Relación (Long ÷ Short)</th>
                    <th className={`${th} text-right`}>Ratio</th>
                    <th className={`${th} text-right`}>Base (a/a)</th>
                    <th className={`${th} text-right`}>Reciente (a/a)</th>
                    <th className={`${th} text-center`} title="Tendencia del ratio vs su media móvil (cruce reciente = quiebre)">Tend.</th>
                    <th className={`${th} text-center`} title="Retorno reciente vs histórico (signo opuesto = quiebre)">Rec/Hist</th>
                    <th className={`${th} text-center`} title="Cuántos desvíos se movió el spread reciente vs su historia">Z</th>
                    <th className={`${th} text-center`} title="Semáforo combinado de las 3 señales">Quiebre</th>
                    <th className={th}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ rel, long, short, stats }) => {
                    const isSel = selected?.rel.id === rel.id;
                    return (
                      <tr
                        key={rel.id}
                        onClick={() => setSelectedId(rel.id)}
                        className={`border-b border-brand-100 cursor-pointer hover:bg-white ${isSel ? "bg-white" : ""}`}
                      >
                        <td className={`${td} whitespace-normal`}>
                          <span className="text-emerald-700 font-medium">{long?.name ?? "?"}</span>
                          <span className="text-zinc-400"> ÷ </span>
                          <span className="text-red-600 font-medium">{short?.name ?? "?"}</span>
                          {!stats.ok && <span className="ml-1 text-[10px] text-zinc-400">(sin datos)</span>}
                        </td>
                        <td className={`${td} text-right`}>{fmtNum(stats.ratioNow, 1)}</td>
                        <td className={`${td} text-right ${stats.baseAnn != null && stats.baseAnn < 0 ? "text-red-600" : "text-zinc-800"}`}>
                          {fmtPct(stats.baseAnn)}
                        </td>
                        <td className={`${td} text-right ${stats.recentAnn != null && stats.recentAnn < 0 ? "text-red-600" : "text-zinc-800"}`}>
                          {fmtPct(stats.recentAnn)}
                        </td>
                        <td className={`${td} text-center`}>
                          <span className={SIGNAL_TEXT[stats.sTrend]}>
                            {stats.aboveMA == null ? "—" : stats.aboveMA ? "▲" : "▼"}
                            {stats.crossed ? " ⚡" : ""}
                          </span>
                        </td>
                        <td className={`${td} text-center`}>{SIGNAL_DOT[stats.sRecent]}</td>
                        <td className={`${td} text-center ${SIGNAL_TEXT[stats.sZ]}`}>{fmtNum(stats.z, 1)}</td>
                        <td className={`${td} text-center`}>{SIGNAL_DOT[stats.verdict]}</td>
                        <td className={`${td} text-right`}>
                          <button
                            onClick={(e) => { e.stopPropagation(); removeRelation(rel.id); }}
                            className="text-zinc-400 hover:text-red-600 text-xs"
                            title="Quitar relación"
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Gráfico de la relación seleccionada: ratio Base 100 + media móvil */}
            {selected && selected.stats.ok && (
              <div className="pt-1">
                <p className="text-xs text-zinc-600 mb-1">
                  <span className="text-emerald-700 font-semibold">{selected.long?.name}</span>
                  <span className="text-zinc-400"> ÷ </span>
                  <span className="text-red-600 font-semibold">{selected.short?.name}</span>
                  {" "}· ratio compuesto Base 100 con media móvil {maWindow}m
                </p>
                <PlotlyChart
                  data={[
                    {
                      type: "scatter",
                      mode: "lines",
                      name: "Ratio (Base 100)",
                      x: selected.stats.dates,
                      y: selected.stats.line,
                      line: { color: "#1f3a59", width: 2 },
                      hovertemplate: "%{x|%Y-%m} · %{y:.1f}<extra></extra>",
                    },
                    {
                      type: "scatter",
                      mode: "lines",
                      name: `MA ${maWindow}m`,
                      x: selected.stats.dates,
                      y: selected.stats.ma,
                      line: { color: "#c79a3a", width: 1.5, dash: "dash" },
                      hovertemplate: "%{x|%Y-%m} · %{y:.1f}<extra></extra>",
                    },
                  ]}
                  layout={{
                    yaxis: { title: "Ratio (Base 100)" },
                    xaxis: { title: "Fecha" },
                    legend: { orientation: "h", y: -0.18 },
                    shapes: [
                      {
                        type: "line",
                        xref: "paper",
                        x0: 0,
                        x1: 1,
                        y0: 100,
                        y1: 100,
                        line: { color: "#9ca3af", width: 1, dash: "dot" },
                      },
                    ],
                  }}
                  height={420}
                />
              </div>
            )}

            {/* Leyenda */}
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              <b>Tend.</b>: ▲ el ratio está sobre su media móvil, ▼ debajo; <b>⚡</b> = cruzó dentro de la ventana reciente (quiebre de tendencia).{" "}
              <b>Rec/Hist</b>: 🟢 el reciente confirma al histórico · 🟠 se debilita · 🔴 signo opuesto.{" "}
              <b>Z</b>: desvíos del movimiento reciente vs su historia (🟠 |z|≥1 · 🔴 |z|≥{zThreshold}).{" "}
              <b>Quiebre</b>: semáforo combinado (🔴 = 2+ señales en rojo · 🟠 = 1 roja o 2 naranjas).
            </p>
          </>
        )}
      </div>
    </details>
  );
}
