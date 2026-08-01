import { NextRequest, NextResponse } from "next/server";
import { getPriceSeries } from "@/lib/db";

export const dynamic = "force-dynamic";

const RANGES: Record<string, number> = { "24h": 1, "7d": 7, "30d": 30 };

export function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const symbol = p.get("symbol") ?? "GC";
  const days = RANGES[p.get("range") ?? "7d"] ?? 7;
  const since = new Date(Date.now() - days * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return NextResponse.json({ points: getPriceSeries(symbol, since) });
}
