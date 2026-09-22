import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SourceLang } from "@/components/source-lang";
import en from "@/messages/en.json";

const messages = en as Record<string, string>;

// This project has no @testing-library/react (see top-bar.test.tsx and
// lang-toggle.test.tsx), so — same as every other component test here —
// this renders with renderToStaticMarkup and asserts against the markup
// string rather than screen.getByText/queryByText.

describe("SourceLang", () => {
  it("marks fallback content", () => {
    const html = renderToStaticMarkup(
      <SourceLang fallback messages={messages}>Gold climbs</SourceLang>);
    expect(html).toContain("Gold climbs");
    expect(html).toContain(messages["content.sourceEnglish"]);
  });

  it("adds no marker when the content is translated", () => {
    const html = renderToStaticMarkup(
      <SourceLang fallback={false} messages={messages}>طلا بالا رفت</SourceLang>);
    expect(html).toContain("طلا بالا رفت");
    expect(html).not.toContain(messages["content.sourceEnglish"]);
  });

  it("marks the fallback text as English for screen readers and typography", () => {
    // Two effects, and only one of them used to be real.
    //
    // The screen-reader half always worked: lang="en" is what stops English
    // words being announced with a Persian voice.
    //
    // The typography half did NOT, and this comment used to claim it did.
    // app/globals.css set font-family: var(--font-fa) on
    // :where([dir="rtl"], [lang="fa"]) — which lands on <html> — and
    // font-family inherits, so the fallback text rendered in Vazirmatn like
    // everything else. It took an explicit [lang="en"] rule in globals.css
    // to restore the Latin face; the attribute alone does nothing.
    const html = renderToStaticMarkup(
      <SourceLang fallback messages={messages}>Gold climbs</SourceLang>);
    expect(html).toContain('lang="en"');
  });

  it("wraps fallback content in a span by default", () => {
    // The common case is inline English (a headline, a title) sitting
    // beside other inline text — a <div> there would break the line.
    const html = renderToStaticMarkup(
      <SourceLang fallback messages={messages}>Gold climbs</SourceLang>);
    expect(html).toContain('<span lang="en" dir="ltr">Gold climbs</span>');
  });

  it("wraps fallback content in a div when block is set", () => {
    // <Markdown> renders a <div class="prose"> containing <p>/<ul>/<table> —
    // block content, which a <span> (phrasing-only) cannot legally contain.
    const html = renderToStaticMarkup(
      <SourceLang fallback block messages={messages}>
        <div className="prose">Gold climbs</div>
      </SourceLang>);
    expect(html).toContain('<div lang="en" dir="ltr">');
    expect(html).not.toContain('<span lang="en"');
  });

  it("keeps the badge itself a span even in block mode", () => {
    // Only the wrapper around the CONTENT changes; the small "EN" badge
    // beside it is inline text either way.
    const html = renderToStaticMarkup(
      <SourceLang fallback block messages={messages}>
        <div className="prose">Gold climbs</div>
      </SourceLang>);
    expect(html).toContain(`>${messages["content.sourceEnglish"]}</span>`);
  });
});

/**
 * The typography half of SourceLang's contract lives in CSS, not in the
 * component, so it is asserted against the stylesheet — the same shape
 * test/type-scale.test.ts uses for its own token checks.
 */
describe("SourceLang typography (app/globals.css)", () => {
  const css = readFileSync(
    path.join(import.meta.dirname, "..", "app/globals.css"), "utf8");

  it("restores the Latin face for lang=\"en\" islands", () => {
    // Without this rule the Persian font-family set on <html> inherits
    // straight through the lang="en" wrapper, and English fallback text
    // renders in Vazirmatn — which is exactly what the EN marker exists to
    // say is NOT happening.
    expect(css).toMatch(/\[lang="en"\]\s*\{[^}]*font-family:\s*var\(--font-sans\)/);
  });

  it("keeps that rule out of :where(), so it can win", () => {
    // :where() zeroes specificity. The Persian rule above it is
    // :where([dir="rtl"], [lang="fa"]), also zero — a zero-specificity
    // English rule would then be decided by source order alone.
    const line = css.split("\n").find(l => l.includes('[lang="en"]'));
    expect(line).toBeDefined();
    expect(line).not.toContain(":where(");
  });
});
