import { NextResponse } from "next/server";
import { FRENCH_DATASETS } from "@/lib/french";

export const runtime = "nodejs";
export const revalidate = 86400;

export async function GET() {
  return NextResponse.json({ datasets: FRENCH_DATASETS });
}
