import { NextResponse } from "next/server";
import { fetchMonthlyTotalReturns } from "@/lib/yahoo";

export const runtime = "nodejs";
export const revalidate = 3600;
export const maxDuration = 30;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker");
  const start = searchParams.get("start") ?? "1990-01-01";
  if (!ticker) {
    return NextResponse.json({ error: "Missing ?ticker=" }, { status: 400 });
  }
  try {
    const returns = await fetchMonthlyTotalReturns(ticker, start);
    return NextResponse.json(
      { ticker, returns },
      {
        headers: {
          "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
        },
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
