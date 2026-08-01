import { NextRequest, NextResponse } from "next/server";
import { getItems } from "@/lib/db";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const items = getItems({
    source: p.get("source") || undefined,
    topic: p.get("topic") || undefined,
    unreadOnly: p.get("unread") === "1",
    limit: 200,
  });
  return NextResponse.json({ items });
}
