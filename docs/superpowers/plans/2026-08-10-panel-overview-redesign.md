# Panel Overview Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the panel's Overview page with two market panels — Fundamental (parsed from `state/stance.md`) and Technical (levels ladder derived from the `prices` table) — demoting machine-health content to a compact status strip.

**Architecture:** Follow the existing `lib/health.ts` pattern exactly: **pure derive functions in `lib/`, all database and filesystem reads in the page component.** Two new pure modules (`lib/stance.ts`, `lib/technicals.ts`) get unit-tested in isolation with no I/O; `app/page.tsx` does the reading and passes plain data into presentational components. One new batch query in `lib/db.ts`. Still a single `force-dynamic` server component.

**Tech Stack:** Next.js App Router (server components), TypeScript, Tailwind, shadcn/ui, `better-sqlite3` (read-only), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-10-panel-overview-redesign-design.md`

## Global Constraints

- **The panel never writes.** Reads are read-only SQLite plus `node:fs`. Every mutation in this codebase goes through the `jamasp` CLI. This plan adds no writes at all.
- **No buy/sell verdict anywhere in the technical panel.** `config/sources.yaml:283` records that TradingView's `Recommend.All` gauge is deliberately not stored, because "technicals annotate the macro read, they must not originate calls."
- **No price levels scraped from stance prose.** Ladder levels come from the `prices` table only.
- **The `regime` string is a port of `jamasp/pricesummary.py#_tech_line`, not a reimplementation.** Exact output strings: `above both`, `below both`, `above 50DMA, below 200DMA`, `below 50DMA, above 200DMA`. Comparisons are strict `>`, matching the Python.
- **All stance regexes run on unwrapped text.** Stance prose is hard-wrapped at ~72 characters, and *where* the wrap falls shifts run to run. Measured on real history: matching the full bolded weights sentence (`**Weights … conviction … .**`) line-by-line succeeds in only 1 of 10 versions, because that span reliably crosses a wrap; matching just the triplet and its parenthetical succeeds line-by-line in all 6 fixtures, because that shorter span happens to fit on one line each time. Unwrapping removes the dependence on wrap position entirely — do not treat the narrow pattern's current luck as a reason to skip it.
- **No agent contract change.** Do not touch `CLAUDE.md`, `.claude/skills/`, the `jamasp` CLI, or any state file format.
- **Read `node_modules/next/dist/docs/` before writing Next.js code** — per `panel/AGENTS.md`, this Next version has breaking changes versus training data.
- Test commands run from `panel/`: `npm test` (vitest), `npm run e2e` (Playwright), `npm run lint`.
- `npm run fixture` rebuilds `test/fixtures/root/state/jamasp.db` from `test/fixtures/fixture.sql`. Edit the **SQL**, not `build-fixture.mjs` (the spec said `build-fixture.mjs`; the actual data lives in `fixture.sql`).
- **`git show "$c:path"` is mangled by zsh** (`:s` history modifier). Wrap any such loop in `bash -c '…'`.

## File Structure

| File | Responsibility |
|---|---|
| `panel/lib/stance.ts` | **Create.** Pure parsing of `stance.md` text → `ParsedStance`. No I/O. |
| `panel/lib/technicals.ts` | **Create.** Pure derivation of ladder + regime + staleness from quotes. No I/O. |
| `panel/lib/db.ts` | **Modify.** Add `latestPrices(symbols)` batch query and export `priceAtOrBeforeValue(symbol, ts)`. |
| `panel/components/level-ladder.tsx` | **Create.** Presentational ladder + exported `ladderGaps` helper. |
| `panel/components/sparkline.tsx` | **Create.** Inline-SVG sparkline, server-rendered, no recharts. |
| `panel/components/technical-panel.tsx` | **Create.** Composes ladder, regime, indicators, sparkline. |
| `panel/components/fundamental-panel.tsx` | **Create.** Composes stance sections + headline list. |
| `panel/components/status-strip.tsx` | **Create.** Compact ops row + footer strip. |
| `panel/app/page.tsx` | **Rewrite.** All reads; composes the above. |
| `panel/test/stance.test.ts` | **Create.** Against real historical stance fixtures. |
| `panel/test/technicals.test.ts` | **Create.** Ladder, regime matrix, staleness. |
| `panel/test/fixtures/stance/*.md` | **Create.** Six real stance versions from `origin/live`. |
| `panel/test/fixtures/fixture.sql` | **Modify.** Add GC technical series. |
| `panel/test/fixtures/root/state/stance.md` | **Modify.** Extend to full section structure. |
| `panel/e2e/smoke.spec.ts` | **Modify.** Assert both panels render. |
| `jamasp/pricesummary.py` | **Modify.** One comment naming the paired TS implementation. |

---

### Task 1: Real stance fixtures and paragraph unwrapping

**Files:**
- Create: `panel/test/fixtures/stance/` (six `.md` files)
- Create: `panel/lib/stance.ts`
- Create: `panel/test/stance.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `unwrapParagraphs(text: string): string`.

- [ ] **Step 1: Extract six real stance versions from git**

These are the actual commits. Run from the repo root. `bash -c` is required — zsh mangles `$c:state/stance.md`.

```bash
bash -c '
cd /Users/saman/Rabin/Jamasp
mkdir -p panel/test/fixtures/stance
set -- \
  a562aa587d045b803a46bb534f5d30f2f05ac889:brief-2026-08-10 \
  0689ebac71b1a38637c456ea011acb4fa722321d:scan-2026-08-09 \
  2412356133def77b96a56ff7411022be5c017a4f:brief-2026-08-09 \
  096ce4f26912e1367d2e8270211054064700ccb8:brief-2026-08-08 \
  bc6c419ad6bf14612b2f005e5529f40609179446:scan-2026-08-07 \
  fa18bcf3e670e440cafa845bfe5612cdef97bdf7:deepdive-2026-08-07 ;
for pair in "$@"; do
  sha=${pair%%:*}; name=${pair##*:}
  git show "$sha:state/stance.md" > "panel/test/fixtures/stance/$name.md"
done
wc -l panel/test/fixtures/stance/*.md
'
```

Expected: six files, each 60–110 lines. If any is empty, the commit is missing — fetch `origin/live` first (`git fetch origin live`).

- [ ] **Step 2: Write the failing test**

Create `panel/test/stance.test.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { unwrapParagraphs } from "../lib/stance";

const FIXTURE_DIR = path.resolve(__dirname, "fixtures/stance");
const fixture = (name: string) =>
  readFileSync(path.join(FIXTURE_DIR, `${name}.md`), "utf8");
const allFixtures = () =>
  readdirSync(FIXTURE_DIR).filter(f => f.endsWith(".md"))
    .map(f => [f, readFileSync(path.join(FIXTURE_DIR, f), "utf8")] as const);

describe("unwrapParagraphs", () => {
  it("joins a hard-wrapped sentence into one line", () => {
    const out = unwrapParagraphs("Weights 70/5/25 (base/event-bearish/kinetic),\nconviction capped by CPI.");
    expect(out).toBe("Weights 70/5/25 (base/event-bearish/kinetic), conviction capped by CPI.");
  });

  it("preserves blank lines between paragraphs", () => {
    expect(unwrapParagraphs("one\ntwo\n\nthree")).toBe("one two\n\nthree");
  });

  it("never absorbs the line after a heading", () => {
    expect(unwrapParagraphs("## View\nBase case holds.")).toBe("## View\nBase case holds.");
  });

  it("joins list-item continuations but keeps separate items apart", () => {
    const out = unwrapParagraphs("- **Base (~70%):** bid holds\n  into the print\n- **Tail (~25%):** arms on escalation");
    expect(out).toBe("- **Base (~70%):** bid holds into the print\n- **Tail (~25%):** arms on escalation");
  });

  it("leaves fenced code blocks untouched", () => {
    const src = "```\nline one\nline two\n```";
    expect(unwrapParagraphs(src)).toBe(src);
  });

  it("makes the weights line matchable in every real fixture", () => {
    const re = /Weights\s+(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\(([^)]+)\)/i;
    const hits = allFixtures().filter(([, text]) => re.test(unwrapParagraphs(text)));
    expect(hits.length).toBe(6);
  });

  /*
   * Why unwrapping is load-bearing, stated precisely.
   *
   * In the six fixtures as they stand, the triplet and its parenthetical
   * happen to fit on one line, so a line-based search would also find them
   * today. That is luck about where the ~72-char wrap landed, not a property
   * of the format: the surrounding bolded sentence DOES cross a wrap in most
   * versions. This test pins the mechanism against a wrap in the position
   * that currently doesn't occur, so the parser keeps working when it does.
   */
  it("recovers a weights line split across a wrap", () => {
    // [^)\n] cannot span a wrap. With [^)] this test would pass even if
    // unwrapParagraphs were the identity function, because a negated class
    // matches \n in JS.
    const re = /Weights\s+(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\([^)\n]+\)/i;
    const wrapped = "**Weights 70/5/25 (base/event-bearish/\nkinetic), conviction capped by CPI.**";
    expect(re.test(wrapped)).toBe(false);
    expect(re.test(unwrapParagraphs(wrapped))).toBe(true);
  });

  it("recovers the full bolded weights sentence, which crosses a wrap in real history", () => {
    // Raw and unwrapped are compared on the same whole-text basis, so the
    // difference measured here is unwrapping and nothing else. Verified:
    // 1 of 6 raw, 6 of 6 unwrapped.
    const sentence = /\*\*Weights[^*\n]*\*\*/;
    const rawHits = allFixtures().filter(([, text]) => sentence.test(text));
    const unwrappedHits = allFixtures().filter(([, text]) => sentence.test(unwrapParagraphs(text)));
    expect(rawHits.length).toBeLessThan(6);
    expect(unwrappedHits.length).toBe(6);
  });

  it("joins a continuation line starting with a comparison, not a blockquote", () => {
    const src = "- Fed speakers dismiss the payrolls print + Sept-hike odds rebound\n  >40% + GC loses 4300 → alibi rejected.";
    expect(unwrapParagraphs(src))
      .toBe("- Fed speakers dismiss the payrolls print + Sept-hike odds rebound >40% + GC loses 4300 → alibi rejected.");
  });

  it("still treats a real blockquote as a block boundary", () => {
    expect(unwrapParagraphs("intro line\n> quoted text")).toBe("intro line\n> quoted text");
  });

  it("is idempotent", () => {
    const once = unwrapParagraphs(fixture("brief-2026-08-10"));
    expect(unwrapParagraphs(once)).toBe(once);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd panel && npx vitest run test/stance.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/stance"`.

- [ ] **Step 4: Write the implementation**

Create `panel/lib/stance.ts`:

```ts
/**
 * Parsing for `state/stance.md` — the agent's current market view.
 *
 * The agent rewrites this file freehand every run, so only what has proven
 * stable across real history is parsed: the `##` section headings (stable
 * across every run inspected, though they take varying parenthetical
 * suffixes) and the `Weights a/b/c (…)` line inside `## View`. The preamble
 * between the H1 and the first `##` uses improvised bold labels every run
 * (`EVENT-PENDING`, `Kpler`, `Crowding`, `Mecca pact`) and is therefore
 * rendered verbatim, never parsed.
 */

/**
 * Lines that begin a new block and must never be folded into the previous
 * one. `>` only starts a blockquote when followed by whitespace or nothing
 * (a bare `>`) — `>40%`, as in a wrapped comparison, is prose, not a quote,
 * and appears as a real continuation line in two of the six fixtures.
 */
const BLOCK_START = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>(\s|$)|\|)/;
const HEADING = /^\s*#{1,6}\s/;

/**
 * Join hard-wrapped continuation lines into their paragraph.
 *
 * Stance prose is wrapped at ~72 characters, which breaks any line-based
 * regex: searching the raw text for the weights line finds it in 1 of 10
 * real versions; searching unwrapped text finds it in 10 of 10. Run this
 * before any other matching. Blank lines, headings, list-item starts, block
 * quotes, table rows and fenced code are all preserved.
 */
export function unwrapParagraphs(text: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      out.push(line);
      continue;
    }
    const prev = out[out.length - 1];
    const continues =
      !fenced &&
      prev !== undefined &&
      prev.trim() !== "" &&
      line.trim() !== "" &&
      !BLOCK_START.test(line) &&
      !HEADING.test(prev);
    if (continues) out[out.length - 1] = `${prev.replace(/\s+$/, "")} ${line.trim()}`;
    else out.push(line);
  }
  return out.join("\n");
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd panel && npx vitest run test/stance.test.ts`
Expected: PASS, 12 tests.

Then prove the tripwire actually works: temporarily stub `unwrapParagraphs` to `text => text`, re-run, and confirm the two wrap-recovery tests FAIL (7 failures in total — the exact-equality tests fail too). Restore with `git checkout -- panel/lib/stance.ts` and confirm 12 pass again. A test suite that stays green against a no-op is not protecting anything.

- [ ] **Step 6: Commit**

```bash
git add panel/lib/stance.ts panel/test/stance.test.ts panel/test/fixtures/stance/
git commit -m "feat(panel): unwrap hard-wrapped stance prose before parsing

Stance is wrapped at ~72 chars, so line-based regexes miss anything
spanning a wrap. Fixtures are six real stance versions pulled from
origin/live, and a test asserts the raw-text search genuinely fails
so the unwrap step can't be dropped as redundant later."
```

---

### Task 2: Stance section parsing

**Files:**
- Modify: `panel/lib/stance.ts`
- Modify: `panel/test/stance.test.ts`

**Interfaces:**
- Consumes: `unwrapParagraphs` from Task 1.
- Produces: types `StanceKey`, `StanceSection`, `ParsedStance`; function `parseStance(text: string): ParsedStance`.

- [ ] **Step 1: Write the failing test**

Append to `panel/test/stance.test.ts`:

```ts
import { parseStance } from "../lib/stance";

describe("parseStance", () => {
  it("extracts the H1 date and updated-note", () => {
    const p = parseStance(fixture("brief-2026-08-10"));
    expect(p.asOf).toBe("2026-08-10");
    expect(p.updatedNote).toBe("updated 07:50 Dubai, Monday brief");
  });

  it("handles an H1 with no parenthetical", () => {
    const p = parseStance("# Stance — 2026-08-01\n\nlead\n\n## View\n\nbody");
    expect(p.asOf).toBe("2026-08-01");
    expect(p.updatedNote).toBeNull();
  });

  it("finds all six canonical sections in every real fixture", () => {
    for (const [name, text] of allFixtures()) {
      const p = parseStance(text);
      for (const key of ["view", "whatFlipsMe", "openPredictions",
                         "wakeups", "deskLocal", "sourcingHealth"] as const) {
        expect(p.sections[key], `${name} is missing ${key}`).toBeDefined();
      }
      expect(p.degraded).toBe(false);
    }
  });

  it("matches headings by prefix despite parenthetical suffixes", () => {
    const p = parseStance(fixture("scan-2026-08-07"));
    // "## Open predictions (Friday cohort scores Sat 00:15Z, wakeup #19)"
    expect(p.sections.openPredictions!.heading).toContain("(");
    expect(p.sections.openPredictions!.body).not.toBe("");
  });

  it("is case-insensitive on headings", () => {
    const p = parseStance("# S — 2026-08-01\n\n## VIEW\n\nbody\n");
    expect(p.sections.view!.body.trim()).toBe("body");
  });

  it("preserves unrecognised sections in document order", () => {
    const p = parseStance(fixture("brief-2026-08-10"));
    // This version carries "## CPI decision tree (tomorrow 12:30Z, wakeup #20)".
    expect(p.extra.map(s => s.heading).join(" | ")).toContain("CPI decision tree");
  });

  it("captures the preamble verbatim, without the H1", () => {
    const p = parseStance("# Stance — 2026-08-01\n\n**EVENT-PENDING:** lead text\n\n## View\n\nbody");
    expect(p.preamble.trim()).toBe("**EVENT-PENDING:** lead text");
    expect(p.preamble).not.toContain("# Stance");
  });

  it("degrades to raw when there is no ## View", () => {
    const p = parseStance("just some prose with no structure at all");
    expect(p.degraded).toBe(true);
    expect(p.raw).toBe("just some prose with no structure at all");
    expect(p.sections.view).toBeUndefined();
  });

  it("degrades on empty input without throwing", () => {
    const p = parseStance("");
    expect(p.degraded).toBe(true);
    expect(p.extra).toEqual([]);
  });

  it("always returns raw as the original text, not the unwrapped text", () => {
    const src = fixture("brief-2026-08-09");
    expect(parseStance(src).raw).toBe(src);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd panel && npx vitest run test/stance.test.ts`
Expected: FAIL — `parseStance is not a function` / no export named `parseStance`.

- [ ] **Step 3: Write the implementation**

Append to `panel/lib/stance.ts`:

```ts
export type StanceKey =
  | "view" | "whatFlipsMe" | "openPredictions"
  | "wakeups" | "deskLocal" | "sourcingHealth";

export type StanceSection = { heading: string; body: string };

export type ParsedStance = {
  asOf: string | null;
  updatedNote: string | null;
  preamble: string;
  sections: Partial<Record<StanceKey, StanceSection>>;
  extra: StanceSection[];
  raw: string;
  degraded: boolean;
};

/**
 * Canonical key -> heading prefix, matched case-insensitively. Prefix
 * matching is required: real headings carry run-specific suffixes such as
 * "## Open predictions (Friday cohort scores Sat 00:15Z, wakeup #19)".
 * Order matters only for readability; keys are disjoint.
 */
const SECTION_PREFIXES: readonly (readonly [StanceKey, string])[] = [
  ["view", "view"],
  ["whatFlipsMe", "what flips me"],
  ["openPredictions", "open predictions"],
  ["wakeups", "wakeups"],
  ["deskLocal", "desk-local"],
  ["sourcingHealth", "sourcing health"],
] as const;

function classify(heading: string): StanceKey | null {
  const h = heading.trim().toLowerCase();
  for (const [key, prefix] of SECTION_PREFIXES) if (h.startsWith(prefix)) return key;
  return null;
}

export function parseStance(text: string): ParsedStance {
  const empty: ParsedStance = {
    asOf: null, updatedNote: null, preamble: "",
    sections: {}, extra: [], raw: text, degraded: true,
  };
  if (!text.trim()) return empty;

  const lines = unwrapParagraphs(text).split("\n");

  // H1 — "# Stance — 2026-08-10 (updated 07:50 Dubai, Monday brief)"
  const h1 = lines.find(l => /^#\s/.test(l)) ?? "";
  const asOf = /(\d{4}-\d{2}-\d{2})/.exec(h1)?.[1] ?? null;
  const updatedNote = /\(([^)]*)\)/.exec(h1)?.[1] ?? null;

  const preambleLines: string[] = [];
  const sections: Partial<Record<StanceKey, StanceSection>> = {};
  const extra: StanceSection[] = [];
  let current: StanceSection | null = null;
  let seenH1 = false;

  for (const line of lines) {
    if (!seenH1 && /^#\s/.test(line)) { seenH1 = true; continue; }
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) {
      const heading = h2[1].trim();
      current = { heading, body: "" };
      const key = classify(heading);
      // First occurrence wins; a repeated heading lands in extra rather than
      // silently overwriting the earlier one.
      if (key && !sections[key]) sections[key] = current;
      else extra.push(current);
      continue;
    }
    if (current) current.body += (current.body ? "\n" : "") + line;
    else if (seenH1) preambleLines.push(line);
  }

  for (const s of Object.values(sections)) s.body = s.body.trim();
  for (const s of extra) s.body = s.body.trim();

  return {
    asOf, updatedNote,
    preamble: preambleLines.join("\n").trim(),
    sections, extra, raw: text,
    degraded: sections.view === undefined,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd panel && npx vitest run test/stance.test.ts`
Expected: PASS, 22 tests (12 from Task 1 plus 10 new).

- [ ] **Step 5: Commit**

```bash
git add panel/lib/stance.ts panel/test/stance.test.ts
git commit -m "feat(panel): parse stance sections by heading prefix

Headings carry run-specific parenthetical suffixes, so matching is by
prefix. Unrecognised sections are preserved in extra[] rather than
dropped, and a stance with no ## View degrades to raw markdown so the
panel can never render blank."
```

---

### Task 3: Weights extraction

**Files:**
- Modify: `panel/lib/stance.ts`
- Modify: `panel/test/stance.test.ts`

**Interfaces:**
- Consumes: `parseStance` from Task 2.
- Produces: type `StanceWeight = { label: string; pct: number }`; function `parseWeights(viewBody: string): StanceWeight[] | null`; new field `weights: StanceWeight[] | null` on `ParsedStance`.

- [ ] **Step 1: Write the failing test**

Append to `panel/test/stance.test.ts`:

```ts
import { parseWeights } from "../lib/stance";

describe("parseWeights", () => {
  it("splits the triplet against its parenthetical labels", () => {
    expect(parseWeights("**Weights 70/5/25 (base/event-bearish/kinetic), conviction medium-high.**"))
      .toEqual([
        { label: "base", pct: 70 },
        { label: "event-bearish", pct: 5 },
        { label: "kinetic", pct: 25 },
      ]);
  });

  it("reads a different triplet from a different run", () => {
    expect(parseWeights("Weights 65/10/25 (base/event-bearish/kinetic), conviction medium-high.")
      ?.map(w => w.pct)).toEqual([65, 10, 25]);
  });

  it("returns null when the line is absent", () => {
    expect(parseWeights("no weights here")).toBeNull();
  });

  it("returns null rather than a partial render on a label-count mismatch", () => {
    expect(parseWeights("Weights 70/5/25 (base/kinetic)")).toBeNull();
  });

  it("surfaces weights on the parsed stance for every real fixture", () => {
    for (const [name, text] of allFixtures()) {
      const p = parseStance(text);
      expect(p.weights, `${name} has no weights`).not.toBeNull();
      expect(p.weights!.reduce((a, w) => a + w.pct, 0), `${name} weights sum`).toBe(100);
    }
  });

  it("leaves weights null when the View section has no weights line", () => {
    expect(parseStance("# S — 2026-08-01\n\n## View\n\nno triplet here").weights).toBeNull();
  });

  it("is null on a degraded stance", () => {
    expect(parseStance("garbage").weights).toBeNull();
  });

  it("does not match a weights line that is still hard-wrapped", () => {
    // parseWeights contracts for already-unwrapped input. If WEIGHTS_RE's
    // [^)\n] were relaxed to [^)], the negated class would match across the
    // wrap and this would return a result — the guard would be silently
    // dead. This test is the tripwire that keeps it honest.
    const wrapped = "Weights 70/5/25 (base/event-bearish/\nkinetic), conviction capped by CPI.";
    expect(parseWeights(wrapped)).toBeNull();
    expect(parseWeights(unwrapParagraphs(wrapped))).toEqual([
      { label: "base", pct: 70 },
      { label: "event-bearish", pct: 5 },
      { label: "kinetic", pct: 25 },
    ]);
  });

  it("returns null when a label is empty, rather than silently reindexing", () => {
    expect(parseWeights("Weights 70/5/25 (unknown/base//kinetic)")).toBeNull();
    expect(parseWeights("Weights 70/5/25 (base//kinetic)")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd panel && npx vitest run test/stance.test.ts`
Expected: FAIL — no export named `parseWeights`.

- [ ] **Step 3: Write the implementation**

In `panel/lib/stance.ts`, add the type and function, then wire the field into `parseStance`:

```ts
export type StanceWeight = { label: string; pct: number };

/**
 * "Weights 70/5/25 (base/event-bearish/kinetic), conviction medium-high."
 * The triplet changes between runs; the shape has held across every real
 * version inspected. Input must already be unwrapped (parseStance bodies
 * are), or the line will be missed when it spans a wrap.
 *
 * `[^)\n]` rather than `[^)]` is deliberate: a negated class matches `\n`
 * in JS, so `[^)]` would quietly match across a wrap and disguise a missing
 * unwrap step. Keep the newline exclusion.
 */
const WEIGHTS_RE = /Weights\s+(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\(([^)\n]+)\)/i;

export function parseWeights(viewBody: string): StanceWeight[] | null {
  const m = WEIGHTS_RE.exec(viewBody);
  if (!m) return null;
  const pcts = [Number(m[1]), Number(m[2]), Number(m[3])];
  const labels = m[4].split("/").map(s => s.trim());
  // Compare the split as-is and reject empty segments. Filtering empties
  // first would let a spurious label and an empty one cancel out —
  // "(unknown/base//kinetic)" would yield three confidently mislabelled
  // chips instead of null. A mismatch means the format drifted; render
  // nothing rather than mislabelled chips.
  if (labels.length !== pcts.length || labels.some(l => l === "")) return null;
  return pcts.map((pct, i) => ({ label: labels[i], pct }));
}
```

Add `weights: StanceWeight[] | null;` to the `ParsedStance` type, `weights: null` to the `empty` object, and in the return of `parseStance`:

```ts
    weights: sections.view ? parseWeights(sections.view.body) : null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd panel && npx vitest run test/stance.test.ts`
Expected: PASS, 31 tests (22 from Tasks 1–2 plus 9 new).

Then prove the newline guard is real: temporarily relax `[^)\n]` to `[^)]`, confirm the hard-wrapped tripwire test FAILS (30 pass / 1 fail), and restore. An untested guard is a guard that will be "simplified" away later.

- [ ] **Step 5: Commit**

```bash
git add panel/lib/stance.ts panel/test/stance.test.ts
git commit -m "feat(panel): extract the stance weights triplet

Verified against all six real fixtures; a label/number count mismatch
yields null so drift shows up as missing chips, not wrong ones."
```

---

### Task 4: Batch latest-price query and technical fixture data

**Files:**
- Modify: `panel/lib/db.ts`
- Modify: `panel/test/fixtures/fixture.sql:75-77`
- Modify: `panel/test/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `latestPrices(symbols: string[]): Record<string, { ts: string; value: number }>` and `priceAtOrBeforeValue(symbol: string, ts: string): number | null`. The latter is named to avoid colliding with the module-private `priceAtOrBefore(db, symbol, ts)` it wraps.

- [ ] **Step 1: Add the technical series to the fixture**

In `panel/test/fixtures/fixture.sql`, replace the `INSERT INTO prices` statement (lines 75–77) with:

```sql
INSERT INTO prices VALUES
 ('GC','2026-07-25T08:00:00Z',3290.0),('GC','2026-07-31T08:00:00Z',3310.5),('GC','2026-08-01T08:00:00Z',3325.0),
 ('DXY','2026-07-31T08:00:00Z',104.2),('DXY','2026-08-01T08:00:00Z',103.8),
 -- GC technicals: spot 3325 sits above SMA50 and below SMA200, which
 -- exercises the mixed regime branch. Ladder order (desc) is therefore
 -- SMA200 3400, pivot R1 3390, spot 3325, SMA50 3250, pivot S1 3180.
 ('GC_SMA50','2026-08-01T06:00:00Z',3250.0),
 ('GC_SMA200','2026-08-01T06:00:00Z',3400.0),
 ('GC_PIV_S1','2026-08-01T06:00:00Z',3180.0),
 ('GC_PIV_R1','2026-08-01T06:00:00Z',3390.0),
 ('GC_RSI14','2026-08-01T06:00:00Z',58.4),
 ('GC_ATR14','2026-08-01T06:00:00Z',42.1),
 ('^GVZ','2026-08-01T07:00:00Z',18.7),
 ('GC_NET_SPEC','2026-07-28T00:00:00Z',9.5);
```

- [ ] **Step 2: Write the failing test**

Append to `panel/test/db.test.ts`:

```ts
describe("latestPrices", () => {
  it("returns the newest row per requested symbol", () => {
    const out = db.latestPrices(["GC", "GC_SMA200"]);
    expect(out.GC).toEqual({ ts: "2026-08-01T08:00:00Z", value: 3325.0 });
    expect(out.GC_SMA200).toEqual({ ts: "2026-08-01T06:00:00Z", value: 3400.0 });
  });

  it("omits symbols with no rows rather than returning nulls", () => {
    const out = db.latestPrices(["GC", "NOPE"]);
    expect(out.GC).toBeDefined();
    expect(out.NOPE).toBeUndefined();
  });

  it("returns an empty object for an empty symbol list without querying", () => {
    expect(db.latestPrices([])).toEqual({});
  });
});

describe("priceAtOrBeforeValue", () => {
  it("returns the newest value at or before the cutoff, not the next one after it", () => {
    // Rows: 07-25 3290, 07-31 3310.5, 08-01 3325. A cutoff mid-gap must
    // return the earlier row, never jump forward.
    expect(db.priceAtOrBeforeValue("GC", "2026-07-28T00:00:00Z")).toBe(3290.0);
  });

  it("includes a row exactly on the cutoff", () => {
    expect(db.priceAtOrBeforeValue("GC", "2026-07-31T08:00:00Z")).toBe(3310.5);
  });

  it("returns null when nothing precedes the cutoff", () => {
    expect(db.priceAtOrBeforeValue("GC", "2026-07-01T00:00:00Z")).toBeNull();
  });

  it("returns null for an unknown symbol", () => {
    expect(db.priceAtOrBeforeValue("NOPE", "2026-08-01T08:00:00Z")).toBeNull();
  });
});
```

Match the existing import style at the top of `test/db.test.ts` (it already imports the module and points `JAMASP_ROOT` at the fixture root — follow whatever that file does; do not add a second setup path).

- [ ] **Step 3: Rebuild the fixture and run the test to verify it fails**

Run: `cd panel && npm run fixture && npx vitest run test/db.test.ts`
Expected: FAIL — `db.latestPrices is not a function`.

- [ ] **Step 4: Write the implementation**

Append to `panel/lib/db.ts`:

```ts
/**
 * Newest row per symbol in one query. The overview needs nine series at
 * once (spot, two SMAs, two pivots, RSI, ATR, GVZ, net spec); nine separate
 * `latest()` round trips is the shape this avoids. Symbols with no rows are
 * absent from the result rather than mapped to null.
 */
export function latestPrices(symbols: string[]): Record<string, { ts: string; value: number }> {
  if (symbols.length === 0) return {};
  const placeholders = symbols.map(() => "?").join(",");
  return q(db => {
    const rows = db.prepare(
      `SELECT p.symbol, p.ts, p.value FROM prices p
       WHERE p.symbol IN (${placeholders})
         AND p.ts = (SELECT MAX(b.ts) FROM prices b WHERE b.symbol = p.symbol)`
    ).all(...symbols) as { symbol: string; ts: string; value: number }[];
    return Object.fromEntries(rows.map(r => [r.symbol, { ts: r.ts, value: r.value }]));
  });
}
```

Then export the existing private `priceAtOrBefore` helper for reuse. There is
already a module-private `priceAtOrBefore(db, symbol, ts)` at `lib/db.ts:144`
used by `getPriceSnapshots`; **do not duplicate it.** Add this public wrapper
beneath it, leaving the private one and its callers untouched:

```ts
/**
 * Value of the newest row at or before `ts`, or null if the series does not
 * reach back that far.
 *
 * At-or-before, never at-or-after: gold has overnight and weekend gaps, so
 * the first row *after* a cutoff can sit hours away and would silently skew
 * a 24h delta. This matches jamasp/ingest/prices.py#row_at_or_before, which
 * is what pricesummary.py's `_delta` uses for the brief — the panel's 24h
 * change must be computed the same way the Telegram brief computes it.
 */
export function priceAtOrBeforeValue(symbol: string, ts: string): number | null {
  return q(db => priceAtOrBefore(db, symbol, ts));
}
```

The name differs from the private helper deliberately — `priceAtOrBeforeValue`
returns a bare value, the private `priceAtOrBefore` returns a row and takes an
open connection.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd panel && npx vitest run`
Expected: PASS — all suites, including the pre-existing ones.

- [ ] **Step 6: Commit**

```bash
git add panel/lib/db.ts panel/test/db.test.ts panel/test/fixtures/fixture.sql
git commit -m "feat(panel): batch latest-price query and GC technical fixtures

The overview reads nine series at once. Fixture spot sits above SMA50
and below SMA200 so the mixed regime branch is the default under test."
```

---

### Task 5: Technical derivation — ladder, regime, staleness

**Files:**
- Create: `panel/lib/technicals.ts`
- Create: `panel/test/technicals.test.ts`
- Modify: `jamasp/pricesummary.py` (one comment)

**Interfaces:**
- Consumes: nothing (pure).
- Produces: types `Quote`, `Level`, `TechnicalsInput`, `GoldTechnicals`; function `deriveTechnicals(input: TechnicalsInput, now: Date): GoldTechnicals`; constant `TECHNICAL_SYMBOLS: string[]`.

- [ ] **Step 1: Write the failing test**

Create `panel/test/technicals.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveTechnicals, type TechnicalsInput } from "../lib/technicals";

const NOW = new Date("2026-08-01T12:00:00Z");
const q = (value: number, ts = "2026-08-01T06:00:00Z") => ({ ts, value });

const base: TechnicalsInput = {
  spot: q(3325, "2026-08-01T08:00:00Z"),
  spot24hAgo: 3310.5,
  sma50: q(3250), sma200: q(3400),
  pivotS1: q(3180), pivotR1: q(3390),
  rsi14: q(58.4), atr14: q(42.1),
  gvz: q(18.7, "2026-08-01T07:00:00Z"),
  netSpec: q(9.5, "2026-07-28T00:00:00Z"),
};

describe("deriveTechnicals — regime", () => {
  // These four strings must match jamasp/pricesummary.py#_tech_line exactly.
  it("above both", () => {
    expect(deriveTechnicals({ ...base, spot: q(3500) }, NOW).regime).toBe("above both");
  });
  it("below both", () => {
    expect(deriveTechnicals({ ...base, spot: q(3000) }, NOW).regime).toBe("below both");
  });
  it("above 50DMA, below 200DMA", () => {
    expect(deriveTechnicals(base, NOW).regime).toBe("above 50DMA, below 200DMA");
  });
  it("below 50DMA, above 200DMA", () => {
    expect(deriveTechnicals({ ...base, sma50: q(3400), sma200: q(3250) }, NOW).regime)
      .toBe("below 50DMA, above 200DMA");
  });
  it("treats spot exactly equal to an SMA as not-above, matching the Python's strict >", () => {
    expect(deriveTechnicals({ ...base, spot: q(3250), sma200: q(3400) }, NOW).regime)
      .toBe("below both");
  });
  it("is null when either SMA is missing", () => {
    expect(deriveTechnicals({ ...base, sma200: null }, NOW).regime).toBeNull();
    expect(deriveTechnicals({ ...base, sma50: null }, NOW).regime).toBeNull();
  });
  it("is null when spot is missing", () => {
    expect(deriveTechnicals({ ...base, spot: null }, NOW).regime).toBeNull();
  });
});

describe("deriveTechnicals — levels", () => {
  it("orders levels descending with spot interleaved", () => {
    const t = deriveTechnicals(base, NOW);
    expect(t.levels.map(l => [l.label, l.value])).toEqual([
      ["200DMA", 3400], ["pivot R1", 3390], ["spot", 3325],
      ["50DMA", 3250], ["pivot S1", 3180],
    ]);
  });

  it("tags each level above/below/at relative to spot", () => {
    const byLabel = Object.fromEntries(
      deriveTechnicals(base, NOW).levels.map(l => [l.label, l.side]));
    expect(byLabel).toEqual({
      "200DMA": "above", "pivot R1": "above", spot: "at",
      "50DMA": "below", "pivot S1": "below",
    });
  });

  it("marks a level equal to spot as at", () => {
    const t = deriveTechnicals({ ...base, sma50: q(3325) }, NOW);
    expect(t.levels.find(l => l.label === "50DMA")!.side).toBe("at");
  });

  it("renders only the levels it has", () => {
    const t = deriveTechnicals({ ...base, pivotS1: null, pivotR1: null }, NOW);
    expect(t.levels.map(l => l.label)).toEqual(["200DMA", "spot", "50DMA"]);
  });

  it("returns an empty ladder and null spot when there is no price data", () => {
    const t = deriveTechnicals({
      spot: null, spot24hAgo: null, sma50: null, sma200: null,
      pivotS1: null, pivotR1: null, rsi14: null, atr14: null,
      gvz: null, netSpec: null,
    }, NOW);
    expect(t.levels).toEqual([]);
    expect(t.spot).toBeNull();
    expect(t.regime).toBeNull();
    expect(t.indicatorsAsOf).toBeNull();
  });

  it("assigns kinds so the ladder can style MAs and pivots differently", () => {
    const kinds = Object.fromEntries(
      deriveTechnicals(base, NOW).levels.map(l => [l.label, l.kind]));
    expect(kinds).toEqual({
      "200DMA": "ma", "pivot R1": "pivot", spot: "spot",
      "50DMA": "ma", "pivot S1": "pivot",
    });
  });
});

describe("deriveTechnicals — spot delta", () => {
  it("computes absolute and percentage 24h change", () => {
    const t = deriveTechnicals(base, NOW);
    expect(t.spot!.delta24h).toBeCloseTo(14.5, 6);
    expect(t.spot!.pct24h).toBeCloseTo((14.5 / 3310.5) * 100, 6);
  });

  it("leaves deltas null with no 24h reference", () => {
    const t = deriveTechnicals({ ...base, spot24hAgo: null }, NOW);
    expect(t.spot!.delta24h).toBeNull();
    expect(t.spot!.pct24h).toBeNull();
  });

  it("leaves pct null rather than dividing by zero", () => {
    const t = deriveTechnicals({ ...base, spot24hAgo: 0 }, NOW);
    expect(t.spot!.pct24h).toBeNull();
  });
});

describe("deriveTechnicals — staleness", () => {
  it("is fresh within 12h of the newest TradingView-sourced indicator", () => {
    expect(deriveTechnicals(base, NOW).stale).toBe(false);
    expect(deriveTechnicals(base, NOW).indicatorsAsOf).toBe("2026-08-01T06:00:00Z");
  });

  it("boundary: exactly 12h is fresh, one minute past is stale", () => {
    const at = new Date("2026-08-01T18:00:00Z");   // 12h after 06:00Z
    expect(deriveTechnicals(base, at).stale).toBe(false);
    const past = new Date("2026-08-01T18:01:00Z");
    expect(deriveTechnicals(base, past).stale).toBe(true);
  });

  it("ignores GVZ and net spec, which have their own cadences", () => {
    // Only GVZ is recent; the TradingView set is two days old -> stale.
    const t = deriveTechnicals({
      ...base,
      sma50: q(3250, "2026-07-30T06:00:00Z"), sma200: q(3400, "2026-07-30T06:00:00Z"),
      pivotS1: q(3180, "2026-07-30T06:00:00Z"), pivotR1: q(3390, "2026-07-30T06:00:00Z"),
      rsi14: q(58.4, "2026-07-30T06:00:00Z"), atr14: q(42.1, "2026-07-30T06:00:00Z"),
      gvz: q(18.7, "2026-08-01T11:59:00Z"),
    }, NOW);
    expect(t.stale).toBe(true);
    expect(t.indicatorsAsOf).toBe("2026-07-30T06:00:00Z");
  });

  it("is not stale when there are no indicators at all", () => {
    const t = deriveTechnicals({
      ...base, sma50: null, sma200: null, pivotS1: null,
      pivotR1: null, rsi14: null, atr14: null,
    }, NOW);
    expect(t.stale).toBe(false);
    expect(t.indicatorsAsOf).toBeNull();
  });
});

describe("deriveTechnicals — indicators", () => {
  it("passes indicator values through, nulling the absent ones", () => {
    expect(deriveTechnicals({ ...base, atr14: null }, NOW).indicators)
      .toEqual({ rsi14: 58.4, atr14: null, gvz: 18.7, netSpec: 9.5 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd panel && npx vitest run test/technicals.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/technicals"`.

- [ ] **Step 3: Write the implementation**

Create `panel/lib/technicals.ts`:

```ts
/**
 * Gold technical context derived from the `prices` table.
 *
 * Pure, like lib/health.ts — the page does the database reads and passes
 * quotes in. Levels come from stored series only; levels that appear in
 * stance prose (for example "4300 psychological") are deliberately excluded,
 * because regex-hunting numbers out of narrative is exactly the fragility
 * this module avoids.
 *
 * Deliberately absent: any aggregate buy/sell verdict. config/sources.yaml
 * records that TradingView's Recommend.All is not stored, because
 * "technicals annotate the macro read, they must not originate calls."
 */

export type Quote = { ts: string; value: number };
export type LevelKind = "ma" | "pivot" | "spot";
export type LevelSide = "above" | "below" | "at";
export type Level = { label: string; value: number; kind: LevelKind; side: LevelSide };

export type TechnicalsInput = {
  spot: Quote | null;
  spot24hAgo: number | null;
  sma50: Quote | null;
  sma200: Quote | null;
  pivotS1: Quote | null;
  pivotR1: Quote | null;
  rsi14: Quote | null;
  atr14: Quote | null;
  gvz: Quote | null;
  netSpec: Quote | null;
};

export type GoldTechnicals = {
  spot: { value: number; ts: string; delta24h: number | null; pct24h: number | null } | null;
  levels: Level[];
  regime: string | null;
  indicators: { rsi14: number | null; atr14: number | null;
                gvz: number | null; netSpec: number | null };
  indicatorsAsOf: string | null;
  stale: boolean;
};

/**
 * The set of series the overview reads in one batch. Order carries no
 * meaning — `latestPrices` returns a Record keyed by symbol. Spread it at
 * the call site (`[...TECHNICAL_SYMBOLS]`): this is a readonly `as const`
 * tuple and `latestPrices` takes a mutable `string[]`.
 */
export const TECHNICAL_SYMBOLS = [
  "GC", "GC_SMA50", "GC_SMA200", "GC_PIV_S1", "GC_PIV_R1",
  "GC_RSI14", "GC_ATR14", "^GVZ", "GC_NET_SPEC",
] as const;

/**
 * The tv_gc_technicals source polls every 360 minutes, so anything past 12h
 * means the feed has missed at least one cycle. Production shows real gaps
 * (33 indicator points across 9 days), and a gap must be visible rather than
 * rendered as if current.
 */
const STALE_MS = 12 * 3600_000;

/**
 * Paired implementation: jamasp/pricesummary.py#_tech_line. These four strings
 * are what the Telegram brief prints, so the panel must not paraphrase them
 * or the two surfaces will quietly disagree. Comparison is strict `>`, as
 * in the Python — spot exactly on an SMA counts as not-above.
 */
function deriveRegime(spot: number, sma50: number, sma200: number): string {
  const above50 = spot > sma50;
  const above200 = spot > sma200;
  if (above50 === above200) return above50 ? "above both" : "below both";
  return above50 ? "above 50DMA, below 200DMA" : "below 50DMA, above 200DMA";
}

function side(value: number, spot: number | null): LevelSide {
  if (spot === null || value === spot) return "at";
  return value > spot ? "above" : "below";
}

export function deriveTechnicals(input: TechnicalsInput, now: Date = new Date()): GoldTechnicals {
  const spotValue = input.spot?.value ?? null;

  const candidates: (readonly [string, Quote | null, LevelKind])[] = [
    ["200DMA", input.sma200, "ma"],
    ["pivot R1", input.pivotR1, "pivot"],
    ["spot", input.spot, "spot"],
    ["50DMA", input.sma50, "ma"],
    ["pivot S1", input.pivotS1, "pivot"],
  ];
  const levels: Level[] = candidates
    .filter((c): c is readonly [string, Quote, LevelKind] => c[1] !== null)
    .map(([label, quote, kind]) => ({
      label, value: quote.value, kind,
      side: kind === "spot" ? "at" : side(quote.value, spotValue),
    }))
    .sort((a, b) => b.value - a.value);

  // Staleness tracks the TradingView set only. GVZ (hourly Yahoo) and net
  // spec (weekly CFTC) have unrelated cadences and would mask a dead feed.
  const tvQuotes = [input.sma50, input.sma200, input.pivotS1,
                    input.pivotR1, input.rsi14, input.atr14]
    .filter((q): q is Quote => q !== null);
  const indicatorsAsOf = tvQuotes.length
    ? tvQuotes.map(q => q.ts).reduce((a, b) => (a > b ? a : b))
    : null;

  const delta24h = input.spot && input.spot24hAgo !== null
    ? input.spot.value - input.spot24hAgo
    : null;

  return {
    spot: input.spot
      ? {
          value: input.spot.value,
          ts: input.spot.ts,
          delta24h,
          pct24h: delta24h !== null && input.spot24hAgo
            ? (delta24h / input.spot24hAgo) * 100
            : null,
        }
      : null,
    levels,
    regime: spotValue !== null && input.sma50 && input.sma200
      ? deriveRegime(spotValue, input.sma50.value, input.sma200.value)
      : null,
    indicators: {
      rsi14: input.rsi14?.value ?? null,
      atr14: input.atr14?.value ?? null,
      gvz: input.gvz?.value ?? null,
      netSpec: input.netSpec?.value ?? null,
    },
    indicatorsAsOf,
    stale: indicatorsAsOf !== null
      && now.getTime() - new Date(indicatorsAsOf).getTime() > STALE_MS,
  };
}
```

- [ ] **Step 4: Add the reciprocal comment to the Python**

In `jamasp/pricesummary.py`, directly above the `above50, above200 = …` line inside `_tech_line` (currently line 56), insert:

```python
    # Paired implementation: panel/lib/technicals.ts#deriveRegime. These
    # four strings also render in the web panel; change both or they
    # disagree. Strict `>` is load-bearing — spot exactly on an SMA is
    # not "above".
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd panel && npx vitest run test/technicals.test.ts`
Expected: PASS, 23 tests.

Then audit every conditional you wrote — the null checks, the `indicatorsAsOf` empty case, the staleness comparison, the `pct24h` divide-by-zero guard, `side()`'s spot-missing branch. Delete each in turn and confirm a test fails. Two holes were found this way when the task was first implemented; a guard no test protects will be "simplified" away later.

Then confirm the Python is unbroken: `cd /Users/saman/Rabin/Jamasp && uv run pytest tests/ -q`
Expected: PASS (comment-only change).

- [ ] **Step 6: Commit**

```bash
git add panel/lib/technicals.ts panel/test/technicals.test.ts jamasp/pricesummary.py
git commit -m "feat(panel): derive the gold levels ladder and regime

Regime is a port of pricesummary.py#_tech_line with reciprocal comments in
both files, so the panel and the Telegram brief cannot drift. Staleness
tracks the TradingView set only — GVZ and CFTC net spec have unrelated
cadences and would mask a dead technicals feed.

No aggregate buy/sell gauge, per config/sources.yaml."
```

---

### Task 6: Level ladder component

**Files:**
- Create: `panel/components/level-ladder.tsx`
- Create: `panel/test/ladder.test.ts`

**Interfaces:**
- Consumes: `Level` from `lib/technicals.ts`.
- Produces: `ladderGaps(values: number[], opts?: { min?: number; max?: number }): number[]`; component `<LevelLadder levels={Level[]} />`.

- [ ] **Step 1: Write the failing test**

Create `panel/test/ladder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ladderGaps } from "../components/level-ladder";

describe("ladderGaps", () => {
  it("returns one gap fewer than there are levels", () => {
    expect(ladderGaps([100, 90, 50]).length).toBe(2);
  });

  it("gives the widest price gap the maximum spacing", () => {
    const [g1, g2] = ladderGaps([100, 90, 40], { min: 8, max: 48 });
    expect(g2).toBe(48);
    expect(g1).toBeLessThan(g2);
  });

  it("never returns less than the minimum, so labels cannot collide", () => {
    expect(ladderGaps([100, 99.999, 40], { min: 8, max: 48 })[0]).toBeGreaterThanOrEqual(8);
  });

  it("uses the minimum throughout when every level is identical", () => {
    expect(ladderGaps([100, 100, 100], { min: 8, max: 48 })).toEqual([8, 8]);
  });

  it("returns an empty array for zero or one level", () => {
    expect(ladderGaps([])).toEqual([]);
    expect(ladderGaps([100])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd panel && npx vitest run test/ladder.test.ts`
Expected: FAIL — cannot resolve `../components/level-ladder`.

- [ ] **Step 3: Write the implementation**

Create `panel/components/level-ladder.tsx`:

```tsx
import type { Level } from "@/lib/technicals";
import { cls } from "@/lib/format";

/**
 * Vertical spacing between consecutive ladder rows, proportional to the
 * price gap between them and clamped to [min, max].
 *
 * Spacing the gaps rather than absolutely positioning each row keeps the
 * ladder readable when two levels nearly coincide — absolute positioning
 * would overlap the labels. Distance is conveyed, exact scale is not.
 */
export function ladderGaps(values: number[], opts?: { min?: number; max?: number }): number[] {
  const min = opts?.min ?? 8;
  const max = opts?.max ?? 48;
  if (values.length < 2) return [];
  const diffs = values.slice(0, -1).map((v, i) => Math.abs(v - values[i + 1]));
  const widest = Math.max(...diffs);
  if (widest === 0) return diffs.map(() => min);
  return diffs.map(d => min + (max - min) * (d / widest));
}

const KIND_STYLE: Record<Level["kind"], string> = {
  ma: "border-t border-border",
  pivot: "border-t border-dotted border-border",
  spot: "border-t-2 border-primary",
};

function fmt(v: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export function LevelLadder({ levels }: { levels: Level[] }) {
  if (levels.length === 0) {
    return <p className="text-sm text-muted-foreground">no levels available</p>;
  }
  const gaps = ladderGaps(levels.map(l => l.value));
  return (
    <ol className="tabular-nums">
      {levels.map((l, i) => (
        <li key={l.label}
          style={i === 0 ? undefined : { marginTop: `${gaps[i - 1]}px` }}
          className={cls(
            "flex items-center gap-3 text-sm",
            l.kind === "spot" ? "font-semibold text-foreground" : "text-muted-foreground",
          )}>
          <span className="w-20 text-right">{fmt(l.value)}</span>
          <span className={cls("flex-1", KIND_STYLE[l.kind])} aria-hidden />
          <span className="w-24">{l.label}</span>
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd panel && npx vitest run test/ladder.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add panel/components/level-ladder.tsx panel/test/ladder.test.ts
git commit -m "feat(panel): level ladder with proportional row spacing

Spacing the gaps rather than absolutely positioning rows keeps labels
legible when two levels nearly coincide."
```

---

### Task 7: Technical panel

**Files:**
- Create: `panel/components/sparkline.tsx`
- Create: `panel/components/technical-panel.tsx`

**Interfaces:**
- Consumes: `GoldTechnicals` from Task 5, `LevelLadder` from Task 6, `PricePoint` from `lib/db.ts`.
- Produces: `<Sparkline points={PricePoint[]} />`, `<TechnicalPanel tech={GoldTechnicals} series={PricePoint[]} now={Date} />`.

- [ ] **Step 1: Write the sparkline**

Create `panel/components/sparkline.tsx`:

```tsx
import type { PricePoint } from "@/lib/db";
import { cls } from "@/lib/format";

/**
 * Server-rendered inline SVG. Deliberately not recharts: this is decoration
 * beneath the ladder, and pulling in a client component for it would make
 * the whole panel client-side.
 */
export function Sparkline({ points, className }: { points: PricePoint[]; className?: string }) {
  if (points.length < 2) return null;
  const values = points.map(p => p.value);
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * 100;
      const y = 100 - ((p.value - min) / span) * 100;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none"
      className={cls("h-10 w-full", className)} role="img"
      aria-label={`gold price trend, ${points.length} points`}>
      <path d={d} fill="none" stroke="var(--chart-1)" strokeWidth="1.5"
        vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
```

- [ ] **Step 2: Write the panel**

Create `panel/components/technical-panel.tsx`:

```tsx
import Link from "next/link";
import { LevelLadder } from "@/components/level-ladder";
import { Sparkline } from "@/components/sparkline";
import type { PricePoint } from "@/lib/db";
import type { GoldTechnicals } from "@/lib/technicals";
import { cls, fmtAge } from "@/lib/format";

function num(v: number | null, digits = 1): string {
  return v === null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: digits });
}

// Four distinct states, because "unknown" and "flat" are not the same claim
// and neither is a rise: null means no 24h reference row exists at all, so
// it must not fall through to "0" and read as a genuine flat move.
type Direction = "up" | "down" | "flat" | "unknown";

const DIR_TONE: Record<Direction, string> = {
  up: "text-emerald-400",
  down: "text-destructive",
  flat: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

const DIR_MARK: Record<Direction, string> = { up: "▲", down: "▼", flat: "=", unknown: "" };

function direction(delta: number | null): Direction {
  if (delta === null) return "unknown";
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "flat";
}

export function TechnicalPanel({ tech, series, now }: {
  tech: GoldTechnicals; series: PricePoint[]; now: Date;
}) {
  const delta = tech.spot?.delta24h ?? null;
  const dir = direction(delta);
  return (
    <section className="rounded border border-border p-4">
      <div className="mb-4 flex items-baseline justify-between gap-2">
        <h2 className="font-medium">
          Technical
          <Link className="ml-2 text-xs font-normal text-primary" href="/prices">→ prices</Link>
        </h2>
        {tech.spot && (
          <div className="tabular-nums">
            <span className="text-xl font-semibold">{num(tech.spot.value)}</span>
            <span className={cls("ml-2 text-sm", DIR_TONE[dir])}>
              {dir === "unknown" ? "24h —" : (
                <>
                  {DIR_MARK[dir]} {num(Math.abs(delta!))}
                  {tech.spot.pct24h !== null && ` (${num(Math.abs(tech.spot.pct24h), 2)}%)`}
                </>
              )}
            </span>
          </div>
        )}
      </div>

      {tech.spot === null ? (
        <p className="text-sm text-muted-foreground">no price data yet</p>
      ) : (
        <>
          <LevelLadder levels={tech.levels} />

          <p className="mt-4 text-sm">
            {tech.regime ?? <span className="text-muted-foreground">insufficient data</span>}
          </p>

          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
            <div><dt className="inline">RSI14 </dt><dd className="inline">{num(tech.indicators.rsi14)}</dd></div>
            <div><dt className="inline">ATR14 </dt><dd className="inline">{num(tech.indicators.atr14)}</dd></div>
            <div><dt className="inline">GVZ </dt><dd className="inline">{num(tech.indicators.gvz, 2)}</dd></div>
            <div><dt className="inline">net spec </dt><dd className="inline">{num(tech.indicators.netSpec, 1)}</dd></div>
          </dl>

          {tech.indicatorsAsOf && (
            <p className={cls("mt-1 text-xs",
              tech.stale ? "text-amber-400" : "text-muted-foreground")}>
              indicators {fmtAge(tech.indicatorsAsOf, now)}
              {tech.stale && " — stale, technicals feed has missed a cycle"}
            </p>
          )}

          <Sparkline points={series} className="mt-4" />
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Test the degradation branches**

The E2E in Task 10 renders one fixture in one state, so it exercises the happy
path only. These are the branches it cannot reach. Task 6 established the
pattern — `renderToStaticMarkup` from `react-dom/server`, no new dependencies,
and `vitest.config.mts` already carries the `@/` alias.

Create `panel/test/technical-panel.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TechnicalPanel } from "../components/technical-panel";
import type { GoldTechnicals } from "../lib/technicals";

const NOW = new Date("2026-08-01T12:00:00Z");

const full: GoldTechnicals = {
  spot: { value: 3325, ts: "2026-08-01T08:00:00Z", delta24h: 14.5, pct24h: 0.438 },
  levels: [
    { label: "200DMA", value: 3400, kind: "ma", side: "above" },
    { label: "spot", value: 3325, kind: "spot", side: "at" },
    { label: "50DMA", value: 3250, kind: "ma", side: "below" },
  ],
  regime: "above 50DMA, below 200DMA",
  indicators: { rsi14: 58.4, atr14: 42.1, gvz: 18.7, netSpec: 9.5 },
  indicatorsAsOf: "2026-08-01T06:00:00Z",
  stale: false,
};

const render = (tech: GoldTechnicals) =>
  renderToStaticMarkup(<TechnicalPanel tech={tech} series={[]} now={NOW} />);

describe("TechnicalPanel", () => {
  it("renders the regime and indicator readout when data is present", () => {
    const html = render(full);
    expect(html).toContain("above 50DMA, below 200DMA");
    expect(html).toContain("RSI14");
    expect(html).toContain("200DMA");
  });

  it("shows 'no price data yet' and no ladder when spot is null", () => {
    const html = render({ ...full, spot: null });
    expect(html).toContain("no price data yet");
    expect(html).not.toContain("200DMA");
  });

  it("shows 'insufficient data' when the regime could not be derived", () => {
    const html = render({ ...full, regime: null });
    expect(html).toContain("insufficient data");
  });

  it("warns when the technicals feed is stale", () => {
    const html = render({ ...full, stale: true });
    expect(html).toContain("stale");
  });

  it("stays silent about staleness when the feed is fresh", () => {
    expect(render(full)).not.toContain("stale");
  });

  it("never renders a buy/sell verdict", () => {
    // config/sources.yaml: technicals annotate the macro read, they must not
    // originate calls. No wording here may read as an instruction.
    const html = render(full).toLowerCase();
    for (const word of ["strong buy", "strong sell", "recommend", "signal", "target"]) {
      expect(html).not.toContain(word);
    }
  });
});
```

Run: `cd panel && npx vitest run test/technical-panel.test.tsx`
Expected: PASS, 6 tests.

Then delete the `tech.spot === null` guard in `technical-panel.tsx` and confirm the
"no price data yet" test fails. Restore it.

- [ ] **Step 4: Typecheck and lint**

Run: `cd panel && npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add panel/components/sparkline.tsx panel/components/technical-panel.tsx panel/test/technical-panel.test.tsx
git commit -m "feat(panel): technical panel with ladder, regime and indicators

Sparkline is server-rendered inline SVG rather than recharts, so the
panel stays a server component."
```

---

### Task 8: Fundamental panel

**Files:**
- Create: `panel/components/fundamental-panel.tsx`

**Interfaces:**
- Consumes: `ParsedStance` from Tasks 2–3, `ItemRow` from `lib/db.ts`, existing `Markdown` and `Badge`.
- Produces: `<FundamentalPanel stance={ParsedStance | null} items={ItemRow[]} now={Date} />`.

- [ ] **Step 1: Write the component**

Create `panel/components/fundamental-panel.tsx`:

```tsx
import Link from "next/link";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import type { ItemRow } from "@/lib/db";
import type { ParsedStance, StanceSection } from "@/lib/stance";
import { fmtAge } from "@/lib/format";

function Section({ section }: { section: StanceSection }) {
  return (
    <div className="mt-4">
      <h3 className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
        {section.heading}
      </h3>
      <Markdown text={section.body} />
    </div>
  );
}

export function FundamentalPanel({ stance, items, now }: {
  stance: ParsedStance | null; items: ItemRow[]; now: Date;
}) {
  return (
    <section className="rounded border border-border p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="font-medium">
          Fundamental
          <Link className="ml-2 text-xs font-normal text-primary" href="/state">→ state</Link>
        </h2>
        {stance?.asOf && (
          <span className="text-xs text-muted-foreground">
            stance {stance.asOf}{stance.updatedNote ? ` · ${stance.updatedNote}` : ""}
          </span>
        )}
      </div>

      {stance === null ? (
        <p className="text-sm text-muted-foreground">no stance yet</p>
      ) : stance.degraded ? (
        <>
          <Badge variant="outline" className="mb-2">unrecognised format</Badge>
          <Markdown text={stance.raw} />
        </>
      ) : (
        <>
          {stance.weights && (
            <div className="mb-3 flex flex-wrap gap-2">
              {stance.weights.map(w => (
                <Badge key={w.label} variant="secondary" className="tabular-nums">
                  {w.label} {w.pct}%
                </Badge>
              ))}
            </div>
          )}
          {stance.preamble && <Markdown text={stance.preamble} />}
          {stance.sections.view && <Section section={stance.sections.view} />}
          {stance.sections.whatFlipsMe && <Section section={stance.sections.whatFlipsMe} />}
          {stance.extra.map(s => <Section key={s.heading} section={s} />)}
        </>
      )}

      <div className="mt-6 border-t border-border pt-3">
        <h3 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
          Latest headlines
          <Link className="ml-2 normal-case tracking-normal text-primary" href="/inbox">→ inbox</Link>
        </h3>
        <ul className="space-y-1 text-sm">
          {items.length === 0 && <li className="text-muted-foreground">no items</li>}
          {items.map(i => (
            <li key={i.id} className="flex gap-2">
              <span className="w-14 shrink-0 text-xs text-muted-foreground">
                {fmtAge(i.published_at, now)}
              </span>
              <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">
                {i.source}
              </span>
              <a href={i.url} target="_blank" rel="noreferrer"
                className="flex-1 hover:underline">{i.headline}</a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Test the degradation branches**

This panel has more fallback paths than any other component in the plan, and
Task 10's E2E renders exactly one stance in one state. Create
`panel/test/fundamental-panel.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FundamentalPanel } from "../components/fundamental-panel";
import { parseStance } from "../lib/stance";
import type { ItemRow } from "../lib/db";

const NOW = new Date("2026-08-01T12:00:00Z");

const STANCE = `# Stance — 2026-08-01 (updated 12:05 Dubai)

**EVENT-PENDING:** lead paragraph text.

## View

**Weights 70/5/25 (base/event-bearish/kinetic), conviction medium-high.**

## What flips me

- Settle below 3250.

## Extra section from the agent

Ad-hoc content.
`;

const item = (id: string, headline: string): ItemRow => ({
  id, source: "reuters", published_at: "2026-08-01T10:00:00Z",
  headline, lede: null, url: "https://example.test/a", topic: "gold",
  cluster_id: null, fetched_at: "2026-08-01T10:05:00Z", read_at: null,
});

const render = (stance: ReturnType<typeof parseStance> | null, items: ItemRow[] = []) =>
  renderToStaticMarkup(<FundamentalPanel stance={stance} items={items} now={NOW} />);

describe("FundamentalPanel", () => {
  it("renders weight chips, preamble and sections", () => {
    const html = render(parseStance(STANCE));
    // "base 70%" is chip-only. Asserting bare "base" or "70" would pass even
    // with the chips deleted, because the View body renders the markdown
    // "Weights 70/5/25 (base/event-bearish/kinetic)" — the two blocks would
    // mask each other and neither assertion could fail.
    expect(html).toContain("base 70%");
    expect(html).toContain("event-bearish 5%");
    expect(html).toContain("lead paragraph text");
    expect(html).toContain("What flips me");
  });

  it("renders the View section with its heading and body", () => {
    const html = render(parseStance(STANCE));
    expect(html).toContain("View");
    expect(html).toContain("conviction medium-high");
  });

  it("shows the stance date and updated-note in the header", () => {
    const html = render(parseStance(STANCE));
    expect(html).toContain("2026-08-01");
    expect(html).toContain("updated 12:05 Dubai");
  });

  it("omits the header line when the stance has no date", () => {
    const html = render(parseStance("**lead**\n\n## View\n\nbody"));
    expect(html).not.toContain("stance 20");
  });

  it("renders unrecognised sections rather than dropping them", () => {
    expect(render(parseStance(STANCE))).toContain("Extra section from the agent");
  });

  it("shows 'no stance yet' when there is no stance file", () => {
    expect(render(null)).toContain("no stance yet");
  });

  it("falls back to raw markdown on an unparseable stance", () => {
    const html = render(parseStance("just prose, no structure at all"));
    expect(html).toContain("just prose, no structure at all");
    expect(html).toContain("unrecognised format");
  });

  it("omits the chips when no weights line is present", () => {
    const html = render(parseStance("# S — 2026-08-01\n\n## View\n\nno triplet here"));
    expect(html).not.toContain("%</");
  });

  it("shows 'no items' with an empty headline list, stance still rendered", () => {
    const html = render(parseStance(STANCE), []);
    expect(html).toContain("no items");
    expect(html).toContain("What flips me");
  });

  it("renders headlines with source and link", () => {
    const html = render(parseStance(STANCE), [item("i1", "Gold holds 3300")]);
    expect(html).toContain("Gold holds 3300");
    expect(html).toContain("reuters");
    expect(html).toContain("https://example.test/a");
  });
});
```

Run: `cd panel && npx vitest run test/fundamental-panel.test.tsx`
Expected: PASS, 10 tests.

Then delete each of these four blocks in turn, confirm a test fails, and
restore: the `stance.degraded` branch, the as-of header line, the weights-chips
block, and the `View` section render. All four must be individually
undeletable. If a block can be removed with the suite green, the assertion
naming it is measuring something another block also produces — find the
overlap rather than adjusting the assertion until it looks covered.

- [ ] **Step 3: Typecheck and lint**

Run: `cd panel && npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add panel/components/fundamental-panel.tsx panel/test/fundamental-panel.test.tsx
git commit -m "feat(panel): fundamental panel from parsed stance

Preamble renders verbatim — its bold labels are improvised every run,
so there is no schema to parse. Unrecognised sections render too, and
an unparseable stance falls back to raw markdown with a badge."
```

---

### Task 9: Status strip and footer strip

**Files:**
- Create: `panel/components/status-strip.tsx`

**Interfaces:**
- Consumes: `AgentRunRow`, `WakeupRow`, `EventRow`, `NotifyLogRow` from `lib/db.ts`.
- Produces: `<StatusStrip … />` and `<FooterStrip … />`.

**Deliberately NOT `RunBadge`.** It renders a full `<Badge>` pill; this strip
needs a 2×2 dot, so it carries its own small `DOT` status map. That duplicates
the status→colour semantics in `run-badge.tsx`, which is the codebase's existing
convention (each component owns its mapping, cf. `stat-card.tsx`) — but if a new
run status is ever added, both need updating.

**`lastRuns` must come from `db.lastRunPerType()`, never `db.getAgentRuns(N)`.**
The strip does a `.find()` per run type, so a fixed-size window would report an
infrequent type (retro runs weekly) as "never run". `lib/db.ts` documents this
footgun for a different consumer.

- [ ] **Step 1: Write the components**

Create `panel/components/status-strip.tsx`:

```tsx
import Link from "next/link";
import type { AgentRunRow, EventRow, NotifyLogRow, WakeupRow } from "@/lib/db";
import { cls, fmtAge, fmtDubai, fmtUtc } from "@/lib/format";

const RUN_TYPES = ["brief", "scan", "deepdive", "retro"] as const;

const DOT: Record<string, string> = {
  ok: "bg-emerald-400",
  failed: "bg-destructive",
  timeout: "bg-destructive",
  deferred: "bg-amber-400",
};

export function StatusStrip({ lastIngest, runsToday, cap, sourceErrors, lastRuns, now }: {
  lastIngest: string | null; runsToday: number; cap: number;
  sourceErrors: number; lastRuns: AgentRunRow[]; now: Date;
}) {
  const ingestStale = lastIngest === null
    || now.getTime() - new Date(lastIngest).getTime() > 60 * 60_000;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-border px-3 py-2 text-xs">
      <Link href="/crawl" className="hover:underline">
        <span className="text-muted-foreground">ingest </span>
        <span className={cls("tabular-nums", ingestStale ? "text-destructive" : "text-emerald-400")}>
          {lastIngest ? fmtAge(lastIngest, now) : "never"}
        </span>
      </Link>
      <Link href="/schedule" className="hover:underline">
        <span className="text-muted-foreground">runs </span>
        <span className={cls("tabular-nums", runsToday >= cap && "text-amber-400")}>
          {runsToday}/{cap}
        </span>
      </Link>
      <Link href="/crawl" className="hover:underline">
        <span className="text-muted-foreground">errors 24h </span>
        <span className={cls("tabular-nums", sourceErrors > 0 ? "text-amber-400" : "text-emerald-400")}>
          {sourceErrors}
        </span>
      </Link>
      <div className="flex items-center gap-3">
        {RUN_TYPES.map(t => {
          const r = lastRuns.find(x => x.run_type === t);
          return (
            <Link key={t} href="/schedule" className="flex items-center gap-1 hover:underline"
              title={r ? `${t}: ${r.status}, ${fmtAge(r.started_at, now)}` : `${t}: never run`}>
              <span className={cls("inline-block h-2 w-2 rounded-full",
                r ? DOT[r.status] ?? "bg-muted-foreground" : "bg-muted-foreground/40")} />
              <span className="text-muted-foreground">{t}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function FooterStrip({ wakeup, event, lastAlert, now }: {
  wakeup: WakeupRow | undefined; event: EventRow | undefined;
  lastAlert: NotifyLogRow | undefined; now: Date;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-border px-3 py-2 text-xs text-muted-foreground">
      <span>
        next wakeup:{" "}
        {wakeup
          ? <Link href="/schedule" className="text-foreground hover:underline">
              #{wakeup.id} {wakeup.run_type} {fmtAge(wakeup.due_at, now)}
            </Link>
          : "none pending"}
      </span>
      <span>
        next event:{" "}
        {event
          ? <Link href="/calendar" className="text-foreground hover:underline">
              {event.title} — {fmtUtc(event.starts_at)} ({fmtDubai(event.starts_at)})
            </Link>
          : "nothing upcoming"}
      </span>
      <span>
        last alert:{" "}
        {lastAlert
          ? <Link href="/alerts" className="text-foreground hover:underline">
              {fmtAge(lastAlert.ts, now)}
            </Link>
          : "none"}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `cd panel && npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add panel/components/status-strip.tsx
git commit -m "feat(panel): compact ops status strip and footer strip

Machine health stays visible and every element links to its detail
page; it just stops occupying the top half of the overview."
```

---

### Task 10: Wire the overview page

**Files:**
- Rewrite: `panel/app/page.tsx`
- Modify: `panel/test/fixtures/root/state/stance.md`
- Modify: `panel/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces: the rendered `/` route.

- [ ] **Step 1: Give the E2E fixture a realistic stance**

Replace `panel/test/fixtures/root/state/stance.md` with the following. Keep the "Gold constructive" sentence — `test/files.test.ts:13` asserts on it. Numbers match the fixture DB (spot 3325, SMA50 3250, SMA200 3400).

```markdown
# Stance — 2026-08-01 (updated 12:05 Dubai, fixture)

**EVENT-PENDING: fixture stance for the panel test suite.** Gold constructive
above 3300. Real yields drifting lower; dollar soft after the jobs miss.
Watching the Fed's September signal.

## View

**Weights 70/5/25 (base/event-bearish/kinetic), conviction medium-high.**

- **Base (~70%):** dips toward 3300 get bought; no 200DMA tag this week.
- **Event-bearish (~5%):** re-arms only on a verified policy pivot.
- **Kinetic tail (~25%):** arms on a mass-casualty escalation.

## What flips me

- Settle below 3250 without news — respect it.
- A 200DMA tag at 3400 on volume.

## Open predictions

`fixture01` no settle below 3250 this week (0.65).

## Wakeups

#1 Sat 2026-08-02 05:00Z deepdive (read the Fed statement).

## Desk-local

Fixture desk note: physical throughput unchanged.

## Sourcing health

Fixture note: investing_commodities returning 403.
```

- [ ] **Step 2: Rewrite the page**

Replace `panel/app/page.tsx` entirely:

```tsx
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { FundamentalPanel } from "@/components/fundamental-panel";
import { TechnicalPanel } from "@/components/technical-panel";
import { FooterStrip, StatusStrip } from "@/components/status-strip";
import * as db from "@/lib/db";
import * as files from "@/lib/files";
import { deriveSourceHealth, deriveWarnings } from "@/lib/health";
import { parseStance } from "@/lib/stance";
import { deriveTechnicals, TECHNICAL_SYMBOLS } from "@/lib/technicals";
import { fmtUtc } from "@/lib/format";

export const dynamic = "force-dynamic";

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export default function Overview() {
  const now = new Date();
  const dayAgo = iso(new Date(now.getTime() - 86400_000));

  // --- ops health (unchanged derivations, demoted presentation) ---
  const lastIngest = db.getMeta("last_ingest_at");
  const sources = files.loadSources();
  const lastFetch = Object.fromEntries(
    sources.map(s => [s.name, db.getMeta(`source_last_fetch.${s.name}`)]));
  const lastItems = Object.fromEntries(
    db.lastItemPerSource().map(r => [r.source, r.last]));
  const sourceErrors = db.getSourceErrors(dayAgo);
  const health = deriveSourceHealth(sources, lastFetch, lastItems, sourceErrors, now);
  const runsToday = db.runsTodayDubai(now);
  const cap = files.maxRunsPerDay();
  const warnings = deriveWarnings({ lastIngestAt: lastIngest, runs: db.getAgentRuns(50),
    sourceHealth: health, runsToday, cap }, now);

  // --- fundamental ---
  const stanceText = files.readStance();
  const stance = stanceText === null ? null : parseStance(stanceText);
  const items = db.getItems({ limit: 8 });

  // --- technical ---
  const p = db.latestPrices([...TECHNICAL_SYMBOLS]);
  // At-or-before, matching pricesummary.py's _delta — the first row *after*
  // the cutoff can sit hours away across an overnight or weekend gap.
  const spot24h = db.priceAtOrBeforeValue("GC", dayAgo);
  const tech = deriveTechnicals({
    spot: p.GC ?? null,
    spot24hAgo: spot24h,
    sma50: p.GC_SMA50 ?? null,
    sma200: p.GC_SMA200 ?? null,
    pivotS1: p.GC_PIV_S1 ?? null,
    pivotR1: p.GC_PIV_R1 ?? null,
    rsi14: p.GC_RSI14 ?? null,
    atr14: p.GC_ATR14 ?? null,
    gvz: p["^GVZ"] ?? null,
    netSpec: p.GC_NET_SPEC ?? null,
  }, now);
  const series = db.getPriceSeries("GC", iso(new Date(now.getTime() - 10 * 86400_000)));

  return (
    <div>
      <AutoRefresh />
      <PageHeader title="Overview" subtitle={`as of ${fmtUtc(iso(now))}`} />

      <StatusStrip lastIngest={lastIngest} runsToday={runsToday} cap={cap}
        sourceErrors={sourceErrors.length} lastRuns={db.lastRunPerType()} now={now} />

      {warnings.length > 0 && (
        <div className="mt-3 space-y-2">
          {warnings.map((w, i) => (
            <div key={i} className={w.severity === "red"
              ? "rounded border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive"
              : "rounded border border-amber-900 bg-amber-950/50 px-3 py-2 text-sm text-amber-300"}>
              {w.text}
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <FundamentalPanel stance={stance} items={items} now={now} />
        <TechnicalPanel tech={tech} series={series} now={now} />
      </div>

      <FooterStrip wakeup={db.getWakeups("pending")[0]}
        event={db.getEvents(14, now)[0]} lastAlert={db.getNotifyLog(1)[0]} now={now} />
    </div>
  );
}
```

- [ ] **Step 3: Extend the E2E smoke test**

In `panel/e2e/smoke.spec.ts`, append:

```ts
test("overview renders both market panels", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto("/");

  // Fundamental: heading, a parsed weight chip, a stance section, headlines.
  await expect(page.getByRole("heading", { name: "Fundamental" })).toBeVisible();
  await expect(page.getByText("base 70%")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What flips me" })).toBeVisible();
  await expect(page.getByText("Latest headlines")).toBeVisible();

  // Technical: heading, ladder rows, regime line, indicator readout.
  await expect(page.getByRole("heading", { name: "Technical" })).toBeVisible();
  // exact:true is required: the fixture stance's own prose mentions 200DMA
  // twice, so a substring match hits 4 elements and trips Playwright's
  // strict mode. Exact matching isolates the ladder's own <span>, which is
  // what proves the ladder rendered.
  await expect(page.getByText("200DMA", { exact: true })).toBeVisible();
  await expect(page.getByText("pivot S1", { exact: true })).toBeVisible();
  await expect(page.getByText("above 50DMA, below 200DMA")).toBeVisible();
  await expect(page.getByText("RSI14")).toBeVisible();

  // The panel must never render a buy/sell verdict.
  await expect(page.getByText(/strong buy|strong sell|recommend/i)).toHaveCount(0);

  // Ops survives, demoted.
  await expect(page.getByText("runs")).toBeVisible();
  expect(errors).toEqual([]);
});
```

- [ ] **Step 4: Run the full suite**

```bash
cd panel && npm test && npx tsc --noEmit && npm run lint && npm run e2e
```

Expected: all vitest suites pass, no type or lint errors, all Playwright tests pass including the new one.

- [ ] **Step 5: Look at it**

Run: `cd panel && JAMASP_ROOT=./test/fixtures/root npm run dev` and open `http://localhost:3000`.

Confirm by eye: the ladder reads top-to-bottom 3400 / 3390 / 3325 / 3250 / 3180 with spot emphasised; weight chips render; the two panels sit side by side at desktop width and stack with Fundamental first when narrowed.

- [ ] **Step 6: Commit**

```bash
git add panel/app/page.tsx panel/e2e/smoke.spec.ts panel/test/fixtures/root/state/stance.md
git commit -m "feat(panel): two-panel market overview

Overview now leads with what Jamasp thinks and where gold sits against
its levels; ops health survives as a status strip with every element
linking to its detail page.

Replaces the old grid that rendered all 19 price symbols as identical
anonymous stat cards — spot, RSI, moving averages and unrelated
cross-assets all shown as label/value/24h-7d, with 24h deltas on an
RSI that pricesummary.py already treats as noise."
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `lib/stance.ts` with `unwrapParagraphs` | 1 |
| Prefix heading match, `extra[]` preserved, preamble verbatim, `degraded` fallback | 2 |
| `weights` regex, null on mismatch | 3 |
| `latestPrices` batch helper | 4 |
| `priceAtOrBeforeValue` for a gap-safe 24h delta, matching `pricesummary.py` | 4, consumed in 10 |
| Fixture technical series | 4 |
| `lib/technicals.ts` levels, DB-only | 5 |
| Regime ported from `pricesummary.py#_tech_line` + drift guard comments | 5 |
| 12h staleness | 5 |
| No buy/sell verdict | 5 (absence), 10 (E2E assertion) |
| `level-ladder.tsx` | 6 |
| `sparkline.tsx`, `technical-panel.tsx` | 7 |
| `fundamental-panel.tsx` incl. 8 headlines | 8 |
| `status-strip.tsx` + footer strip | 9 |
| Page layout, two columns at `lg:`, stacked below | 10 |
| Warnings kept full-width | 10 |
| Error-handling table (missing stance, unparseable, no weights, missing SMA, no GC rows, stale, zero items) | 2, 3, 5, 7, 8 |
| E2E both panels | 10 |

**Corrections made against the spec:** the spec named `scripts/build-fixture.mjs` as the place to add fixture price data; the data actually lives in `test/fixtures/fixture.sql`, which that script executes. Noted in Global Constraints.

**Type consistency:** `Quote`, `Level`, `LevelKind`, `LevelSide`, `TechnicalsInput`, `GoldTechnicals`, `TECHNICAL_SYMBOLS` defined in Task 5 and consumed unchanged in 6, 7, 10. `StanceKey`, `StanceSection`, `ParsedStance`, `StanceWeight` defined in 2–3 and consumed in 8, 10. `latestPrices` defined in 4, called in 10 with `[...TECHNICAL_SYMBOLS]` (spread required — the constant is `readonly`, the parameter is `string[]`). `ladderGaps` defined and consumed in 6.

**Known follow-ups, deliberately out of scope:** the `Markdown` component's handling of the stance's `` `id` `` prediction hashes is untested here; cross-asset board and chart overlays are separate work.
