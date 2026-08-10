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
