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

/**
 * The rule above only ever reaches a lang="en" *island* — it says nothing
 * about the Persian page around it. That's a second, independent bug: the
 * :where([dir="rtl"], [lang="fa"]) rule sits on <html> and font-family only
 * inherits, but <body> carries Tailwind's `font-sans` utility class, which
 * sets font-family DIRECTLY on <body> itself. An element's own declaration
 * always beats an inherited one, so body's Inter wins over html's Vazirmatn
 * for literally everything rendered on the panel, regardless of the html
 * rule's specificity — nothing above targets <body>, so there is no
 * specificity contest to win in the first place.
 *
 * Same shape as the describe block above: asserted against the stylesheet,
 * not the component, because the fix lives entirely in CSS.
 */
describe("Persian body typography (app/globals.css)", () => {
  const css = readFileSync(
    path.join(import.meta.dirname, "..", "app/globals.css"), "utf8");
  const rule = css.match(/html\[dir="rtl"\]\s*body\s*,\s*html\[lang="fa"\]\s*body\s*\{[^}]*\}/);

  it("targets <body> directly instead of relying on inheritance from <html>", () => {
    // A rule that only matches <html> can never win this: <body> has its
    // own font-family declaration (Tailwind's `font-sans` utility), so
    // nothing below <html> ever inherits <html>'s value. The fix has to
    // name <body> to have any effect at all.
    expect(rule, 'expected a rule matching html[dir="rtl"] body / html[lang="fa"] body ' +
      "with font-family: var(--font-fa)").not.toBeNull();
    expect(rule![0]).toMatch(/font-family:\s*var\(--font-fa\)/);
  });

  it("carries !important — the only thing that outranks a utilities-layer class from @layer base", () => {
    // Naming <body> is necessary but not sufficient. `.font-sans` lives in
    // Tailwind's `utilities` @layer, and this stylesheet's own `@layer
    // base` (Tailwind's fixed layer order is theme < base < components <
    // utilities) loses to it on LAYER ALONE — a `base`-layer rule cannot
    // outrank a `utilities`-layer one no matter how specific its selector
    // is made. Verified by hand against this exact stylesheet: even
    // `html body.min-h-screen.bg-background.font-sans.text-foreground
    // .antialiased { font-family: var(--font-fa); }` inside `@layer base`
    // does not move body's computed font-family. `!important` is the one
    // thing here that outranks a utility class from outside
    // `@layer utilities` itself. Drop it and this rule looks correct,
    // parses fine, and silently does nothing — exactly the original bug.
    expect(rule).not.toBeNull();
    expect(rule![0]).toContain("!important");
  });

  it("stays keyed to <html>'s attributes, not <body>'s class list", () => {
    // The original bug exists BECAUSE a rule's effect depended on which
    // classes <body> happened to carry. Anchoring the fix to <body>'s
    // class list in turn (e.g. `body.font-sans`) would be the same
    // fragility with the polarity flipped: it would silently stop applying
    // the next time someone edits app/layout.tsx's <body> className.
    // Keying off <html>'s dir/lang attributes instead survives that edit.
    expect(rule).not.toBeNull();
    expect(rule![0]).not.toMatch(/body\.[\w-]/);
  });
});
