import type { ReturnPoint, SeriesData } from "./types";

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
