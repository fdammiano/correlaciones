"use client";

// ── Monitor de relaciones (long-short) ──────────────────────────────────────
// Debajo del Monitor de correlaciones. La idea: definir "relaciones" long/short
// (una pierna long y otra short, cada una puede ser un factor suelto o una
// cartera ya armada) y RESTARLAS de forma compuesta, mes a mes:
//     spread(t) = (1+r_long)/(1+r_short) − 1        ( ≈ r_long − r_short )
// Es la resta de tasas hecha como corresponde (compuesta), NO una división de
// niveles/precios: el resultado es el retorno mensual de estar long una pierna
// y short la otra, financiado 1:1. El acumulado de ese spread (Base 100)
// muestra la performance relativa en el tiempo. La tabla monitorea cuándo una
// relación "se rompe" con 3 señales simultáneas + un semáforo combinado:
//   1) Tendencia vs media móvil del acumulado (cruce reciente = quiebre).
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

const SIGNAL_TEXT: Record<Signal, string> = { ok: "text-emerald-700", warn: "text-amber-600", break: "text-red-600" };
const SIGNAL_CHIP: Record<Signal, string> = {
  ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
  warn: "bg-amber-50 text-amber-700 border-amber-200",
  break: "bg-red-50 text-red-700 border-red-200",
};

// Chip de texto (reemplaza los puntitos de color: dice qué pasa, no sólo el color).
function Chip({ signal, title, children }: { signal: Signal; title?: string; children: React.ReactNode }) {
  return (
    <span
      title={title}
      className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold leading-none ${SIGNAL_CHIP[signal]}`}
    >
      {children}
    </span>
  );
}

const RECENT_LABEL: Record<Signal, string> = { ok: "Confirma", warn: "Se debilita", break: "Se dio vuelta" };
const VERDICT_LABEL: Record<Signal, string> = { ok: "En pie", warn: "Atención", break: "Quiebre" };

type RelStats = {
  ok: boolean;
  n: number;
  level: number | null; // último valor del acumulado (Base 100)
  accum: number | null; // spread acumulado total en % desde el inicio
  from: string | null; // primera fecha con datos en común
  baseAnn: number | null; // retorno anualizado del spread (todo el historial)
  recentAnn: number | null; // retorno anualizado del spread reciente
  aboveMA: boolean | null;
  crossed: boolean; // hubo cruce del ratio con su MA dentro de la ventana reciente
  z: number | null;
  sTrend: Signal;
  sRecent: Signal;
  sZ: Signal;
  verdict: Signal;
  line: number[]; // spread acumulado, Base 100
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
    ok: false, n: 0, level: null, accum: null, from: null, baseAnn: null, recentAnn: null,
    aboveMA: null, crossed: false, z: null,
    sTrend: "ok", sRecent: "ok", sZ: "ok", verdict: "ok",
    line: [], ma: [], dates: [],
  };
  if (!long || !short) return empty;

  // Resta COMPUESTA mes a mes: (1+r_long)/(1+r_short) − 1 (intersección de fechas).
  // `operate({type:"ratio"})` es exactamente esa resta compuesta de tasas, no una
  // división de niveles ni de precios.
  const spread = operate({ type: "ratio", a: long, b: short });
  if (spread.length < 3) return { ...empty, n: spread.length };

  // Spread acumulado Base 100 (performance relativa long vs short).
  const wealth = cumulativeWealth(spread, 100);
  const dates = wealth.map((p) => p.date);
  const line = wealth.map((p) => p.value);
  const ma = sma(line, maWindow);

  const level = line.at(-1) ?? null;
  const accum = level != null ? level / 100 - 1 : null;
  const from = dates[0] ?? null;
  const lastMa = ma.at(-1) ?? null;
  const aboveMA = level != null && lastMa != null ? level >= lastMa : null;

  // Cruce del acumulado con su MA dentro de la ventana reciente → quiebre de tendencia.
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
    ok: true, n: spread.length, level, accum, from, baseAnn, recentAnn,
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
          Cada relación es la <b>resta compuesta</b> de las dos piernas, mes a mes:{" "}
          <span className="font-mono text-zinc-600">spread = (1+r<sub>long</sub>)/(1+r<sub>short</sub>) − 1</span>{" "}
          — la resta de tasas hecha como corresponde (compuesta), <b>no</b> una división de niveles ni de precios. Es el
          retorno de estar long una pierna y short la otra, financiado 1:1. Ese spread se acumula en Base 100: si sube,
          el <b className="text-emerald-700">long</b> le gana al <b className="text-red-600">short</b>.
        </p>

        <details className="rounded border border-brand-200 bg-white/70">
          <summary className="cursor-pointer select-none px-3 py-1.5 text-[11px] font-semibold text-brand-800">
            ¿Cómo leo cada columna?
          </summary>
          <div className="px-3 pb-2.5 pt-0.5 text-[11px] text-zinc-600 leading-relaxed space-y-1">
            <p><b>Acumulado</b> — cuánto rindió el spread desde el primer mes en común de las dos piernas. +50% = la pata long le ganó 50% acumulado a la short. Entre paréntesis, el nivel Base 100 (arranca en 100).</p>
            <p><b>Spread hist. (a/a)</b> — ese mismo spread pero anualizado sobre <i>toda</i> la historia. Es el “rendimiento normal” de la relación: cuánto le suele ganar el long al short por año.</p>
            <p><b>Spread {recentMonths}m (a/a)</b> — lo mismo pero sólo con los últimos {recentMonths} meses, anualizado. Sirve para comparar contra la columna anterior: es lo que está pasando <i>ahora</i>.</p>
            <p><b>Tendencia</b> — dónde está el acumulado respecto de su media móvil de {maWindow}m. ▲ arriba (la relación sigue funcionando), ▼ abajo. Si dice <b>cruce</b>, atravesó la media dentro de los últimos {recentMonths} meses: cambio de régimen.</p>
            <p><b>Reciente vs hist.</b> — compara las dos columnas de spread: <i>Confirma</i> si el reciente va en el mismo sentido y con fuerza parecida al histórico, <i>Se debilita</i> si conserva el signo pero rinde menos de la mitad, <i>Se dio vuelta</i> si cambió de signo (el short le está ganando al long cuando históricamente perdía, o al revés).</p>
            <p><b>Z</b> — cuántos desvíos estándar se apartó el spread mensual promedio de los últimos {recentMonths}m respecto de su media histórica. |z| ≥ 1 llama la atención, |z| ≥ {zThreshold} es un extremo estadístico (o quiebre, o punto de reversión).</p>
            <p><b>Estado</b> — resumen de las tres señales: <i>Quiebre</i> con 2+ en rojo, <i>Atención</i> con 1 roja o 2 naranjas, <i>En pie</i> el resto.</p>
          </div>
        </details>

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
                    <th className={th}>Relación (Long − Short, compuesta)</th>
                    <th className={`${th} text-right`} title="Spread compuesto acumulado desde el primer mes en común (y nivel Base 100)">
                      Acumulado
                    </th>
                    <th className={`${th} text-right`} title="Spread compuesto anualizado sobre toda la historia">
                      Spread hist. (a/a)
                    </th>
                    <th className={`${th} text-right`} title={`Spread compuesto anualizado de los últimos ${recentMonths} meses`}>
                      Spread {recentMonths}m (a/a)
                    </th>
                    <th className={`${th} text-center`} title={`Acumulado vs su media móvil de ${maWindow}m (cruce dentro de los últimos ${recentMonths}m = quiebre)`}>
                      Tendencia
                    </th>
                    <th className={`${th} text-center`} title="Compara el spread reciente con el histórico: mismo signo y fuerza / se debilita / signo opuesto">
                      Reciente vs hist.
                    </th>
                    <th className={`${th} text-center`} title={`Desvíos del spread promedio de los últimos ${recentMonths}m vs su media histórica`}>
                      Z
                    </th>
                    <th className={`${th} text-center`} title="Resumen de las 3 señales">Estado</th>
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
                          <span className="text-zinc-400"> − </span>
                          <span className="text-red-600 font-medium">{short?.name ?? "?"}</span>
                          {!stats.ok && <span className="ml-1 text-[10px] text-zinc-400">(sin datos)</span>}
                        </td>
                        <td
                          className={`${td} text-right ${stats.accum != null && stats.accum < 0 ? "text-red-600" : "text-zinc-800"}`}
                          title={stats.from ? `Desde ${stats.from} · ${stats.n} meses en común` : undefined}
                        >
                          {fmtPct(stats.accum)}
                          <span className="ml-1 text-[10px] text-zinc-400">({fmtNum(stats.level, 1)})</span>
                        </td>
                        <td className={`${td} text-right ${stats.baseAnn != null && stats.baseAnn < 0 ? "text-red-600" : "text-zinc-800"}`}>
                          {fmtPct(stats.baseAnn)}
                        </td>
                        <td className={`${td} text-right ${stats.recentAnn != null && stats.recentAnn < 0 ? "text-red-600" : "text-zinc-800"}`}>
                          {fmtPct(stats.recentAnn)}
                        </td>
                        <td className={`${td} text-center`}>
                          {stats.aboveMA == null ? (
                            <span className="text-zinc-400">—</span>
                          ) : (
                            <Chip
                              signal={stats.sTrend}
                              title={
                                (stats.aboveMA ? `Acumulado por encima de su MA ${maWindow}m` : `Acumulado por debajo de su MA ${maWindow}m`) +
                                (stats.crossed ? ` · cruzó la media en los últimos ${recentMonths}m` : "")
                              }
                            >
                              {stats.aboveMA ? "▲ arriba" : "▼ abajo"}
                              {stats.crossed ? " · cruce" : ""}
                            </Chip>
                          )}
                        </td>
                        <td className={`${td} text-center`}>
                          <Chip signal={stats.sRecent}>{RECENT_LABEL[stats.sRecent]}</Chip>
                        </td>
                        <td className={`${td} text-center ${SIGNAL_TEXT[stats.sZ]}`}>{fmtNum(stats.z, 1)}</td>
                        <td className={`${td} text-center`}>
                          <Chip signal={stats.verdict}>{VERDICT_LABEL[stats.verdict]}</Chip>
                        </td>
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
                  <span className="text-zinc-400"> − </span>
                  <span className="text-red-600 font-semibold">{selected.short?.name}</span>
                  {" "}· spread compuesto acumulado (Base 100) con media móvil {maWindow}m
                </p>
                <PlotlyChart
                  data={[
                    {
                      type: "scatter",
                      mode: "lines",
                      name: "Spread acumulado (Base 100)",
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
                    yaxis: { title: "Spread acumulado (Base 100)" },
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
              <b>Verde</b> = la relación funciona como históricamente · <b>naranja</b> = se está debilitando ·{" "}
              <b>rojo</b> = quiebre. <b>Tendencia</b>: ▲ el acumulado está sobre su MA {maWindow}m, ▼ debajo;{" "}
              <i>cruce</i> = la atravesó en los últimos {recentMonths}m. <b>Z</b>: naranja |z|≥1 · rojo |z|≥{zThreshold}.{" "}
              El detalle de cada columna está arriba, en “¿Cómo leo cada columna?”.
            </p>
          </>
        )}
      </div>
    </details>
  );
}
