import { describe, expect, it } from "vitest";
import { deriveSourceHealth, deriveWarnings } from "../lib/health";
import type { SourceConfig } from "../lib/files";

const NOW = new Date("2026-08-01T12:00:00Z");
const src = (name: string, intervalMinutes = 15): SourceConfig =>
  ({ name, type: "rss", url: "u", interval_minutes: intervalMinutes });

describe("deriveSourceHealth", () => {
  it("classifies ok / stale / never / erroring and sorts worst-first", () => {
    const health = deriveSourceHealth(
      [src("fresh"), src("stale"), src("dead"), src("errs")],
      { fresh: "2026-08-01T11:50:00Z", stale: "2026-08-01T09:00:00Z",
        dead: null, errs: "2026-08-01T11:50:00Z" },
      { fresh: "2026-08-01T11:50:00Z" },
      [
        { source: "errs", ts: "2026-08-01T11:00:00Z", error: "403" },
        { source: "errs", ts: "2026-08-01T10:00:00Z", error: "403" },
        { source: "errs", ts: "2026-08-01T09:00:00Z", error: "403" },
      ],
      NOW,
    );
    expect(health.map(h => [h.name, h.state])).toEqual([
      ["errs", "erroring"], ["stale", "stale"], ["dead", "never"], ["fresh", "ok"],
    ]);
  });

  it("returns an empty array for an empty sources list (no throw)", () => {
    expect(deriveSourceHealth([], {}, {}, [], NOW)).toEqual([]);
  });

  it("stale boundary: exactly at the 60-minute floor is ok, one minute past is stale", () => {
    // interval=15 -> 3*interval=45 < 60, so the floor of 60 minutes applies.
    const health = deriveSourceHealth(
      [src("atFloor", 15), src("pastFloor", 15)],
      { atFloor: "2026-08-01T11:00:00Z", pastFloor: "2026-08-01T10:59:00Z" },
      {},
      [],
      NOW,
    );
    const byName = Object.fromEntries(health.map(h => [h.name, h.state]));
    expect(byName.atFloor).toBe("ok");
    expect(byName.pastFloor).toBe("stale");
  });

  it("stale boundary: uses 3x interval when it exceeds the 60-minute floor", () => {
    // interval=30 -> 3*interval=90 > 60, so cutoff is 90 minutes, not 60.
    const health = deriveSourceHealth(
      [src("atCutoff", 30), src("pastCutoff", 30)],
      { atCutoff: "2026-08-01T10:30:00Z", pastCutoff: "2026-08-01T10:29:00Z" },
      {},
      [],
      NOW,
    );
    const byName = Object.fromEntries(health.map(h => [h.name, h.state]));
    expect(byName.atCutoff).toBe("ok");
    expect(byName.pastCutoff).toBe("stale");
  });

  it("erroring count trigger: exactly 3 errors flips a fresh source to erroring", () => {
    const health = deriveSourceHealth(
      [src("s", 15)],
      { s: "2026-08-01T11:55:00Z" }, // 5 min old, well within any staleness cutoff
      {},
      [
        { source: "s", ts: "2026-08-01T11:00:00Z", error: "e" },
        { source: "s", ts: "2026-08-01T10:30:00Z", error: "e" },
        { source: "s", ts: "2026-08-01T10:00:00Z", error: "e" },
      ],
      NOW,
    );
    expect(health[0].state).toBe("erroring");
  });

  it("erroring count trigger: 2 errors alone (fresh, low age) does not trigger erroring", () => {
    const health = deriveSourceHealth(
      [src("s", 15)],
      { s: "2026-08-01T11:55:00Z" },
      {},
      [
        { source: "s", ts: "2026-08-01T11:00:00Z", error: "e" },
        { source: "s", ts: "2026-08-01T10:30:00Z", error: "e" },
      ],
      NOW,
    );
    expect(health[0].state).toBe("ok");
  });

  it("erroring age trigger: 1 error only counts once lastFetch is older than 2x interval", () => {
    // interval=15 -> 2*interval=30 minutes.
    const notYet = deriveSourceHealth(
      [src("s", 15)],
      { s: "2026-08-01T11:30:00Z" }, // exactly 30 min old
      {},
      [{ source: "s", ts: "2026-08-01T11:00:00Z", error: "e" }],
      NOW,
    );
    expect(notYet[0].state).toBe("ok"); // age not strictly greater than 2x interval

    const past = deriveSourceHealth(
      [src("s", 15)],
      { s: "2026-08-01T11:29:00Z" }, // 31 min old
      {},
      [{ source: "s", ts: "2026-08-01T11:00:00Z", error: "e" }],
      NOW,
    );
    expect(past[0].state).toBe("erroring");
  });

  it("erroring takes precedence over never when an unfetched source has an error", () => {
    const health = deriveSourceHealth(
      [src("s", 15)],
      { s: null },
      {},
      [{ source: "s", ts: "2026-08-01T11:00:00Z", error: "e" }],
      NOW,
    );
    expect(health[0].state).toBe("erroring");
  });

  it("sorts alphabetically within the same state", () => {
    const health = deriveSourceHealth(
      [src("zebra", 15), src("alpha", 15)],
      { zebra: "2026-08-01T11:55:00Z", alpha: "2026-08-01T11:55:00Z" },
      {},
      [],
      NOW,
    );
    expect(health.map(h => h.name)).toEqual(["alpha", "zebra"]);
  });
});

describe("deriveWarnings", () => {
  it("flags stale ingest, bad runs, cap", () => {
    const w = deriveWarnings({
      lastIngestAt: "2026-08-01T10:00:00Z",   // 2h old -> red
      runs: [
        { id: 1, run_type: "scan", task: null, started_at: "2026-08-01T07:00:00Z",
          finished_at: "2026-08-01T07:02:00Z", exit_code: 1, status: "failed" },
        { id: 2, run_type: "brief", task: null, started_at: "2026-08-01T05:00:00Z",
          finished_at: "2026-08-01T05:09:00Z", exit_code: 0, status: "ok" },
      ],
      sourceHealth: [], runsToday: 20, cap: 20,
    }, NOW);
    const reds = w.filter(x => x.severity === "red");
    expect(reds.some(x => x.text.includes("ingest stale"))).toBe(true);
    expect(reds.some(x => x.text.includes("scan") && x.text.includes("failed"))).toBe(true);
    expect(w.some(x => x.severity === "amber" && x.text.includes("cap"))).toBe(true);
  });

  it("is empty when everything is healthy", () => {
    expect(deriveWarnings({
      lastIngestAt: "2026-08-01T11:50:00Z",
      runs: [], sourceHealth: [], runsToday: 3, cap: 20,
    }, NOW)).toEqual([]);
  });

  it("ingest-stale boundary: exactly 60 minutes old is fine, one minute more is stale", () => {
    const atBoundary = deriveWarnings({
      lastIngestAt: "2026-08-01T11:00:00Z", // exactly 60 min old
      runs: [], sourceHealth: [], runsToday: 0, cap: 20,
    }, NOW);
    expect(atBoundary.some(x => x.text.includes("ingest stale"))).toBe(false);

    const pastBoundary = deriveWarnings({
      lastIngestAt: "2026-08-01T10:59:00Z", // 61 min old
      runs: [], sourceHealth: [], runsToday: 0, cap: 20,
    }, NOW);
    expect(pastBoundary.some(x => x.severity === "red" && x.text.includes("ingest stale"))).toBe(true);
  });

  it("treats a missing lastIngestAt as stale (no throw)", () => {
    const w = deriveWarnings({
      lastIngestAt: null,
      runs: [], sourceHealth: [], runsToday: 0, cap: 20,
    }, NOW);
    expect(w.some(x => x.severity === "red" && x.text.includes("ingest stale"))).toBe(true);
  });

  it("48h window boundary: a run exactly 48h old counts, one minute older is dropped", () => {
    const w = deriveWarnings({
      lastIngestAt: "2026-08-01T11:50:00Z",
      runs: [
        { id: 1, run_type: "scan", task: null, started_at: "2026-07-30T12:00:00Z", // exactly 48h old
          finished_at: "2026-07-30T12:02:00Z", exit_code: 1, status: "failed" },
        { id: 2, run_type: "brief", task: null, started_at: "2026-07-30T11:59:00Z", // 48h01m old
          finished_at: "2026-07-30T12:05:00Z", exit_code: 1, status: "failed" },
      ],
      sourceHealth: [], runsToday: 0, cap: 20,
    }, NOW);
    const reds = w.filter(x => x.severity === "red");
    expect(reds.some(x => x.text.includes("scan"))).toBe(true);
    expect(reds.some(x => x.text.includes("brief"))).toBe(false);
  });

  it("flags a deferred run in the last 48h as amber", () => {
    const w = deriveWarnings({
      lastIngestAt: "2026-08-01T11:50:00Z",
      runs: [
        { id: 1, run_type: "deepdive", task: "t", started_at: "2026-08-01T09:00:00Z",
          finished_at: null, exit_code: null, status: "deferred" },
      ],
      sourceHealth: [], runsToday: 0, cap: 20,
    }, NOW);
    expect(w).toEqual([{ severity: "amber",
      text: "deepdive run deferred at 2026-08-01T09:00:00Z" }]);
  });

  it("cap boundary: below cap is silent, at cap warns", () => {
    const under = deriveWarnings({
      lastIngestAt: "2026-08-01T11:50:00Z",
      runs: [], sourceHealth: [], runsToday: 19, cap: 20,
    }, NOW);
    expect(under.some(x => x.text.includes("cap"))).toBe(false);

    const atCap = deriveWarnings({
      lastIngestAt: "2026-08-01T11:50:00Z",
      runs: [], sourceHealth: [], runsToday: 20, cap: 20,
    }, NOW);
    expect(atCap.some(x => x.severity === "amber" && x.text.includes("cap"))).toBe(true);
  });

  it("lists erroring/stale sources by name in a single amber warning", () => {
    const w = deriveWarnings({
      lastIngestAt: "2026-08-01T11:50:00Z",
      runs: [],
      sourceHealth: [
        { name: "bad", type: "rss", intervalMinutes: 15, lastFetch: null, lastItem: null,
          errors24h: 3, state: "erroring" },
        { name: "old", type: "rss", intervalMinutes: 15, lastFetch: "2026-08-01T09:00:00Z",
          lastItem: null, errors24h: 0, state: "stale" },
        { name: "fine", type: "rss", intervalMinutes: 15, lastFetch: "2026-08-01T11:55:00Z",
          lastItem: null, errors24h: 0, state: "ok" },
      ],
      runsToday: 0, cap: 20,
    }, NOW);
    const unhealthy = w.find(x => x.severity === "amber" && x.text.includes("unhealthy"));
    expect(unhealthy).toBeDefined();
    expect(unhealthy!.text).toContain("bad");
    expect(unhealthy!.text).toContain("old");
    expect(unhealthy!.text).not.toContain("fine");
  });
});
