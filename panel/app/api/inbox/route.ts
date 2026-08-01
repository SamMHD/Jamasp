import { NextRequest, NextResponse } from "next/server";
import { getItems } from "@/lib/db";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const limit = Math.min(Math.max(parseInt(p.get("limit") ?? "", 10) || 200, 1), 200);
  const offset = Math.max(parseInt(p.get("offset") ?? "", 10) || 0, 0);
  const items = getItems({
    source: p.get("source") || undefined,
    topic: p.get("topic") || undefined,
    unreadOnly: p.get("unread") === "1",
    search: p.get("q")?.trim() || undefined,
    limit,
    offset,
  });
  return NextResponse.json({ items });
}
