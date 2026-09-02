import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusStrip, FooterStrip } from "../components/status-strip";
import type { AgentRunRow, EventRow, NotifyLogRow, WakeupRow } from "../lib/db";

const NOW = new Date("2026-08-01T12:00:00Z");

const run = (run_type: string, status: string, started_at: string): AgentRunRow => ({
  id: Math.floor(Math.random() * 100000), run_type, task: null,
  started_at, finished_at: started_at, exit_code: status === "ok" ? 0 : 1, status,
});

// brief 6h ago (ok), scan 1h ago (ok), deepdive 2h ago (failed); retro is
// deliberately absent so it exercises the never-run branch by default.
const BASE_RUNS: AgentRunRow[] = [
  run("brief", "ok", "2026-08-01T06:00:00Z"),
  run("scan", "ok", "2026-08-01T11:00:00Z"),
  run("deepdive", "failed", "2026-08-01T10:00:00Z"),
];

type StatusStripProps = Parameters<typeof StatusStrip>[0];

const BASE: StatusStripProps = {
  lastIngest: "2026-08-01T11:55:00Z", // 5m ago: fresh
  runsToday: 3,
  cap: 12,
  sourceErrors: 0,
  lastRuns: BASE_RUNS,
  now: NOW,
};

const render = (props: StatusStripProps) => renderToStaticMarkup(<StatusStrip {...props} />);

describe("StatusStrip — ingest staleness", () => {
  it("colors a fresh ingest emerald and shows its age", () => {
    const html = render(BASE);
    expect(html).toContain("5m ago");
    expect(html).toContain("text-up");
    expect(html).not.toContain("text-destructive");
  });

  // Guard audit: `lastIngest === null || ...` — a null lastIngest fed straight
  // into fmtAge (as `new Date(null)` coerces to the epoch, not NaN) renders a
  // confident-looking "20677d ago" instead of "never". The ternary that picks
  // "never" text must stay paired with the ingestStale check that colors it
  // red, or a pipeline that has never ingested would read as ancient-but-fine.
  it("treats a null lastIngest as stale and 'never', not a confident age", () => {
    const html = render({ ...BASE, lastIngest: null, lastRuns: [] });
    expect(html).toContain("never");
    expect(html).toContain("text-destructive");
    expect(html).not.toContain("ago");
  });

  it("flags an ingest just over an hour old as stale", () => {
    const html = render({ ...BASE, lastIngest: "2026-08-01T10:59:00Z" }); // 61m ago
    expect(html).toContain("text-destructive");
    expect(html).toContain("1h ago");
  });

  // Same rendered age text as the previous case (both round to "1h ago") but
  // opposite color — isolates the `> 60min` boundary from the age label.
  it("treats an ingest exactly one hour old as still fresh", () => {
    const html = render({ ...BASE, lastIngest: "2026-08-01T11:00:00Z" }); // 60m ago
    expect(html).toContain("1h ago");
    expect(html).not.toContain("text-destructive");
  });
});

describe("StatusStrip — runs and source errors", () => {
  it("highlights runs-today once the cap is reached", () => {
    const html = render({ ...BASE, runsToday: 12, cap: 12 });
    expect(html).toContain("text-primary");
  });

  it("stays quiet on a healthy, under-cap, error-free run", () => {
    const html = render({ ...BASE, runsToday: 3, cap: 12, sourceErrors: 0 });
    expect(html).not.toContain("text-primary");
    expect(html).not.toContain("text-destructive");
  });

  it("flags nonzero source errors as amber", () => {
    const html = render({ ...BASE, sourceErrors: 4 });
    expect(html).toContain("text-primary");
    expect(html).toContain("4");
  });
});

describe("StatusStrip — per-run-type dots", () => {
  // Domain fact: a run_type absent from lastRunPerType() has never run at
  // all — unknown, not healthy. It must not share a dot with any real status.
  it("marks a run type that has never run with a dim grey dot and a distinct tooltip", () => {
    const html = render(BASE); // retro is absent from BASE_RUNS
    expect(html).toContain("retro: never run");
    expect(html).toContain("bg-muted-foreground/40");
  });

  it("colors ok/failed/deferred with their mapped dot colors", () => {
    const html = render({
      ...BASE,
      lastRuns: [
        run("brief", "ok", "2026-08-01T06:00:00Z"),
        run("scan", "failed", "2026-08-01T11:00:00Z"),
        run("deepdive", "deferred", "2026-08-01T10:00:00Z"),
      ],
    });
    expect(html).toContain("bg-up");
    expect(html).toContain("bg-destructive");
    // deferred means skipped-by-cap, not broken — amber, never destructive red.
    expect(html).toContain("bg-primary");
  });

  // An `empty` run exited 0, burnt a slot from the daily cap, and committed
  // nothing — a problem needing attention, not an unknown. Grey would read as
  // never-run; runBadge already treats it as destructive, so the dot matches.
  it("colors an empty run destructive, not the unknown-status grey", () => {
    const html = render({
      ...BASE,
      lastRuns: [...BASE_RUNS, run("retro", "empty", "2026-08-01T09:00:00Z")],
    });
    expect(html).toContain("retro: empty");
    expect(html).not.toMatch(/rounded-full bg-muted-foreground"/);
  });

  // Guard audit: `DOT[r.status] ?? "bg-muted-foreground"`. An unrecognised
  // status string must not vanish (undefined class) or silently borrow
  // another status's color, and its fallback grey must read as distinct
  // pixels from the dimmer never-run grey above (full vs. 40% opacity).
  it("falls back to a full-opacity grey for an unrecognised status, distinct from never-run", () => {
    const html = render({
      ...BASE,
      lastRuns: [...BASE_RUNS, run("retro", "queued", "2026-08-01T09:00:00Z")],
    });
    expect(html).toContain("retro: queued");
    expect(html).toMatch(/rounded-full bg-muted-foreground"/); // full opacity, no /40 suffix
    expect(html).not.toContain("bg-muted-foreground/40"); // every type in this fixture has run
  });
});

const renderFooter = (props: {
  wakeup: WakeupRow | undefined; event: EventRow | undefined;
  lastAlert: NotifyLogRow | undefined; now: Date;
}) => renderToStaticMarkup(<FooterStrip {...props} />);

const wakeup: WakeupRow = { id: 7, due_at: "2026-08-01T14:00:00Z", run_type: "deepdive",
  task: "read the Fed statement", status: "pending", attempts: 0,
  created_at: "2026-08-01T10:00:00Z", fired_at: null };

const event: EventRow = { id: "e1", source: "econ-cal", title: "US CPI",
  country: "US", impact: "high", starts_at: "2026-08-01T13:30:00Z",
  fetched_at: "2026-08-01T09:00:00Z" };

const alert: NotifyLogRow = { id: 3, ts: "2026-08-01T11:00:00Z", text: "desk alert text", ok: 1 };

describe("FooterStrip", () => {
  it("links to the next pending wakeup", () => {
    const html = renderFooter({ wakeup, event: undefined, lastAlert: undefined, now: NOW });
    expect(html).toContain("#7");
    expect(html).toContain("deepdive");
    expect(html).toContain("in 2h");
  });

  it("links to the next upcoming event", () => {
    const html = renderFooter({ wakeup: undefined, event, lastAlert: undefined, now: NOW });
    expect(html).toContain("US CPI");
  });

  it("links to the last alert's age", () => {
    const html = renderFooter({ wakeup: undefined, event: undefined, lastAlert: alert, now: NOW });
    expect(html).toContain("1h ago");
  });

  // Guard audit: each of these three is an independent ternary; deleting any
  // one turns `undefined.id` / `undefined.title` / `undefined.ts` into a
  // render-time crash. None of these states are edge cases in practice — a
  // quiet desk with nothing scheduled and no alerts fired is the common case.
  it("renders all three absent states together without crashing", () => {
    const html = renderFooter({ wakeup: undefined, event: undefined, lastAlert: undefined, now: NOW });
    expect(html).toContain("next wakeup: none pending");
    expect(html).toContain("next event: nothing upcoming");
    // Qualified by its label: a bare "none" is satisfied by the wakeup
    // branch's "none pending" a few spans earlier, so it asserted nothing at
    // all about the last-alert fallback.
    expect(html).toContain("last alert: none");
  });
});
