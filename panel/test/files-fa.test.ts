import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Same tmpdir/JAMASP_ROOT fixture pattern as test/files.test.ts, reused
 * rather than reinvented: lib/paths.ts resolves JAMASP_ROOT at module load,
 * so the module must be re-imported (vi.resetModules) after the env var
 * changes.
 */
async function withRoot(
  contents: Record<string, string>,
  fn: (m: typeof import("../lib/files")) => void,
) {
  const root = mkdtempSync(path.join(tmpdir(), "jamasp-fa-"));
  mkdirSync(path.join(root, "state"), { recursive: true });
  for (const [rel, body] of Object.entries(contents)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
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

/** sha256 hex of the English source's exact bytes — never hard-coded. */
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const frontMatter = (srcHash: string) =>
  `---\nsrc_hash: ${srcHash}\ntranslated_at: 2026-09-20T10:00:00Z\ntranslator: codex\n---\n`;

describe("readPlaybookFa", () => {
  const english = "# Playbook\n\nHold the line on real yields.\n";
  const persian = "نگه‌داشتن خط در بازده واقعی.\n";

  it("returns the Persian body when the sidecar's src_hash matches the source", async () => {
    await withRoot({
      "state/playbook.md": english,
      "state/playbook.fa.md": frontMatter(hash(english)) + persian,
    }, m => {
      expect(m.readPlaybookFa()).toBe(persian);
    });
  });

  it("returns null when the recorded hash does not match the source", async () => {
    await withRoot({
      "state/playbook.md": english,
      // Stamped with a hash of something else entirely — the source moved
      // on since this sidecar was written, so it must not render.
      "state/playbook.fa.md": frontMatter(hash("a different english document")) + persian,
    }, m => {
      expect(m.readPlaybookFa()).toBeNull();
    });
  });

  it("returns null when the sidecar is absent", async () => {
    await withRoot({ "state/playbook.md": english }, m => {
      expect(m.readPlaybookFa()).toBeNull();
    });
  });

  it("returns null when the sidecar has no front matter at all", async () => {
    await withRoot({
      "state/playbook.md": english,
      // Doesn't open with "---\n", so it is a body with no metadata — never
      // a sidecar carrying a hash that happens to match.
      "state/playbook.fa.md": persian,
    }, m => {
      expect(m.readPlaybookFa()).toBeNull();
    });
  });

  it("returns null when the English source itself is missing", async () => {
    await withRoot({
      "state/playbook.fa.md": frontMatter(hash(english)) + persian,
    }, m => {
      expect(m.readPlaybookFa()).toBeNull();
    });
  });
});

describe("readStanceFa", () => {
  const english =
    "# Stance — 2026-09-20\n\nLead paragraph.\n\n## View\n\nBase case holds.\n" +
    "\n## What flips me\n\nA close above 4300.\n";

  it("returns sections in source order with their per-section hashes", async () => {
    // Mirrors jamasp/translatetext.py's split_sections exactly: position 0
    // is everything before the first "## " line (no heading line of its
    // own), and each subsequent chunk keeps the blank line right after its
    // "## " heading — the split is line-based, not paragraph-based.
    const preambleBody = "# Stance — 2026-09-20\n\nLead paragraph.\n\n";
    const viewBody = "\nBase case holds.\n\n";
    const flipsBody = "\nA close above 4300.\n";
    const preambleFa = "پاراگراف اصلی.\n";
    const viewFa = "سناریوی پایه برقرار است.\n";
    const flipsFa = "بسته شدن بالای ۴۳۰۰.\n";

    const sidecar =
      frontMatter(hash(english)) +
      `<!-- src_hash: ${hash(preambleBody)} -->\n${preambleFa}` +
      `## View\n<!-- src_hash: ${hash(viewBody)} -->\n${viewFa}` +
      `## What flips me\n<!-- src_hash: ${hash(flipsBody)} -->\n${flipsFa}`;

    await withRoot({
      "state/stance.md": english,
      "state/stance.fa.md": sidecar,
    }, m => {
      const result = m.readStanceFa();
      expect(result).not.toBeNull();
      expect(result!.sections).toEqual([
        { heading: "", hash: hash(preambleBody), body: preambleFa },
        { heading: "## View", hash: hash(viewBody), body: viewFa },
        { heading: "## What flips me", hash: hash(flipsBody), body: flipsFa },
      ]);
    });
  });

  it("returns null when the top-level src_hash does not match the source", async () => {
    await withRoot({
      "state/stance.md": english,
      "state/stance.fa.md": frontMatter(hash("stale content")) +
        `<!-- src_hash: ${hash("x")} -->\nمتن فارسی\n`,
    }, m => {
      expect(m.readStanceFa()).toBeNull();
    });
  });

  it("returns null when the sidecar is absent", async () => {
    await withRoot({ "state/stance.md": english }, m => {
      expect(m.readStanceFa()).toBeNull();
    });
  });

  it("returns null when the sidecar has no front matter at all", async () => {
    await withRoot({
      "state/stance.md": english,
      "state/stance.fa.md": `<!-- src_hash: ${hash("x")} -->\nمتن فارسی\n`,
    }, m => {
      expect(m.readStanceFa()).toBeNull();
    });
  });

  // Finding B3 (PR 1 review): translate_stance can leave a section carrying
  // its English body under an empty per-section hash — a failed or
  // budget-skipped section with no prior Persian to fall back to — while
  // the sidecar is otherwise usable. The reader must keep that section IN
  // PLACE, empty hash and all, rather than dropping it: the caller matches
  // sections to the English structure by array position, and dropping one
  // would shift every later section under the wrong heading.
  it("keeps a section with an empty per-section hash in position rather than dropping it", async () => {
    const preambleBody = "# Stance — 2026-09-20\n\nLead paragraph.\n\n";
    const viewBody = "\nBase case holds.\n\n";
    const flipsBody = "\nA close above 4300.\n";
    const preambleFa = "پاراگراف اصلی.\n";
    // "What flips me" failed translation this tick and had no earlier
    // Persian to keep, so the writer stamped it with an empty hash and its
    // literal (untranslated) English body.
    const sidecar =
      frontMatter(hash(english)) +
      `<!-- src_hash: ${hash(preambleBody)} -->\n${preambleFa}` +
      `## View\n<!-- src_hash: ${hash(viewBody)} -->\nسناریوی پایه برقرار است.\n` +
      `## What flips me\n<!-- src_hash:  -->\n${flipsBody}`;

    await withRoot({
      "state/stance.md": english,
      "state/stance.fa.md": sidecar,
    }, m => {
      const result = m.readStanceFa();
      expect(result).not.toBeNull();
      expect(result!.sections).toHaveLength(3);
      // Position preserved: the third section is still "What flips me",
      // not silently shifted or removed.
      expect(result!.sections[2]).toEqual({
        heading: "## What flips me", hash: "", body: flipsBody,
      });
      // The other two sections are untouched, real Persian.
      expect(result!.sections[0].hash).toBe(hash(preambleBody));
      expect(result!.sections[1].hash).toBe(hash(viewBody));
    });
  });
});

describe("readWatchlistFa", () => {
  const englishYaml =
    "watchlist:\n" +
    "  - theme: fed-rate-path\n    why: dominant driver of real yields\n    since: '2026-07-31'\n" +
    "  - theme: mecca-pact\n    why: Gulf supply-side risk\n    since: '2026-08-01'\n";

  it("keys Persian by theme, and a theme missing from the sidecar is simply absent", async () => {
    const fedWhy = "dominant driver of real yields";
    const fedFa = "محرک اصلی بازده واقعی";
    // Only fed-rate-path has a (current, matching) Persian entry; mecca-pact
    // never made it into the sidecar at all — e.g. still queued behind the
    // translate job's per-tick budget.
    const sidecar =
      "watchlist:\n" +
      `  - theme: fed-rate-path\n    why_fa: ${fedFa}\n    src_hash: ${hash(fedWhy)}\n`;

    await withRoot({
      "state/watchlist.yaml": englishYaml,
      "state/watchlist.fa.yaml": sidecar,
    }, m => {
      expect(m.readWatchlistFa()).toEqual({ "fed-rate-path": fedFa });
    });
  });

  it("drops a theme whose sidecar hash no longer matches its English why", async () => {
    const fedFa = "محرک اصلی بازده واقعی";
    const sidecar =
      "watchlist:\n" +
      `  - theme: fed-rate-path\n    why_fa: ${fedFa}\n    src_hash: ${hash("an older why text")}\n`;

    await withRoot({
      "state/watchlist.yaml": englishYaml,
      "state/watchlist.fa.yaml": sidecar,
    }, m => {
      expect(m.readWatchlistFa()).toEqual({});
    });
  });

  it("returns an empty map when the sidecar is absent", async () => {
    await withRoot({ "state/watchlist.yaml": englishYaml }, m => {
      expect(m.readWatchlistFa()).toEqual({});
    });
  });
});

describe("readPredictionsFa", () => {
  const claim = "Gold clears 3400 before the next FOMC.";
  const englishJsonl = JSON.stringify({ id: "p1", claim }) + "\n";

  it("keys Persian by prediction id when the hash matches", async () => {
    const claimFa = "طلا قبل از نشست بعدی FOMC از ۳۴۰۰ عبور می‌کند.";
    const sidecar = JSON.stringify({ id: "p1", claim_fa: claimFa, src_hash: hash(claim) }) + "\n";
    await withRoot({
      "state/predictions.jsonl": englishJsonl,
      "state/predictions.fa.jsonl": sidecar,
    }, m => {
      expect(m.readPredictionsFa()).toEqual({ p1: claimFa });
    });
  });

  it("omits a prediction whose sidecar hash is stale", async () => {
    const claimFa = "طلا قبل از نشست بعدی FOMC از ۳۴۰۰ عبور می‌کند.";
    const sidecar = JSON.stringify(
      { id: "p1", claim_fa: claimFa, src_hash: hash("a different claim") }) + "\n";
    await withRoot({
      "state/predictions.jsonl": englishJsonl,
      "state/predictions.fa.jsonl": sidecar,
    }, m => {
      expect(m.readPredictionsFa()).toEqual({});
    });
  });

  it("returns an empty map when the sidecar is absent", async () => {
    await withRoot({ "state/predictions.jsonl": englishJsonl }, m => {
      expect(m.readPredictionsFa()).toEqual({});
    });
  });
});

describe("readReportFa", () => {
  const english = "# Morning Brief — 2026-08-01\n\nGold constructive on soft CPI.\n";
  const persian = "گزارش صبحگاهی — طلا رو به رشد.\n";

  it("returns the Persian body for a matching report sidecar", async () => {
    await withRoot({
      "reports/2026/08/2026-08-01-brief.md": english,
      "reports/2026/08/2026-08-01-brief.fa.md": frontMatter(hash(english)) + persian,
    }, m => {
      expect(m.readReportFa(["2026", "08", "2026-08-01-brief"])).toBe(persian);
    });
  });

  it("returns null when the hash is stale", async () => {
    await withRoot({
      "reports/2026/08/2026-08-01-brief.md": english,
      "reports/2026/08/2026-08-01-brief.fa.md":
        frontMatter(hash("an older report body")) + persian,
    }, m => {
      expect(m.readReportFa(["2026", "08", "2026-08-01-brief"])).toBeNull();
    });
  });

  it("guards path traversal the same way readReport does", async () => {
    await withRoot({}, m => {
      expect(m.readReportFa(["..", "..", "..", "etc", "passwd"])).toBeNull();
    });
  });
});
