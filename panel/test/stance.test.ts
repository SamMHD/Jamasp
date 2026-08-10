import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { unwrapParagraphs } from "../lib/stance";
import { parseStance } from "../lib/stance";
import { parseWeights } from "../lib/stance";

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

  it("joins the real >40% comparison line in the shipped fixtures, not as a blockquote", () => {
    for (const name of ["brief-2026-08-09", "scan-2026-08-09"]) {
      const unwrapped = unwrapParagraphs(fixture(name));
      expect(unwrapped.split("\n").some(line => /^\s*>40%/.test(line))).toBe(false);
    }
  });

  it("is idempotent", () => {
    const once = unwrapParagraphs(fixture("brief-2026-08-10"));
    expect(unwrapParagraphs(once)).toBe(once);
  });
});

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

  it("returns null when a label is empty, rather than silently reindexing", () => {
    expect(parseWeights("Weights 70/5/25 (unknown/base//kinetic)")).toBeNull();
    expect(parseWeights("Weights 70/5/25 (base//kinetic)")).toBeNull();
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
});
