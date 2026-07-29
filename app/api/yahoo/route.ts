import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

// Descarga de Yahoo Finance retornos MENSUALES total-return con la mayor
// historia posible. Usa el chart API v8 con interval=1mo, range=max y
// adjusted close (dividendos reinvertidos + splits) para calcular los retornos.
// Corre server-side (IP de Vercel), que no está bloqueada como la red local.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim();
  if (!ticker) {
    return NextResponse.json({ error: "Falta ?ticker=" }, { status: 400 });
  }

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?range=max&interval=1mo&events=div%2Csplit&includeAdjustedClose=true`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; correlaciones/1.0)" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Yahoo respondió ${res.status} para "${ticker}"` },
        { status: 502 },
      );
    }
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) {
      const desc = data?.chart?.error?.description;
      return NextResponse.json(
        { error: desc || `Sin datos para "${ticker}" (¿ticker válido en Yahoo?)` },
        { status: 404 },
      );
    }

    const ts: number[] = result.timestamp ?? [];
    const adj: (number | null)[] =
      result.indicators?.adjclose?.[0]?.adjclose ??
      result.indicators?.quote?.[0]?.close ??
      [];

    // Precio mensual (adj close) → fecha normalizada a fin de mes (como Ken French).
    const points: { date: string; value: number }[] = [];
    for (let i = 0; i < ts.length; i++) {
      const v = adj[i];
      if (v == null || !Number.isFinite(v)) continue;
      const d = new Date(ts[i] * 1000);
      const monthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
      points.push({ date: monthEnd.toISOString().slice(0, 10), value: v });
    }
    points.sort((a, b) => a.date.localeCompare(b.date));

    const returns: { date: string; value: number }[] = [];
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1].value;
      const cur = points[i].value;
      if (prev > 0) returns.push({ date: points[i].date, value: cur / prev - 1 });
    }

    if (returns.length === 0) {
      return NextResponse.json(
        { error: `Sin retornos parseables para "${ticker}"` },
        { status: 404 },
      );
    }

    return NextResponse.json(
      { ticker, currency: result.meta?.currency ?? null, returns },
      { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "error desconocido";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
