import { NextResponse } from "next/server";
import { FRENCH_DATASETS, fetchFrenchDataset } from "@/lib/french";

export const runtime = "nodejs";
export const revalidate = 86400;
export const maxDuration = 30;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const name = searchParams.get("name");
  if (!name) {
    return NextResponse.json({ error: "Missing ?name=" }, { status: 400 });
  }
  const known = FRENCH_DATASETS.some((d) => d.id === name);
  if (!known) {
    return NextResponse.json({ error: `Unknown dataset: ${name}` }, { status: 400 });
  }
  try {
    const table = await fetchFrenchDataset(name);
    return NextResponse.json(
      { name, title: table.title, columns: table.columns, rows: table.rows },
      { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
