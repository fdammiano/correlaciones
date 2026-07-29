// ── Detectores de movimientos sobre una serie de nivel (Base 100) ───────────
// La idea: reproducir el tipo de lectura que se hace sobre un ratio en
// StockCharts (RSP:SPY, VUG:VTV, FXI:EWY…) pero calculado y rankeado contra
// TODA la historia, para poder decir cosas como:
//   · "mejor racha de 2 meses desde may-2009"   → ROC(k) rankeado vs su historia
//   · "+64% desde el mínimo de jun-2026"        → distancia al último quiebre
//   · "mínimo de 37 meses"                      → nuevo extremo de N meses
//   · máximos descendentes / mínimos ascendentes → estructura del zigzag
// Todo trabaja sobre datos MENSUALES (es lo que hay: Ken French + Yahoo 1mo).

import type { ReturnPoint } from "./types";

const MONTHS_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "2009-05-31" → "may-2009" */
export function fmtMonth(date: string | null | undefined): string {
  if (!date) return "—";
  const m = parseInt(date.slice(5, 7), 10);
  return `${MONTHS_ES[m - 1] ?? "?"}-${date.slice(0, 4)}`;
}

function pct(v: number, d = 1): string {
  return (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(d) + "%";
}

// ── Nivel acumulado de una relación long-short ──────────────────────────────
// spread(t) = (1+r_long)/(1+r_short) − 1, acumulado desde `base`.
// Se recorren las fechas de la pierna long y se buscan en el mapa de la short
// (intersección), para poder escanear muchos pares sin rearmar mapas.
export type LevelSeries = { dates: string[]; level: number[] };

export function spreadLevelFast(
  longDates: string[],
  longVals: number[],
  shortMap: Map<string, number>,
  base = 100,
): LevelSeries {
  const dates: string[] = [];
  const level: number[] = [];
  let w = base;
  for (let i = 0; i < longDates.length; i++) {
    const rl = longVals[i];
    const rs = shortMap.get(longDates[i]);
    if (rs === undefined || !Number.isFinite(rl) || !Number.isFinite(rs) || 1 + rs === 0) continue;
    w *= (1 + rl) / (1 + rs);
    if (!Number.isFinite(w) || w <= 0) continue;
    dates.push(longDates[i]);
    level.push(w);
  }
  return { dates, level };
}

/** El nivel de la relación invertida (short − long) es exactamente base²/level. */
export function invertLevel(level: number[], base = 100): number[] {
  const b2 = base * base;
  return level.map((v) => b2 / v);
}

export function toArrays(returns: ReturnPoint[]): { dates: string[]; vals: number[]; map: Map<string, number> } {
  const sorted = [...returns].filter((r) => Number.isFinite(r.value)).sort((a, b) => a.date.localeCompare(b.date));
  return {
    dates: sorted.map((r) => r.date),
    vals: sorted.map((r) => r.value),
    map: new Map(sorted.map((r) => [r.date, r.value])),
  };
}

// ── ROC(k) y su ranking histórico ───────────────────────────────────────────
export function rocSeries(level: number[], k: number): (number | null)[] {
  const out: (number | null)[] = new Array(level.length).fill(null);
  for (let i = k; i < level.length; i++) {
    const prev = level[i - k];
    if (prev > 0 && Number.isFinite(level[i])) out[i] = level[i] / prev - 1;
  }
  return out;
}

export type RocRank = {
  k: number;
  /** ROC de los últimos k meses */
  value: number | null;
  /** percentil del ROC actual dentro de su propia historia (0..1) */
  pctile: number | null;
  /** cantidad de lecturas históricas comparables */
  n: number;
  /** última fecha con un ROC igual o más extremo en la misma dirección */
  lastSimilarDate: string | null;
  /** meses transcurridos desde esa fecha */
  monthsSince: number | null;
  /** no hay antecedente: es el ROC más extremo de toda la historia */
  isRecord: boolean;
  dir: 1 | -1 | 0;
};

/**
 * Rankea el ROC(k) actual contra su historia. Para el "desde…" se excluyen las
 * ventanas que SE SOLAPAN con la actual (índices > last−k): si no, un rally de
 * 3 meses reportaría "mejor racha de 2m desde el mes pasado", que no dice nada.
 */
export function rocRank(level: number[], dates: string[], k: number): RocRank {
  const empty: RocRank = {
    k, value: null, pctile: null, n: 0, lastSimilarDate: null,
    monthsSince: null, isRecord: false, dir: 0,
  };
  const roc = rocSeries(level, k);
  const last = roc.length - 1;
  const cur = last >= 0 ? roc[last] : null;
  if (cur == null) return empty;

  const dir: 1 | -1 | 0 = cur > 0 ? 1 : cur < 0 ? -1 : 0;
  const histEnd = last - k; // última ventana que no se solapa con la actual
  let n = 0;
  let below = 0;
  let lastSimilarIdx = -1;
  for (let i = k; i <= histEnd; i++) {
    const v = roc[i];
    if (v == null) continue;
    n++;
    if (v < cur) below++;
    if (dir >= 0 ? v >= cur : v <= cur) lastSimilarIdx = i;
  }

  return {
    k,
    value: cur,
    pctile: n > 0 ? below / n : null,
    n,
    lastSimilarDate: lastSimilarIdx >= 0 ? dates[lastSimilarIdx] : null,
    monthsSince: lastSimilarIdx >= 0 ? last - lastSimilarIdx : null,
    isRecord: n > 0 && lastSimilarIdx < 0,
    dir,
  };
}

// ── Zigzag: quiebres (máximos y mínimos) del nivel ──────────────────────────
export type Swing = { i: number; date: string; value: number; kind: "H" | "L"; pending?: boolean };

/**
 * Zigzag clásico por umbral porcentual: confirma un máximo cuando el nivel
 * retrocede `thr` desde él (y viceversa). El último extremo queda como
 * `pending` (todavía sin confirmar) — es justamente el "off the June low".
 */
export function zigzag(level: number[], dates: string[], thr = 0.1): { swings: Swing[]; pending: Swing | null; dir: 1 | -1 | 0 } {
  const swings: Swing[] = [];
  const n = level.length;
  if (n < 3) return { swings, pending: null, dir: 0 };

  const mk = (i: number, kind: "H" | "L", pending = false): Swing => ({ i, date: dates[i], value: level[i], kind, pending });

  let dir: 1 | -1 | 0 = 0;
  let extIdx = 0;
  let minIdx = 0;
  let maxIdx = 0;

  for (let i = 1; i < n; i++) {
    const v = level[i];
    if (dir === 0) {
      if (v >= level[minIdx] * (1 + thr)) {
        dir = 1;
        swings.push(mk(minIdx, "L"));
        extIdx = i;
      } else if (v <= level[maxIdx] * (1 - thr)) {
        dir = -1;
        swings.push(mk(maxIdx, "H"));
        extIdx = i;
      } else {
        if (v < level[minIdx]) minIdx = i;
        if (v > level[maxIdx]) maxIdx = i;
      }
      continue;
    }
    if (dir === 1) {
      if (v > level[extIdx]) extIdx = i;
      else if (v <= level[extIdx] * (1 - thr)) {
        swings.push(mk(extIdx, "H"));
        dir = -1;
        extIdx = i;
      }
    } else {
      if (v < level[extIdx]) extIdx = i;
      else if (v >= level[extIdx] * (1 + thr)) {
        swings.push(mk(extIdx, "L"));
        dir = 1;
        extIdx = i;
      }
    }
  }

  const pending = dir === 0 ? null : mk(extIdx, dir === 1 ? "H" : "L", true);
  return { swings, pending, dir };
}

// ── Estructura: distancia a los últimos quiebres y extremos de N meses ──────
export type Structure = {
  /** último mínimo (confirmado o en curso) y cuánto subió el nivel desde ahí */
  low: Swing | null;
  fromLow: number | null;
  /** último máximo y cuánto cayó el nivel desde ahí */
  high: Swing | null;
  fromHigh: number | null;
  /** el dato actual es el más bajo / más alto de los últimos N meses */
  monthsAtLow: number | null;
  monthsAtHigh: number | null;
  /** estructura de los dos últimos quiebres de cada tipo */
  higherLows: boolean | null;
  lowerHighs: boolean | null;
};

export function structure(level: number[], dates: string[], thr = 0.1): Structure {
  const empty: Structure = {
    low: null, fromLow: null, high: null, fromHigh: null,
    monthsAtLow: null, monthsAtHigh: null, higherLows: null, lowerHighs: null,
  };
  const n = level.length;
  if (n < 3) return empty;

  const { swings, pending } = zigzag(level, dates, thr);
  const all = pending ? [...swings, pending] : swings;
  const lows = all.filter((s) => s.kind === "L");
  const highs = all.filter((s) => s.kind === "H");
  const low = lows.at(-1) ?? null;
  const high = highs.at(-1) ?? null;
  const cur = level[n - 1];

  // ¿De cuántos meses es el extremo actual? (cuánto hay que ir para atrás
  // hasta encontrar un valor más bajo / más alto que el de hoy)
  let monthsAtLow = 0;
  for (let i = n - 2; i >= 0; i--, monthsAtLow++) if (level[i] < cur) break;
  let monthsAtHigh = 0;
  for (let i = n - 2; i >= 0; i--, monthsAtHigh++) if (level[i] > cur) break;

  const confirmedLows = swings.filter((s) => s.kind === "L");
  const confirmedHighs = swings.filter((s) => s.kind === "H");

  return {
    low,
    fromLow: low && low.value > 0 ? cur / low.value - 1 : null,
    high,
    fromHigh: high && high.value > 0 ? cur / high.value - 1 : null,
    monthsAtLow: monthsAtLow >= n - 1 ? n - 1 : monthsAtLow,
    monthsAtHigh: monthsAtHigh >= n - 1 ? n - 1 : monthsAtHigh,
    higherLows:
      confirmedLows.length >= 2 ? confirmedLows.at(-1)!.value > confirmedLows.at(-2)!.value : null,
    lowerHighs:
      confirmedHighs.length >= 2 ? confirmedHighs.at(-1)!.value < confirmedHighs.at(-2)!.value : null,
  };
}

// ── Titulares ───────────────────────────────────────────────────────────────
// Frases listas para leer, del estilo de los tweets que sirven de referencia.
export type Tone = "up" | "down" | "neutral";
export type Headline = { text: string; tone: Tone; strength: number };

export const DEFAULT_ROC_WINDOWS = [1, 2, 3, 6, 12];

export function headlines(
  level: number[],
  dates: string[],
  opts: { windows?: number[]; thr?: number; minRoc?: number; minPctile?: number } = {},
): Headline[] {
  const windows = opts.windows ?? DEFAULT_ROC_WINDOWS;
  const thr = opts.thr ?? 0.1;
  const minRoc = opts.minRoc ?? 0.02;
  const minPctile = opts.minPctile ?? 0.9;
  const out: Headline[] = [];
  if (level.length < 6) return out;

  // 1) ROC(k) extremo vs su historia → "mejor racha de k meses desde …"
  // Un salto reciente aparece como extremo en varias ventanas a la vez (el
  // mismo +25% es récord de 2, 3, 6 y 12 meses). Se emite sólo el titular más
  // fuerte de cada movimiento: los que repiten casi el mismo % se descartan.
  const rocHeads: { h: Headline; value: number }[] = [];
  for (const k of windows) {
    const r = rocRank(level, dates, k);
    if (r.value == null || r.pctile == null || Math.abs(r.value) < minRoc) continue;
    const up = r.value > 0;
    const extreme = up ? r.pctile >= minPctile : r.pctile <= 1 - minPctile;
    if (!extreme) continue;
    const what = up ? "racha" : "caída";
    const label = `${k}${k === 1 ? " mes" : " meses"}`;
    const text = r.isRecord
      ? `${up ? "Mejor" : "Peor"} ${what} de ${label} de toda la historia (${pct(r.value)})`
      : `${up ? "Mejor" : "Peor"} ${what} de ${label} desde ${fmtMonth(r.lastSimilarDate)} (${pct(r.value)})`;
    rocHeads.push({
      h: {
        text,
        tone: up ? "up" : "down",
        strength: (r.isRecord ? r.n : r.monthsSince ?? 0) + Math.abs(r.value) * 10,
      },
      value: r.value,
    });
  }
  rocHeads.sort((a, b) => b.h.strength - a.h.strength);
  const keptValues: number[] = [];
  for (const cand of rocHeads) {
    if (keptValues.some((v) => Math.abs(v - cand.value) < 0.01)) continue;
    keptValues.push(cand.value);
    out.push(cand.h);
  }

  // 2) Distancia al último quiebre → "+64% desde el mínimo de jun-2026"
  const st = structure(level, dates, thr);
  if (st.fromLow != null && st.low && st.fromLow >= thr) {
    out.push({
      text: `${pct(st.fromLow)} desde el mínimo de ${fmtMonth(st.low.date)}`,
      tone: "up",
      strength: 20 + st.fromLow * 100,
    });
  }
  if (st.fromHigh != null && st.high && st.fromHigh <= -thr) {
    out.push({
      text: `${pct(st.fromHigh)} desde el máximo de ${fmtMonth(st.high.date)}`,
      tone: "down",
      strength: 20 + Math.abs(st.fromHigh) * 100,
    });
  }

  // 3) Nuevo extremo de N meses
  if (st.monthsAtHigh != null && st.monthsAtHigh >= 12) {
    out.push({ text: `Máximo de ${st.monthsAtHigh} meses`, tone: "up", strength: st.monthsAtHigh });
  }
  if (st.monthsAtLow != null && st.monthsAtLow >= 12) {
    out.push({ text: `Mínimo de ${st.monthsAtLow} meses`, tone: "down", strength: st.monthsAtLow });
  }

  // 4) Estructura del zigzag
  if (st.lowerHighs === true) out.push({ text: "Máximos descendentes", tone: "down", strength: 10 });
  if (st.higherLows === true) out.push({ text: "Mínimos ascendentes", tone: "up", strength: 10 });

  return out.sort((a, b) => b.strength - a.strength);
}
