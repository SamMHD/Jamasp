import { describe, expect, it } from "vitest";
import { resolveStateFilter } from "@/app/predictions/page";
import { predictionStats, type Prediction } from "@/lib/files";
import {
  buildLedger, countByState, isResolved, maturesAt, predictionState,
} from "@/lib/predictions";

const NOW = new Date("2026-08-10T00:00:00Z");

function pred(over: Partial<Prediction> = {}): Prediction {
  return {
    id: "p1", date: "2026-08-01", claim: "GC holds 3300", direction: "up",
    horizon_days: 5, confidence: 0.7, created_at: "2026-08-01T00:00:00Z",
    outcome: null, scored_at: null, note: null, ...over,
  };
}

describe("predictionState", () => {
  it("reads the three ledger outcomes straight through", () => {
    for (const outcome of ["hit", "miss", "unclear"] as const) {
      expect(predictionState(pred({ outcome }), NOW)).toBe(outcome);
    }
  });

  it("splits unscored on maturity: created_at + horizon_days", () => {
    // Made 9 days ago, 5-day horizon — matured on the 6th, four days back.
    expect(predictionState(pred({ horizon_days: 5 }), NOW)).toBe("due");
    // Same claim with a 30-day horizon is still running.
    expect(predictionState(pred({ horizon_days: 30 }), NOW)).toBe("open");
  });

  it("treats the maturity instant itself as due, matching predictions.py#due", () => {
    // predictions.py: `created + timedelta(days=h) <= now` — inclusive.
    expect(predictionState(
      pred({ created_at: "2026-08-05T00:00:00Z", horizon_days: 5 }), NOW)).toBe("due");
  });

  it("calls a malformed created_at open, never overdue", () => {
    // NaN <= now is false. An unreadable ledger line must not manufacture
    // work for the desk by appearing on the due list.
    const p = pred({ created_at: "not-a-date" });
    expect(Number.isNaN(maturesAt(p))).toBe(true);
    expect(predictionState(p, NOW)).toBe("open");
  });

  it("does not accept an unrecognised outcome as a fourth outcome", () => {
    expect(predictionState(pred({ outcome: "partially" }), NOW)).toBe("due");
  });

  it("agrees with isResolved", () => {
    expect(["hit", "miss", "unclear"].every(s =>
      isResolved(s as "hit"))).toBe(true);
    expect(isResolved("due")).toBe(false);
    expect(isResolved("open")).toBe(false);
  });
});

/**
 * The reconciliation guard. The overview's Forecast-record card renders
 * predictionStats; this page renders buildLedger/countByState. If those two
 * ever classify a prediction differently the desk sees two different truths
 * about the same ledger on two pages, which is worse than either being wrong.
 */
describe("the ledger and the Forecast-record card cannot disagree", () => {
  const ledger: Prediction[] = [
    pred({ id: "a", outcome: "hit" }),
    pred({ id: "b", outcome: "hit" }),
    pred({ id: "c", outcome: "miss" }),
    pred({ id: "d", outcome: "unclear" }),
    pred({ id: "e", horizon_days: 30 }),                       // open
    pred({ id: "f", horizon_days: 2 }),                        // due
    pred({ id: "g", created_at: "garbage", horizon_days: 1 }),  // open (NaN)
    pred({ id: "h", outcome: "bogus", horizon_days: 1 }),       // due
  ];

  it("matches count for count", () => {
    const counts = countByState(buildLedger(ledger, NOW));
    const stats = predictionStats(ledger, NOW);
    expect(counts).toEqual({ due: 2, open: 2, hit: 2, miss: 1, unclear: 1 });
    expect(stats.hits).toBe(counts.hit);
    expect(stats.misses).toBe(counts.miss);
    expect(stats.unclear).toBe(counts.unclear);
    expect(stats.open).toBe(counts.open);
    expect(stats.maturedUnscored).toBe(counts.due);
    expect(stats.scored).toBe(counts.hit + counts.miss + counts.unclear);
  });

  it("accounts for every row exactly once", () => {
    const rows = buildLedger(ledger, NOW);
    expect(rows).toHaveLength(ledger.length);
    const counts = countByState(rows);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(ledger.length);
  });
});

describe("buildLedger ordering", () => {
  it("puts live rows first, most overdue leading, then soonest to mature", () => {
    const rows = buildLedger([
      pred({ id: "scored", outcome: "hit", scored_at: "2026-08-09T00:00:00Z" }),
      pred({ id: "soon", created_at: "2026-08-09T00:00:00Z", horizon_days: 2 }),
      pred({ id: "later", created_at: "2026-08-09T00:00:00Z", horizon_days: 9 }),
      pred({ id: "veryOverdue", created_at: "2026-07-01T00:00:00Z", horizon_days: 1 }),
      pred({ id: "justOverdue", created_at: "2026-08-08T00:00:00Z", horizon_days: 1 }),
    ], NOW);
    expect(rows.map(r => r.pred.id))
      .toEqual(["veryOverdue", "justOverdue", "soon", "later", "scored"]);
  });

  it("sinks a malformed maturity to the end of the live group, not the top", () => {
    const rows = buildLedger([
      pred({ id: "broken", created_at: "nope" }),
      pred({ id: "overdue", created_at: "2026-08-01T00:00:00Z", horizon_days: 1 }),
      pred({ id: "done", outcome: "miss", scored_at: "2026-08-02T00:00:00Z" }),
    ], NOW);
    expect(rows.map(r => r.pred.id)).toEqual(["overdue", "broken", "done"]);
  });

  it("orders resolved rows newest-scored first, falling back to created_at", () => {
    const rows = buildLedger([
      pred({ id: "old", outcome: "hit", scored_at: "2026-07-01T00:00:00Z" }),
      pred({ id: "new", outcome: "miss", scored_at: "2026-08-09T00:00:00Z" }),
      // Scored by hand with no scored_at: ordered by when it was made.
      pred({ id: "mid", outcome: "hit", created_at: "2026-08-05T00:00:00Z", scored_at: null }),
    ], NOW);
    expect(rows.map(r => r.pred.id)).toEqual(["new", "mid", "old"]);
  });

  it("breaks remaining ties on id so the order is stable across renders", () => {
    const same = { outcome: "hit", scored_at: "2026-08-09T00:00:00Z" } as const;
    const rows = buildLedger([pred({ id: "zz", ...same }), pred({ id: "aa", ...same })], NOW);
    expect(rows.map(r => r.pred.id)).toEqual(["aa", "zz"]);
  });

  it("handles an empty ledger", () => {
    expect(buildLedger([], NOW)).toEqual([]);
    expect(countByState([])).toEqual({ due: 0, open: 0, hit: 0, miss: 0, unclear: 0 });
  });
});

describe("resolveStateFilter", () => {
  it("accepts each of the five states", () => {
    for (const s of ["due", "open", "hit", "miss", "unclear"] as const) {
      expect(resolveStateFilter(s)).toBe(s);
    }
  });

  it("falls back to the whole ledger on absent, repeated or garbage input", () => {
    expect(resolveStateFilter(undefined)).toBe("all");
    expect(resolveStateFilter("")).toBe("all");
    expect(resolveStateFilter("scored")).toBe("all");
    // A repeated ?state= arrives as an array; the first value wins.
    expect(resolveStateFilter(["hit", "miss"])).toBe("hit");
    expect(resolveStateFilter(["nonsense"])).toBe("all");
  });
});
