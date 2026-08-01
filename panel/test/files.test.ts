import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";

let files: typeof import("../lib/files");

beforeAll(async () => {
  process.env.JAMASP_ROOT = path.resolve(__dirname, "fixtures/root");
  files = await import("../lib/files");
});

describe("files layer", () => {
  it("reads stance and playbook, null when missing", () => {
    expect(files.readStance()).toContain("Gold constructive");
    expect(files.readPlaybook()).toContain("Playbook");
  });
  it("parses watchlist and sources", () => {
    expect(files.readWatchlist()[0].theme).toBe("fed-rate-path");
    expect(files.loadSources().map(s => s.name)).toEqual(
      ["cnbc_finance", "investing_commodities"]);
    expect(files.maxRunsPerDay()).toBe(20);
  });
  it("computes prediction stats", () => {
    const stats = files.predictionStats(files.readPredictions(),
      new Date("2026-08-01T12:00:00Z"));
    expect(stats).toEqual({ open: 1, maturedUnscored: 1, scored: 2,
      hits: 1, misses: 1, unclear: 0, hitRate: 0.5 });
  });
  it("lists and reads reports, guarding traversal", () => {
    expect(files.listReports()).toEqual([{ slug: "2026/07/2026-07-31-brief",
      date: "2026-07-31" }]);
    expect(files.readReport("2026/07/2026-07-31-brief")).toContain("Morning Brief");
    expect(files.readReport("../../../etc/passwd")).toBeNull();
  });
});
