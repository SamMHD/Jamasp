import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let files: typeof import("../lib/files");

beforeAll(async () => {
  process.env.JAMASP_ROOT = path.resolve(__dirname, "fixtures/root");
  files = await import("../lib/files");
});

/**
 * Run `fn` against a throwaway JAMASP_ROOT containing exactly `contents`.
 *
 * lib/paths.ts resolves JAMASP_ROOT at module load, so the module has to be
 * re-imported after the env var changes — hence resetModules. A separate root
 * matters here specifically: this file's shared fixture root also receives a
 * state/weights.json from `npm run fixture`, which would make the
 * file-is-absent assertion below depend on whether e2e had been built.
 */
async function withRoot(
  contents: Record<string, string>,
  fn: (m: typeof import("../lib/files")) => void,
) {
  const root = mkdtempSync(path.join(tmpdir(), "jamasp-weights-"));
  mkdirSync(path.join(root, "state"), { recursive: true });
  for (const [rel, body] of Object.entries(contents)) {
    writeFileSync(path.join(root, rel), body);
  }
  const prev = process.env.JAMASP_ROOT;
  process.env.JAMASP_ROOT = root;
  vi.resetModules();
  try {
    fn(await import("../lib/files"));
  } finally {
    process.env.JAMASP_ROOT = prev;
    vi.resetModules();
    rmSync(root, { recursive: true, force: true });
  }
}

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
    // scored=3 and unclear=1 (aaaa0005 added), but hitRate stays 0.5 = hits/(hits+misses):
    // if unclear were folded into the denominator, hitRate would be 1/3, not 1/2 — this
    // proves unclear is excluded from the hitRate denominator.
    expect(stats).toEqual({ open: 1, maturedUnscored: 1, scored: 3,
      hits: 1, misses: 1, unclear: 1, hitRate: 0.5 });
  });
  it("lists and reads reports, guarding traversal", () => {
    // Two reports in different months; if the sort direction were flipped (or removed),
    // this would list 2026-07-31 first instead of 2026-08-01.
    expect(files.listReports()).toEqual([
      { slug: "2026/08/2026-08-01-brief", date: "2026-08-01" },
      { slug: "2026/07/2026-07-31-brief", date: "2026-07-31" },
    ]);
    expect(files.readReport("2026/07/2026-07-31-brief")).toContain("Morning Brief");
    expect(files.readReport("../../../etc/passwd")).toBeNull();
  });
});

describe("readFittedWeights", () => {
  const doc = JSON.stringify({
    fitted_at: "2026-08-20T04:17:00Z",
    fits: { technical: { n: 16880, horizon_hours: 24, flags: [],
      coefficients: { "rsi14@1d": { beta: 0.03, se: 0.008, multiplier: 1.4,
                                    observations: 900, fitted: true } } } },
  });

  it("parses state/weights.json into camelCase", async () => {
    await withRoot({ "state/weights.json": doc }, m => {
      const w = m.readFittedWeights()!;
      expect(w.fittedAt).toBe("2026-08-20T04:17:00Z");
      expect(w.fits.technical.n).toBe(16880);
      expect(w.fits.technical.horizonHours).toBe(24);
      expect(w.fits.technical.coefficients["rsi14@1d"].multiplier).toBe(1.4);
    });
  });

  it("returns null when the file does not exist", async () => {
    // It will not, until the first `jamasp weights fit` runs. Every tile
    // renders neutral and dashed in that window rather than the page failing.
    await withRoot({}, m => expect(m.readFittedWeights()).toBeNull());
  });

  it("returns null on malformed JSON rather than throwing", async () => {
    // A fit interrupted mid-write would surface as a JSON parse error on a
    // live page. write_results renames into place for that reason; this is
    // the belt to that braces.
    await withRoot({ "state/weights.json": "{ truncated" }, m => {
      expect(() => m.readFittedWeights()).not.toThrow();
      expect(m.readFittedWeights()).toBeNull();
    });
  });
});
