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

import { useEffect, useMemo, useRef, useState } from "react";
import PlotlyChart from "./PlotlyChart";
import { operate } from "@/lib/operations";
import { cumulativeWealth, summarize } from "@/lib/metrics";
import { useRelations } from "@/lib/relations";
import {
  DEFAULT_ROC_WINDOWS,
  fmtMonth,
  headlines,
  rocRank,
  rocSeries,
  structure,
  zigzag,
  type Swing,
} from "@/lib/signals";
import type { SeriesData } from "@/lib/types";

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
const Z_LABEL: Record<Signal, string> = { ok: "normal", warn: "alto", break: "extremo" };

// Encabezado de dos líneas: arriba el nombre en castellano llano, abajo la
// unidad / definición corta. Así la columna se entiende sin pasar el mouse.
function Th({
  children,
  sub,
  align = "left",
  title,
}: {
  children: React.ReactNode;
  sub?: string;
  align?: "left" | "right" | "center";
  title?: string;
}) {
  const a = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return (
    <th title={title} className={`px-2 py-1.5 align-bottom ${a}`}>
      <div className="text-[11px] font-semibold text-zinc-700 whitespace-nowrap">{children}</div>
      {sub && <div className="text-[10px] font-normal text-zinc-400 whitespace-nowrap">{sub}</div>}
    </th>
  );
}

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

  // Las relaciones son estado compartido: el Radar también las agrega.
  const { relations, add, remove } = useRelations();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [longSel, setLongSel] = useState("");
  const [shortSel, setShortSel] = useState("");

  const [recentMonths, setRecentMonths] = useState(6);
  const [maWindow, setMaWindow] = useState(12);
  const [zThreshold, setZThreshold] = useState(2);
  const [zigThr, setZigThr] = useState(0.1);
  const [rocK, setRocK] = useState(2);

  // Si aparece una relación nueva (típicamente agregada desde el Radar), pasa
  // a ser la seleccionada para que su gráfico se vea sin buscarla.
  const prevCount = useRef(0);
  useEffect(() => {
    if (relations.length > prevCount.current && relations.length > 0) {
      setSelectedId(relations[relations.length - 1].id);
    }
    prevCount.current = relations.length;
  }, [relations]);

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

  // ── Detección sobre la relación seleccionada ──
  // Zigzag de quiebres, titulares y ranking del ROC contra toda la historia.
  const detect = useMemo(() => {
    const st = selected?.stats;
    if (!st?.ok || st.line.length < 6) return null;
    const { line, dates } = st;
    const zz = zigzag(line, dates, zigThr);
    const marks: Swing[] = zz.pending ? [...zz.swings, zz.pending] : zz.swings;

    // Piernas alcistas y bajistas como dos traces con nulls entre segmentos
    // (así se colorea por dirección sin generar cientos de traces).
    const pts = [{ i: 0, value: line[0] }, ...marks.map((s) => ({ i: s.i, value: s.value }))];
    if (pts.at(-1)!.i !== line.length - 1) pts.push({ i: line.length - 1, value: line.at(-1)! });
    const upX: (string | null)[] = [];
    const upY: (number | null)[] = [];
    const dnX: (string | null)[] = [];
    const dnY: (number | null)[] = [];
    for (let s = 0; s < pts.length - 1; s++) {
      const from = pts[s];
      const to = pts[s + 1];
      const rising = to.value >= from.value;
      const X = rising ? upX : dnX;
      const Y = rising ? upY : dnY;
      for (let i = from.i; i <= to.i; i++) {
        X.push(dates[i]);
        Y.push(line[i]);
      }
      X.push(null);
      Y.push(null);
    }

    return {
      zz,
      marks: marks.slice(-14), // etiquetar sólo los últimos quiebres, para que se lea
      upX, upY, dnX, dnY,
      roc: rocSeries(line, rocK),
      ranks: DEFAULT_ROC_WINDOWS.map((k) => rocRank(line, dates, k)),
      current: rocRank(line, dates, rocK),
      struct: structure(line, dates, zigThr),
      heads: headlines(line, dates, { thr: zigThr }),
      dates,
    };
  }, [selected, zigThr, rocK]);

  function addRelation() {
    const id = add(longSel, shortSel);
    if (id) setSelectedId(id);
  }
  function removeRelation(id: string) {
    remove(id);
  }

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
          <div className="px-3 pb-2.5 pt-0.5 text-[11px] text-zinc-600 leading-relaxed space-y-1.5">
            <p className="text-zinc-400 uppercase tracking-wide text-[10px] font-semibold pt-0.5">Cuánto le gana el long al short</p>
            <p><b>Acumulado</b> — cuánto rindió el spread en total, desde el primer mes en que las dos piernas tienen datos (la fecha aparece abajo del número). +50% = el long le ganó 50% acumulado al short.</p>
            <p><b>Normal</b> — el mismo spread anualizado sobre <i>toda</i> la historia: cuánto le gana el long al short en un año típico. Es la vara contra la cual se compara todo lo demás.</p>
            <p><b>Ahora</b> — el spread de los últimos {recentMonths} meses, anualizado para que sea comparable con <i>Normal</i>. Si <i>Ahora</i> es −10% y <i>Normal</i> +1%, la relación está haciendo lo contrario de lo habitual.</p>

            <p className="text-zinc-400 uppercase tracking-wide text-[10px] font-semibold pt-1.5">¿Sigue funcionando la relación?</p>
            <p><b>Tendencia</b> — dónde está el acumulado respecto de su media móvil de {maWindow}m: <i>▲ arriba</i> = la relación sigue su curso, <i>▼ abajo</i> = perdió impulso. Si además dice <i>cruce</i>, atravesó la media dentro de los últimos {recentMonths} meses → posible cambio de régimen.</p>
            <p><b>Consistencia</b> — compara <i>Ahora</i> contra <i>Normal</i>: <i>Confirma</i> = mismo signo y fuerza parecida · <i>Se debilita</i> = mismo signo pero menos de la mitad · <i>Se dio vuelta</i> = signo opuesto (el short le está ganando al long cuando históricamente perdía, o al revés).</p>
            <p><b>Qué tan extremo</b> — z: cuántos desvíos estándar se apartó el spread mensual promedio de los últimos {recentMonths}m de su media histórica. <i>normal</i> = |z| &lt; 1 · <i>alto</i> = |z| ≥ 1 · <i>extremo</i> = |z| ≥ {zThreshold} (o quiebre real, o punto de reversión).</p>
            <p><b>Estado</b> — resume las tres señales de esta sección: <i>Quiebre</i> con 2 o más en rojo · <i>Atención</i> con 1 roja o 2 naranjas · <i>En pie</i> el resto.</p>
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
                  {/* Fila de grupos: separa "cuánto rindió" de "se está rompiendo". */}
                  <tr className="text-left">
                    <th />
                    <th
                      colSpan={3}
                      className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 border-b border-zinc-200 text-center"
                    >
                      Cuánto le gana el long al short
                    </th>
                    <th
                      colSpan={4}
                      className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 border-b border-zinc-200 text-center"
                    >
                      ¿Sigue funcionando la relación?
                    </th>
                    <th />
                  </tr>
                  <tr className="border-b border-brand-200">
                    <Th sub="resta compuesta, mes a mes">Relación</Th>
                    <Th align="right" sub="total, desde que hay datos" title="Spread compuesto acumulado desde el primer mes en común de las dos piernas. Entre paréntesis, el nivel Base 100.">
                      Acumulado
                    </Th>
                    <Th align="right" sub="% por año, toda la historia" title="El mismo spread pero anualizado sobre toda la historia en común: el rendimiento 'normal' de la relación.">
                      Normal
                    </Th>
                    <Th align="right" sub={`% por año, últimos ${recentMonths}m`} title={`El spread de los últimos ${recentMonths} meses, anualizado para poder compararlo con la columna Normal.`}>
                      Ahora
                    </Th>
                    <Th align="center" sub={`vs media móvil ${maWindow}m`} title={`Si el acumulado está por encima o por debajo de su media móvil de ${maWindow} meses, y si la cruzó dentro de los últimos ${recentMonths} meses.`}>
                      Tendencia
                    </Th>
                    <Th align="center" sub="Ahora vs Normal" title="Compara las dos columnas anteriores: mismo signo y fuerza parecida (Confirma), mismo signo pero menos de la mitad (Se debilita), signo opuesto (Se dio vuelta).">
                      Consistencia
                    </Th>
                    <Th align="center" sub="desvíos vs su historia" title={`Cuántos desvíos estándar se apartó el spread mensual promedio de los últimos ${recentMonths}m respecto de su media histórica.`}>
                      Qué tan extremo
                    </Th>
                    <Th align="center" sub="resumen de las 3 señales" title="Quiebre = 2 o más señales en rojo · Atención = 1 roja o 2 naranjas · En pie = el resto.">
                      Estado
                    </Th>
                    <th />
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
                          className={`${td} text-right`}
                          title={stats.from ? `Desde ${stats.from} · ${stats.n} meses en común · Base 100 = ${fmtNum(stats.level, 1)}` : undefined}
                        >
                          <div className={stats.accum != null && stats.accum < 0 ? "text-red-600" : "text-zinc-800"}>
                            {fmtPct(stats.accum)}
                          </div>
                          {stats.from && (
                            <div className="text-[10px] text-zinc-400">desde {stats.from.slice(0, 7)}</div>
                          )}
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
                          <Chip
                            signal={stats.sRecent}
                            title={
                              stats.sRecent === "ok"
                                ? "El spread reciente va en el mismo sentido y con fuerza parecida al histórico."
                                : stats.sRecent === "warn"
                                ? "Mismo signo que el histórico, pero rindiendo menos de la mitad."
                                : "El spread reciente cambió de signo respecto del histórico."
                            }
                          >
                            {RECENT_LABEL[stats.sRecent]}
                          </Chip>
                        </td>
                        <td className={`${td} text-center`}>
                          <div className={SIGNAL_TEXT[stats.sZ]}>
                            {stats.z == null ? "—" : `z = ${fmtNum(stats.z, 1)}`}
                          </div>
                          {stats.z != null && (
                            <div className={`text-[10px] ${SIGNAL_TEXT[stats.sZ]}`}>{Z_LABEL[stats.sZ]}</div>
                          )}
                        </td>
                        <td className={`${td} text-center`}>
                          <Chip
                            signal={stats.verdict}
                            title={`${[stats.sTrend, stats.sRecent, stats.sZ].filter((s) => s === "break").length} de 3 señales en rojo · ${
                              [stats.sTrend, stats.sRecent, stats.sZ].filter((s) => s === "warn").length
                            } en naranja`}
                          >
                            {VERDICT_LABEL[stats.verdict]}
                          </Chip>
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

            {/* Relación seleccionada: titulares + gráfico con quiebres + panel ROC */}
            {selected && selected.stats.ok && (
              <div className="pt-2 border-t border-brand-200 space-y-2">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <p className="text-xs text-zinc-600">
                    <span className="text-emerald-700 font-semibold">{selected.long?.name}</span>
                    <span className="text-zinc-400"> − </span>
                    <span className="text-red-600 font-semibold">{selected.short?.name}</span>
                    {" "}· spread compuesto acumulado (Base 100), quiebres del {(zigThr * 100).toFixed(0)}% y MA {maWindow}m
                  </p>
                  <div className="flex items-end gap-2 text-sm">
                    <div>
                      <label className="block text-[10px] text-zinc-500 mb-0.5">Quiebre (zigzag)</label>
                      <select
                        value={zigThr}
                        onChange={(e) => setZigThr(Number(e.target.value))}
                        className="border border-zinc-300 rounded px-1.5 py-0.5 bg-white text-xs"
                        title="Cuánto tiene que retroceder el spread para dar por confirmado un máximo o un mínimo"
                      >
                        {[0.05, 0.1, 0.15, 0.2, 0.3].map((n) => (
                          <option key={n} value={n}>{(n * 100).toFixed(0)}%</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] text-zinc-500 mb-0.5">Panel ROC</label>
                      <select
                        value={rocK}
                        onChange={(e) => setRocK(Number(e.target.value))}
                        className="border border-zinc-300 rounded px-1.5 py-0.5 bg-white text-xs"
                        title="Ventana del retorno acumulado que se grafica arriba y se rankea contra la historia"
                      >
                        {DEFAULT_ROC_WINDOWS.map((n) => (
                          <option key={n} value={n}>{n} {n === 1 ? "mes" : "meses"}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                {/* Titulares detectados */}
                {detect && detect.heads.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {detect.heads.slice(0, 4).map((h, i) => (
                      <span
                        key={i}
                        className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${
                          h.tone === "up"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : h.tone === "down"
                            ? "bg-red-50 text-red-700 border-red-200"
                            : "bg-zinc-50 text-zinc-600 border-zinc-200"
                        }`}
                      >
                        {h.text}
                      </span>
                    ))}
                  </div>
                )}

                <PlotlyChart
                  data={[
                    // Panel de arriba: ROC de la ventana elegida.
                    {
                      type: "bar",
                      name: `ROC ${rocK}m`,
                      x: selected.stats.dates,
                      y: detect?.roc ?? [],
                      marker: {
                        color: (detect?.roc ?? []).map((v) =>
                          v == null ? "#d4d4d8" : v >= 0 ? "rgba(31,58,89,0.75)" : "rgba(220,38,38,0.75)",
                        ),
                      },
                      yaxis: "y2",
                      hovertemplate: `%{x|%Y-%m} · ROC ${rocK}m %{y:.1%}<extra></extra>`,
                    },
                    // Panel principal: piernas alcistas y bajistas del spread.
                    {
                      type: "scatter",
                      mode: "lines",
                      name: "Piernas al alza",
                      x: detect?.upX ?? selected.stats.dates,
                      y: detect?.upY ?? selected.stats.line,
                      line: { color: "#1f3a59", width: 2 },
                      connectgaps: false,
                      hovertemplate: "%{x|%Y-%m} · %{y:.1f}<extra></extra>",
                    },
                    {
                      type: "scatter",
                      mode: "lines",
                      name: "Piernas a la baja",
                      x: detect?.dnX ?? [],
                      y: detect?.dnY ?? [],
                      line: { color: "#dc2626", width: 2 },
                      connectgaps: false,
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
                    // Quiebres etiquetados (máximos y mínimos del zigzag).
                    {
                      type: "scatter",
                      mode: "markers+text",
                      name: "Quiebres",
                      x: (detect?.marks ?? []).map((s) => s.date),
                      y: (detect?.marks ?? []).map((s) => s.value),
                      text: (detect?.marks ?? []).map((s) => s.value.toFixed(0)),
                      textposition: (detect?.marks ?? []).map((s) => (s.kind === "H" ? "top center" : "bottom center")),
                      textfont: { size: 9, color: "#52525b" },
                      marker: {
                        size: 6,
                        symbol: (detect?.marks ?? []).map((s) => (s.kind === "H" ? "triangle-down" : "triangle-up")),
                        color: (detect?.marks ?? []).map((s) => (s.pending ? "#a1a1aa" : s.kind === "H" ? "#dc2626" : "#059669")),
                      },
                      hovertemplate: "%{x|%Y-%m} · %{y:.1f}<extra>quiebre</extra>",
                    },
                  ]}
                  layout={{
                    yaxis: { title: "Spread acum. (Base 100)", domain: [0, 0.72] },
                    yaxis2: {
                      title: `ROC ${rocK}m`,
                      domain: [0.79, 1],
                      tickformat: ".0%",
                      zeroline: true,
                      zerolinecolor: "#9ca3af",
                    },
                    xaxis: { title: "Fecha", anchor: "y" },
                    legend: { orientation: "h", y: -0.16 },
                    bargap: 0,
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
                  height={520}
                />

                {/* Ranking del ROC contra toda la historia */}
                {detect && (
                  <div className="rounded border border-brand-200 bg-white/70 px-3 py-2">
                    <p className="text-[11px] font-semibold text-brand-800 mb-1">
                      ¿Qué tan inédito es el movimiento? — ROC rankeado contra toda la historia del par
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse">
                        <thead>
                          <tr className="border-b border-zinc-200 text-left">
                            <th className="px-2 py-1 text-[10px] font-semibold text-zinc-500">Ventana</th>
                            <th className="px-2 py-1 text-[10px] font-semibold text-zinc-500 text-right">Movimiento</th>
                            <th className="px-2 py-1 text-[10px] font-semibold text-zinc-500 text-right" title="Percentil dentro de todas las lecturas históricas de esa misma ventana">
                              Percentil
                            </th>
                            <th className="px-2 py-1 text-[10px] font-semibold text-zinc-500" title="Última vez que la relación se movió igual o más en la misma dirección y ventana (se excluyen las ventanas solapadas)">
                              No se veía desde
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {detect.ranks.map((r) => (
                            <tr
                              key={r.k}
                              className={`border-b border-zinc-100 ${r.k === rocK ? "bg-brand-50/60" : ""}`}
                            >
                              <td className="px-2 py-1 text-[11px] text-zinc-700">
                                {r.k} {r.k === 1 ? "mes" : "meses"}
                              </td>
                              <td
                                className={`px-2 py-1 text-[11px] tabular-nums text-right font-semibold ${
                                  (r.value ?? 0) >= 0 ? "text-emerald-700" : "text-red-600"
                                }`}
                              >
                                {fmtPct(r.value)}
                              </td>
                              <td className="px-2 py-1 text-[11px] tabular-nums text-right text-zinc-600">
                                {r.pctile == null ? "—" : `p${Math.round(r.pctile * 100)}`}
                              </td>
                              <td className="px-2 py-1 text-[11px] text-zinc-700">
                                {r.isRecord ? (
                                  <span className="font-semibold text-brand-700">nunca — es récord histórico</span>
                                ) : r.lastSimilarDate ? (
                                  <>
                                    {fmtMonth(r.lastSimilarDate)}
                                    <span className="ml-1 text-[10px] text-zinc-400">
                                      (hace {r.monthsSince} meses)
                                    </span>
                                  </>
                                ) : (
                                  "—"
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {detect.struct.low && detect.struct.high && (
                      <p className="text-[10px] text-zinc-500 mt-1.5">
                        Último mínimo: {fmtMonth(detect.struct.low.date)} ({fmtPct(detect.struct.fromLow)} desde ahí) ·
                        último máximo: {fmtMonth(detect.struct.high.date)} ({fmtPct(detect.struct.fromHigh)} desde ahí)
                        {detect.struct.lowerHighs === true && " · máximos descendentes"}
                        {detect.struct.higherLows === true && " · mínimos ascendentes"}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Leyenda */}
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              Color de los chips: <span className="text-emerald-700 font-semibold">verde</span> = la relación se comporta
              como siempre · <span className="text-amber-600 font-semibold">naranja</span> = se está debilitando ·{" "}
              <span className="text-red-600 font-semibold">rojo</span> = quiebre. Cada columna está definida arriba, en{" "}
              “¿Cómo leo cada columna?”. Clic en una fila para ver su gráfico.
            </p>
          </>
        )}
      </div>
    </details>
  );
}
