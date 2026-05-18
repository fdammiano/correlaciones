import { NextResponse } from "next/server";
import { isStoreConfigured, loadUniverse, saveUniverse } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!isStoreConfigured()) {
    return NextResponse.json({ configured: false, universe: null });
  }
  const universe = await loadUniverse();
  return NextResponse.json({ configured: true, universe: universe ?? [] });
}

export async function PUT(req: Request) {
  if (!isStoreConfigured()) {
    return NextResponse.json({ configured: false }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const universe = (body as { universe?: unknown })?.universe;
  if (!Array.isArray(universe)) {
    return NextResponse.json({ error: "Missing universe array" }, { status: 400 });
  }
  const ok = await saveUniverse(universe);
  return NextResponse.json({ configured: true, ok });
}
