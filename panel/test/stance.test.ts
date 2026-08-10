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
    const re = /Weights\s+(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\(([^)]+)\)/i;
    const wrapped = "**Weights 70/5/25 (base/event-bearish/\nkinetic), conviction capped by CPI.**";
    expect(wrapped.split("\n").some(line => re.test(line))).toBe(false);
    expect(re.test(unwrapParagraphs(wrapped))).toBe(true);
  });

  it("recovers the full bolded weights sentence, which does cross a wrap in real history", () => {
    // Line-based matching of this wider span succeeds in only 1 of 10 real
    // versions; after unwrapping it succeeds in all six fixtures.
    const sentence = /\*\*Weights[^*]*\*\*/;
    const hits = allFixtures().filter(([, text]) => sentence.test(unwrapParagraphs(text)));
    const rawHits = allFixtures().filter(([, text]) =>
      text.split("\n").some(line => sentence.test(line)));
    expect(hits.length).toBe(6);
    expect(rawHits.length).toBeLessThan(6);
  });

  it("is idempotent", () => {
    const once = unwrapParagraphs(fixture("brief-2026-08-10"));
    expect(unwrapParagraphs(once)).toBe(once);
  });
});
