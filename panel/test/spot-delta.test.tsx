/**
 * The 24h spot delta, end to end: fixture database -> lib/db lookup ->
 * deriveTechnicals -> rendered panel.
 *
 * db.test.ts pins the lookup and technical-panel.test.tsx pins the rendering,
 * but the defect this file exists for lived in the seam between them: a
 * frozen GC feed produced a reference equal to the latest row, which
 * subtracted to exactly 0 and rendered as "= 0 (0.00%)" — the panel asserting
 * gold unchanged — where the Telegram brief prints "n/a".
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { TechnicalPanel } from "../components/technical-panel";
import { deriveTechnicals, TECHNICAL_SYMBOLS } from "../lib/technicals";

let db: typeof import("../lib/db");

beforeAll(async () => {
  execFileSync("node", [path.resolve(__dirname, "../scripts/build-fixture.mjs")]);
  process.env.JAMASP_ROOT = path.resolve(__dirname, "fixtures/root");
  db = await import("../lib/db");
});

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Mirrors app/page.tsx's wiring; keep the two in step. */
function overviewTechnical(now: Date) {
  const p = db.latestPrices([...TECHNICAL_SYMBOLS]);
  const spot = p.GC ?? null;
  const spot24hAgo = spot
    ? db.priceDeltaReference("GC", iso(new Date(now.getTime() - 86400_000)), spot.ts)
    : null;
  const tech = deriveTechnicals({
    spot, spot24hAgo,
    sma50: p.GC_SMA50 ?? null, sma200: p.GC_SMA200 ?? null,
    pivotS1: p.GC_PIV_S1 ?? null, pivotR1: p.GC_PIV_R1 ?? null,
    rsi14: p.GC_RSI14 ?? null, atr14: p.GC_ATR14 ?? null,
    gvz: p["^GVZ"] ?? null, netSpec: p.GC_NET_SPEC ?? null,
  }, now);
  return {
    tech,
    html: renderToStaticMarkup(<TechnicalPanel tech={tech} series={[]} now={now} />),
  };
}

describe("overview 24h spot delta", () => {
  // The fixture's newest GC bar is 2026-08-01T08:00Z. Reading the panel a day
  // and a half later puts the 24h cutoff *after* that bar — the state of the
  // world from Saturday ~21:00Z until COMEX reopens Sunday ~23:00Z, roughly
  // 26 hours every week, because rows carry the market bar timestamp rather
  // than the fetch time.
  const FROZEN = new Date("2026-08-02T20:00:00Z");

  it("has no 24h reference when GC has not printed since the cutoff", () => {
    const { tech } = overviewTechnical(FROZEN);
    expect(tech.spot!.value).toBe(3325.0);        // spot itself still renders
    expect(tech.spot!.delta24h).toBeNull();
    expect(tech.spot!.pct24h).toBeNull();
  });

  it("renders '24h —' rather than asserting gold is unchanged", () => {
    const { html } = overviewTechnical(FROZEN);
    expect(html).toContain("24h —");
    expect(html).not.toContain("= 0");     // the flat rendering, verbatim
    expect(html).not.toContain("0.00%");
    expect(html).not.toContain("▲");
    expect(html).not.toContain("▼");
  });

  it("still computes a real delta while the feed is live", () => {
    // 2026-08-01T12:00Z: cutoff 07-31T12:00Z, so the 07-31T08:00Z bar (3310.5)
    // is a genuinely earlier observation than the 08-01T08:00Z latest (3325).
    const { tech, html } = overviewTechnical(new Date("2026-08-01T12:00:00Z"));
    expect(tech.spot!.delta24h).toBeCloseTo(14.5, 6);
    expect(html).toContain("▲");
    expect(html).not.toContain("24h —");
  });
});
