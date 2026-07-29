"use client";

import { useEffect, useState } from "react";

type Item = { portfolio: string; pct: number; months: number };
type Group = { family: string; region: string; items: Item[] };
type Resp = { ok: boolean; benchmark?: string; metric?: string; groups?: Group[]; error?: string };

function toneBg(pct: number): string {
  const a = Math.min(Math.abs(pct) / 40, 1); // 40% ≈ intensidad máxima
  const alpha = 0.1 + a * 0.55;
  return pct >= 0 ? `rgba(16,185,129,${alpha})` : `rgba(239,68,68,${alpha})`;
}

// Nombre de portafolio más legible
function pretty(col: string): string {
  const c = col.trim();
  if (/^lo 30$/i.test(c)) return "Bajo 30%";
  if (/^med 40$/i.test(c)) return "Medio 40%";
  if (/^hi 30$/i.test(c)) return "Alto 30%";
  return c;
}

export default function ScreenerPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/french/screener")
      .then((r) => r.json())
      .then((d: Resp) => setData(d))
      .catch(() => setData({ ok: false, error: "No se pudo cargar" }))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="min-h-screen bg-zinc-50 p-6 md:p-10">
      <div className="max-w-[1400px] mx-auto">
        {/* Encabezado */}
        <div className="mb-6 border-b border-zinc-200 pb-4">
          <a href="/" className="text-xs font-semibold text-brand-700 hover:text-brand-900">← Volver a la herramienta</a>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-brand-800">Screener de leads</h1>
          <p className="text-sm text-zinc-600 mt-1 max-w-3xl">
            Cada portafolio de Fama-French comparado contra el <b>Mercado US</b> vía división compuesta
            (ratio de riqueza acumulado). El color indica si <b>hoy está por encima (verde) o por debajo
            (rojo) de su promedio histórico</b>. Detectá el lead acá y después investigalo en la herramienta.
          </p>
          <div className="mt-3 flex items-center gap-4 text-[11px] text-zinc-500">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm" style={{ background: toneBg(30) }} /> Arriba del promedio</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm" style={{ background: toneBg(-30) }} /> Debajo del promedio</span>
          </div>
        </div>

        {loading && <p className="text-sm text-zinc-500 py-16 text-center">Calculando (bajando datos de Fama-French)…</p>}

        {!loading && data && !data.ok && (
          <p className="text-sm text-red-600 py-16 text-center">No se pudo calcular el screener. {data.error}</p>
        )}

        {!loading && data?.ok && (
          <div className="space-y-4">
            {(data.groups ?? []).map((g, i) => (
              <div key={i} className="bg-white border border-zinc-200 rounded-lg overflow-hidden">
                <div className="px-4 py-2 border-b border-zinc-100 flex items-baseline justify-between">
                  <h2 className="text-sm font-bold text-brand-800">{g.family}</h2>
                  <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide">{g.region}</span>
                </div>
                <div className="p-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-2">
                  {g.items.map((it, j) => (
                    <div
                      key={j}
                      className="rounded-md border border-zinc-200 px-3 py-2 flex flex-col"
                      style={{ background: toneBg(it.pct) }}
                      title={`${it.months} meses de historia`}
                    >
                      <span className="text-[11px] text-zinc-700 leading-tight truncate">{pretty(it.portfolio)}</span>
                      <span className={`text-lg font-bold tabular-nums ${it.pct >= 0 ? "text-emerald-800" : "text-red-800"}`}>
                        {it.pct >= 0 ? "+" : ""}{it.pct.toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
