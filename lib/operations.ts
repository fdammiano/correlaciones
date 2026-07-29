import type { ReturnPoint, SeriesData, RebalanceFreq } from "./types";

export type { RebalanceFreq } from "./types";

export type OpType = "diff" | "ratio" | "sum" | "weighted" | "scale";

export type OpConfig = {
  type: OpType;
  a: SeriesData;
  b?: SeriesData;
  /** weight on A in weighted combo; (1-weight) on B */
  weight?: number;
  /** multiplier on A for "scale" */
  scalar?: number;
  /** additive offset for "scale" (monthly, decimal — e.g. -0.003 to subtract 30bps/month) */
  offset?: number;
};

/** Build a new monthly return series from one or two existing ones. */
export function operate(cfg: OpConfig): ReturnPoint[] {
  const aMap = new Map(cfg.a.returns.map((r) => [r.date, r.value]));
  const bMap = cfg.b ? new Map(cfg.b.returns.map((r) => [r.date, r.value])) : null;

  const dates = bMap
    ? Array.from(aMap.keys()).filter((d) => bMap.has(d)).sort()
    : Array.from(aMap.keys()).sort();

  const out: ReturnPoint[] = [];
  for (const d of dates) {
    const ra = aMap.get(d)!;
    const rb = bMap ? (bMap.get(d) as number) : undefined;
    let v: number | null = null;

    if (!Number.isFinite(ra)) continue;
    if (bMap && (rb === undefined || !Number.isFinite(rb))) continue;

    switch (cfg.type) {
      case "diff":
        if (rb !== undefined) v = ra - rb;
        break;
      case "ratio":
        if (rb !== undefined && 1 + rb !== 0) v = (1 + ra) / (1 + rb) - 1;
        break;
      case "sum":
        if (rb !== undefined) v = ra + rb;
        break;
      case "weighted": {
        if (rb !== undefined && cfg.weight !== undefined) {
          v = cfg.weight * ra + (1 - cfg.weight) * rb;
        }
        break;
      }
      case "scale": {
        const s = cfg.scalar ?? 1;
        const o = cfg.offset ?? 0;
        v = s * ra + o;
        break;
      }
    }
    if (v !== null && Number.isFinite(v)) {
      out.push({ date: d, value: v });
    }
  }
  return out;
}

export type PortfolioMember = { series: SeriesData; weight: number };

// Frecuencia con la que la cartera vuelve a los pesos objetivo (tipo en ./types):
//  - monthly:   se rebalancea todos los meses (pesos siempre = objetivo).
//  - quarterly: se rebalancea al inicio de cada trimestre calendario (Ene/Abr/Jul/Oct).
//  - annual:    se rebalancea al inicio de cada año (Enero).
//  - hold:      buy & hold, nunca se rebalancea (los pesos driftean con el mercado).
export const REBALANCE_LABEL: Record<RebalanceFreq, string> = {
  monthly: "Mensual",
  quarterly: "Trimestral",
  annual: "Anual",
  hold: "Buy & Hold",
};

/**
 * Cartera de N activos con pesos objetivo fijos y rebalanceo configurable:
 *   r_port(t) = Σ wᵢ(t)·rᵢ(t)   con los pesos normalizados a que sumen 1.
 * Entre fechas de rebalanceo los pesos driftean con el retorno de cada activo;
 * en cada fecha de rebalanceo se resetean a los objetivos. Con "monthly" se
 * resetean todos los meses ⇒ equivale a Σ wᵢ·rᵢ con pesos constantes.
 * Se calcula sobre los meses en común a TODOS los miembros con peso ≠ 0
 * (intersección de historias). Así el backtest arranca en la inception más tardía.
 */
export function portfolioReturns(
  members: PortfolioMember[],
  freq: RebalanceFreq = "monthly",
): ReturnPoint[] {
  const valid = members.filter((m) => m.weight !== 0 && m.series.returns.length > 0);
  if (valid.length === 0) return [];
  const totalW = valid.reduce((s, m) => s + m.weight, 0);
  if (totalW === 0) return [];

  const maps = valid.map((m) => ({
    w: m.weight / totalW,
    map: new Map(m.series.returns.map((r) => [r.date, r.value])),
  }));

  // Intersección de fechas entre todos los miembros.
  let dates = Array.from(maps[0].map.keys());
  for (let i = 1; i < maps.length; i++) {
    const mk = maps[i].map;
    dates = dates.filter((d) => mk.has(d));
  }
  dates.sort();

  const target = maps.map((m) => m.w); // pesos objetivo (suman 1)
  let w = [...target]; // pesos vigentes al inicio del mes
  let first = true;

  const out: ReturnPoint[] = [];
  for (const d of dates) {
    const rs = maps.map((m) => m.map.get(d));
    if (rs.some((r) => r == null || !Number.isFinite(r as number))) continue;

    const month = parseInt(d.slice(5, 7), 10);
    const isRebalance =
      first ||
      freq === "monthly" ||
      (freq === "quarterly" && (month === 1 || month === 4 || month === 7 || month === 10)) ||
      (freq === "annual" && month === 1);
    if (isRebalance) w = [...target];

    let rp = 0;
    for (let i = 0; i < w.length; i++) rp += w[i] * (rs[i] as number);
    if (!Number.isFinite(rp)) continue;
    out.push({ date: d, value: rp });

    // drift de los pesos para el mes siguiente (se renormalizan solos a 1)
    const denom = 1 + rp;
    if (denom !== 0) {
      for (let i = 0; i < w.length; i++) {
        w[i] = (w[i] * (1 + (rs[i] as number))) / denom;
      }
    }
    first = false;
  }
  return out;
}

export function defaultOpName(cfg: OpConfig): string {
  const a = cfg.a.name;
  const b = cfg.b?.name ?? "";
  switch (cfg.type) {
    case "diff":
      return `${a} − ${b}`;
    case "ratio":
      return `${a} / ${b}`;
    case "sum":
      return `${a} + ${b}`;
    case "weighted":
      return `${(cfg.weight ?? 0.5).toFixed(2)}·${a} + ${(1 - (cfg.weight ?? 0.5)).toFixed(2)}·${b}`;
    case "scale": {
      const s = cfg.scalar ?? 1;
      const o = cfg.offset ?? 0;
      const lhs = s === 1 ? a : `${s.toFixed(2)}·${a}`;
      if (o === 0) return lhs;
      const off = (o * 100).toFixed(2);
      return `${lhs} ${o >= 0 ? "+" : "−"} ${Math.abs(parseFloat(off))}%`;
    }
  }
}
