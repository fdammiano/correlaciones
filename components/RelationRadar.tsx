"use client";

// ── Radar de movimientos (long-short) ───────────────────────────────────────
// Lo que hace un chartista cuando twitea "RSP:SPY, best 2-month rally since May
// 2009" es mirar un ratio, calcular su ROC de N meses y rankearlo contra toda
// la historia. Acá se hace al revés: se escanean TODOS los pares del universo
// elegido y se ordenan por cuán inédito es su movimiento actual, así el par
// aparece solo en lugar de haber que adivinarlo.
//
// Métrica de orden: "hace cuántos meses que no se veía un movimiento así".
// Un par que hace 200 meses que no corría tanto sale arriba de uno que repitió
// el mismo salto el trimestre pasado.

import { useMemo, useState } from "react";
import {
  DEFAULT_ROC_WINDOWS,
  fmtMonth,
  headlines,
  invertLevel,
  rocRank,
  spreadLevelFast,
  structure,
  toArrays,
  type Headline,
  type RocRank,
} from "@/lib/signals";
import { useRelations } from "@/lib/relations";
import type { SeriesData } from "@/lib/types";

const MAX_PAIRS = 4000; // techo de seguridad: más que esto no se escanea de una

type Hit = {
  longId: string;
  shortId: string;
  longName: string;
  shortName: string;
  roc: RocRank;
  months: number;
  fromLow: number | null;
  lowDate: string | null;
  headline: Headline | null;
  score: number;
};

function fmtPct(v: number | null, d = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(d) + "%";
}

const TONE_TEXT: Record<string, string> = {
  up: "text-emerald-700",
  down: "text-red-600",
  neutral: "text-zinc-600",
};

export default function RelationRadar({
  activeSeries,
  library,
}: {
  activeSeries: SeriesData[];
  library: SeriesData[];
}) {
  const { add, has } = useRelations();

  const [universe, setUniverse] = useState<"library" | "active">("library");
  const [mode, setMode] = useState<"all" | "benchmark">("all");
  const [benchmarkId, setBenchmarkId] = useState("");
  const [k, setK] = useState(2);
  const [minMonths, setMinMonths] = useState(60);
  const [thr, setThr] = useState(0.1);
  const [minRoc, setMinRoc] = useState(0.02);
  const [scanning, setScanning] = useState(false);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [stats, setStats] = useState<{ pairs: number; skipped: number; shown: number } | null>(null);

  const pool = useMemo(() => {
    const base = universe === "active" && activeSeries.length >= 2 ? activeSeries : library;
    return base.filter((s) => s.returns.length >= minMonths);
  }, [universe, activeSeries, library, minMonths]);

  const pairCount = useMemo(() => {
    if (mode === "benchmark") return Math.max(0, pool.length - 1);
    return (pool.length * (pool.length - 1)) / 2;
  }, [pool.length, mode]);

  const effBenchmark = benchmarkId && pool.some((s) => s.id === benchmarkId) ? benchmarkId : pool[0]?.id ?? "";

  function scan() {
    if (pairCount === 0 || pairCount > MAX_PAIRS) return;
    setScanning(true);
    // Un tick para que el botón muestre "Escaneando…" antes de bloquear el hilo.
    setTimeout(() => {
      try {
        const prep = pool.map((s) => ({ s, ...toArrays(s.returns) }));
        const out: Hit[] = [];
        let skipped = 0;

        const pairs: [number, number][] = [];
        if (mode === "benchmark") {
          const bi = prep.findIndex((p) => p.s.id === effBenchmark);
          if (bi >= 0) for (let i = 0; i < prep.length; i++) if (i !== bi) pairs.push([i, bi]);
        } else {
          for (let i = 0; i < prep.length; i++) for (let j = i + 1; j < prep.length; j++) pairs.push([i, j]);
        }

        for (const [i, j] of pairs) {
          const a = prep[i];
          const b = prep[j];
          const { dates, level } = spreadLevelFast(a.dates, a.vals, b.map);
          if (level.length < Math.max(minMonths, k + 12)) {
            skipped++;
            continue;
          }

          // La relación invertida es exactamente el recíproco del nivel, así que
          // se evalúan las dos direcciones sin recalcular el spread.
          const rA = rocRank(level, dates, k);
          if (rA.value == null) {
            skipped++;
            continue;
          }
          const up = rA.value > 0;
          const useLevel = up ? level : invertLevel(level);
          const roc = up ? rA : rocRank(useLevel, dates, k);
          if (roc.value == null || roc.value < minRoc) {
            skipped++;
            continue;
          }

          const st = structure(useLevel, dates, thr);
          const hs = headlines(useLevel, dates, { windows: [k], thr, minRoc });
          const monthsSince = roc.isRecord ? roc.n : roc.monthsSince ?? 0;

          out.push({
            longId: up ? a.s.id : b.s.id,
            shortId: up ? b.s.id : a.s.id,
            longName: up ? a.s.name : b.s.name,
            shortName: up ? b.s.name : a.s.name,
            roc,
            months: level.length,
            fromLow: st.fromLow,
            lowDate: st.low?.date ?? null,
            headline: hs[0] ?? null,
            score: monthsSince + roc.value * 10,
          });
        }

        out.sort((x, y) => y.score - x.score);
        const shown = out.slice(0, 30);
        setHits(shown);
        setStats({ pairs: pairs.length, skipped, shown: shown.length });
      } finally {
        setScanning(false);
      }
    }, 0);
  }

  const th = "px-2 py-1.5 text-[11px] font-semibold text-zinc-700 whitespace-nowrap";
  const td = "px-2 py-1.5 text-[12px] tabular-nums whitespace-nowrap";

  return (
    <details className="mb-6 rounded-lg border border-gold-500/40 bg-gold-50/30">
      <summary className="cursor-pointer select-none px-4 py-2.5 flex items-center gap-2">
        <span className="text-sm font-semibold text-brand-800">📡 Radar de movimientos (long-short)</span>
        <span className="text-[11px] text-zinc-500">
          ¿qué relación está haciendo algo que no hacía en años?
        </span>
      </summary>

      <div className="px-4 pb-4 pt-1 space-y-3">
        <p className="text-[11px] text-zinc-500 leading-relaxed">
          Escanea todos los pares del universo elegido, calcula el <b>ROC de {k} {k === 1 ? "mes" : "meses"}</b> de cada
          relación (long ÷ short compuesto) y lo rankea contra <b>toda su historia</b>. Ordena por{" "}
          <b>hace cuánto que no se veía un movimiento así</b>: es la lectura del estilo “mejor racha de 2 meses desde
          may-2009”. Cada par se evalúa en las dos direcciones y se reporta la que está ganando.
        </p>

        {/* Controles */}
        <div className="flex flex-wrap items-end gap-3 text-sm border-b border-gold-500/30 pb-3">
          <div>
            <label className="block text-[11px] text-zinc-600 mb-1">Universo</label>
            <select
              value={universe}
              onChange={(e) => setUniverse(e.target.value as "library" | "active")}
              className="border border-zinc-300 rounded px-2 py-1 bg-white text-sm"
            >
              <option value="library">Toda la biblioteca ({library.length})</option>
              <option value="active">Sólo los activos ({activeSeries.length})</option>
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-zinc-600 mb-1">Pares</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as "all" | "benchmark")}
              className="border border-zinc-300 rounded px-2 py-1 bg-white text-sm"
            >
              <option value="all">Todos contra todos</option>
              <option value="benchmark">Todos contra un benchmark</option>
            </select>
          </div>
          {mode === "benchmark" && (
            <div>
              <label className="block text-[11px] text-zinc-600 mb-1">Benchmark (short)</label>
              <select
                value={effBenchmark}
                onChange={(e) => setBenchmarkId(e.target.value)}
                className="border border-zinc-300 rounded px-2 py-1 bg-white text-sm max-w-[240px]"
              >
                {pool.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="block text-[11px] text-zinc-600 mb-1">Ventana (ROC)</label>
            <select
              value={k}
              onChange={(e) => setK(Number(e.target.value))}
              className="border border-zinc-300 rounded px-2 py-1 bg-white text-sm"
            >
              {DEFAULT_ROC_WINDOWS.map((n) => (
                <option key={n} value={n}>{n} {n === 1 ? "mes" : "meses"}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-zinc-600 mb-1">Historia mínima</label>
            <select
              value={minMonths}
              onChange={(e) => setMinMonths(Number(e.target.value))}
              className="border border-zinc-300 rounded px-2 py-1 bg-white text-sm"
            >
              {[24, 60, 120, 240].map((n) => (
                <option key={n} value={n}>{n} meses</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-zinc-600 mb-1">Movimiento mínimo</label>
            <select
              value={minRoc}
              onChange={(e) => setMinRoc(Number(e.target.value))}
              className="border border-zinc-300 rounded px-2 py-1 bg-white text-sm"
            >
              {[0, 0.02, 0.05, 0.1].map((n) => (
                <option key={n} value={n}>{n === 0 ? "sin filtro" : `≥ ${(n * 100).toFixed(0)}%`}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-zinc-600 mb-1">Umbral de quiebre</label>
            <select
              value={thr}
              onChange={(e) => setThr(Number(e.target.value))}
              className="border border-zinc-300 rounded px-2 py-1 bg-white text-sm"
            >
              {[0.05, 0.1, 0.15, 0.2].map((n) => (
                <option key={n} value={n}>{(n * 100).toFixed(0)}%</option>
              ))}
            </select>
          </div>
          <button
            onClick={scan}
            disabled={scanning || pairCount === 0 || pairCount > MAX_PAIRS}
            className="rounded bg-brand-700 text-white px-3 py-1.5 text-xs font-semibold hover:bg-brand-800 disabled:opacity-40"
          >
            {scanning ? "Escaneando…" : `Escanear ${pairCount.toLocaleString("es-UY")} pares`}
          </button>
        </div>

        {pairCount > MAX_PAIRS && (
          <p className="text-[11px] text-amber-700">
            {pairCount.toLocaleString("es-UY")} pares es demasiado para escanear de una (techo {MAX_PAIRS.toLocaleString("es-UY")}).
            Usá “todos contra un benchmark”, subí la historia mínima o achicá el universo.
          </p>
        )}

        {hits && stats && (
          <>
            <p className="text-[11px] text-zinc-500">
              {stats.pairs.toLocaleString("es-UY")} pares escaneados · {stats.skipped.toLocaleString("es-UY")} descartados
              (historia corta o movimiento por debajo del filtro) · se muestran los {stats.shown} más inéditos.
            </p>

            {hits.length === 0 ? (
              <div className="rounded border border-dashed border-zinc-300 bg-white px-4 py-5 text-center text-sm text-zinc-500">
                Ningún par pasó los filtros. Probá con una ventana más corta o bajá el movimiento mínimo.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-gold-500/40 text-left">
                      <th className={th}>#</th>
                      <th className={th}>Relación (gana el long)</th>
                      <th className={`${th} text-right`} title={`Retorno compuesto de la relación en los últimos ${k} meses`}>
                        ROC {k}m
                      </th>
                      <th className={`${th} text-right`} title="Percentil del ROC actual dentro de toda la historia del par">
                        Percentil
                      </th>
                      <th className={th} title="Última vez que la relación corrió igual o más en la misma ventana">
                        No se veía desde
                      </th>
                      <th className={th}>Titular</th>
                      <th className={th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {hits.map((h, idx) => {
                      const already = has(h.longId, h.shortId);
                      return (
                        <tr key={`${h.longId}|${h.shortId}`} className="border-b border-zinc-100 hover:bg-white">
                          <td className={`${td} text-zinc-400`}>{idx + 1}</td>
                          <td className={`${td} whitespace-normal`}>
                            <span className="text-emerald-700 font-medium">{h.longName}</span>
                            <span className="text-zinc-400"> − </span>
                            <span className="text-red-600 font-medium">{h.shortName}</span>
                            <span className="ml-1 text-[10px] text-zinc-400">({h.months}m)</span>
                          </td>
                          <td className={`${td} text-right text-emerald-700 font-semibold`}>{fmtPct(h.roc.value)}</td>
                          <td className={`${td} text-right`}>
                            {h.roc.pctile == null ? "—" : `p${Math.round(h.roc.pctile * 100)}`}
                          </td>
                          <td className={td}>
                            {h.roc.isRecord ? (
                              <span className="font-semibold text-brand-700">nunca (récord)</span>
                            ) : (
                              <>
                                {fmtMonth(h.roc.lastSimilarDate)}
                                <span className="ml-1 text-[10px] text-zinc-400">
                                  ({h.roc.monthsSince}m)
                                </span>
                              </>
                            )}
                          </td>
                          <td className={`${td} whitespace-normal`}>
                            {h.headline ? (
                              <span className={TONE_TEXT[h.headline.tone]}>{h.headline.text}</span>
                            ) : (
                              <span className="text-zinc-400">—</span>
                            )}
                            {h.fromLow != null && h.fromLow >= thr && h.lowDate && (
                              <span className="block text-[10px] text-zinc-500">
                                {fmtPct(h.fromLow)} desde el mínimo de {fmtMonth(h.lowDate)}
                              </span>
                            )}
                          </td>
                          <td className={`${td} text-right`}>
                            <button
                              onClick={() => add(h.longId, h.shortId)}
                              disabled={already}
                              className="rounded border border-brand-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-brand-700 hover:bg-brand-50 disabled:opacity-40"
                              title={already ? "Ya está en el monitor" : "Agregar al Monitor de relaciones"}
                            >
                              {already ? "✓ en monitor" : "+ seguir"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {!hits && (
          <p className="text-[11px] text-zinc-500">
            Nada escaneado todavía. Con “todos contra todos” sobre la biblioteca entera el barrido puede tardar unos
            segundos; con un benchmark es instantáneo.
          </p>
        )}
      </div>
    </details>
  );
}
