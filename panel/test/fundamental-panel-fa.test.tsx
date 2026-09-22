import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FundamentalPanel } from "../components/fundamental-panel";
import { parseStance } from "../lib/stance";
import type { StanceFaSection } from "../lib/files";
import en from "../messages/en.json";
import fa from "../messages/fa.json";

// No @testing-library/react in this project — see test/calendar-i18n.test.tsx
// and test/fundamental-panel.test.tsx for the established convention of
// asserting on the renderToStaticMarkup string directly.

const messages = { en: en as Record<string, string>, fa: fa as Record<string, string> };
const NOW = new Date("2026-08-01T12:00:00Z");

const STANCE = `# Stance — 2026-08-01 (updated 12:05 Dubai)

**EVENT-PENDING:** lead paragraph text.

## View

**Weights 70/5/25 (base/event-bearish/kinetic), conviction medium-high.**

- **Base (~70%):** dips toward 3300 get bought.

## What flips me

- Settle below 3250 → respect it.
`;

/**
 * A sidecar matching STANCE's shape exactly: preamble (position 0), View
 * (1), What flips me (2) — mirroring readStanceFa's own output shape
 * (heading/hash/body triples in source order), not going through the
 * filesystem reader at all since these tests are about FundamentalPanel's
 * consumption of that shape, not about reading it from disk (files-fa.test.ts
 * covers that).
 */
function faSections(overrides: Record<number, StanceFaSection> = {}):
  { sections: StanceFaSection[] } {
  const base: StanceFaSection[] = [
    { heading: "", hash: "h0", body: "پاراگراف اصلی رهبری.\n" },
    { heading: "## View", hash: "h1",
      body: "- **پایه (~70%):** ریزش‌ها به سمت 3300 خریداری می‌شوند.\n" },
    { heading: "## What flips me", hash: "h2",
      body: "- بسته شدن زیر 3250 → به آن احترام بگذارید.\n" },
  ];
  for (const [i, s] of Object.entries(overrides)) base[Number(i)] = s;
  return { sections: base };
}

const render = (
  locale: "en" | "fa", stanceFa: { sections: StanceFaSection[] } | null,
) => renderToStaticMarkup(
  <FundamentalPanel stance={parseStance(STANCE)} watchlist={[]} now={NOW}
    locale={locale} messages={messages[locale]} stanceFa={stanceFa} />);

/**
 * How many sections SourceLang marked as an English fallback. Not a bare
 * `.toContain("EN")`: the stance prose itself contains "EN" as a substring
 * of ordinary English words ("EVENT-PENDING", "event-bearish"), which would
 * make that assertion pass whether or not a marker was ever rendered.
 * `lang="en"` is SourceLang's own wrapper attribute and only appears when
 * `fallback` is true (source-lang.tsx), so counting it is exact.
 */
const fallbackCount = (html: string) => (html.match(/lang="en"/g) ?? []).length;

describe("FundamentalPanel Persian rendering", () => {
  it("renders Persian bodies under dictionary headings when the sidecar matches", () => {
    const html = render("fa", faSections());
    expect(html).toContain(messages.fa["stance.view"]);
    expect(html).toContain(messages.fa["stance.whatFlipsMe"]);
    expect(html).toContain("پاراگراف اصلی رهبری");
    expect(html).toContain("ریزش‌ها به سمت 3300");
    expect(html).toContain("به آن احترام بگذارید");
    expect(fallbackCount(html)).toBe(0);
  });

  it("falls back to English with the marker section-by-section when there is no sidecar", () => {
    const html = render("fa", null);
    expect(html).toContain("dips toward 3300 get bought");
    expect(html).toContain("Settle below 3250");
    // Preamble, View and What-flips-me each fall back independently.
    expect(fallbackCount(html)).toBe(3);
  });

  it("falls back to English wholesale when the sidecar's section count disagrees with the source", () => {
    // Missing the "What flips me" entry entirely — a real staleness
    // scenario (sidecar written against an older, shorter stance.md).
    const html = render("fa", { sections: faSections().sections.slice(0, 2) });
    expect(html).toContain("dips toward 3300 get bought");
    expect(html).toContain("Settle below 3250");
    expect(html).not.toContain("ریزش‌ها به سمت 3300");
    expect(fallbackCount(html)).toBe(3);
  });

  // Finding B3 (PR 1 review), consumer side: a section can carry its
  // English body under an empty per-section hash while the rest of the
  // sidecar is real Persian. That section must render as an English
  // fallback with the marker, in its own position, without disturbing the
  // sections around it.
  it("renders a hazard section (empty per-section hash) as an English fallback without disturbing the others", () => {
    const html = render("fa", faSections({
      2: { heading: "## What flips me", hash: "", body: "irrelevant — hash empty means ignored\n" },
    }));
    expect(html).toContain("ریزش‌ها به سمت 3300"); // View: still Persian
    expect(html).toContain("Settle below 3250");    // What flips me: fell back to English
    // Exactly the one section — preamble and View stay real Persian.
    expect(fallbackCount(html)).toBe(1);
  });

  it("never renders Persian in English locale even when a valid sidecar exists", () => {
    const html = render("en", faSections());
    expect(html).toContain("dips toward 3300 get bought");
    expect(html).not.toContain("ریزش‌ها");
    // No fallback marker either: English locale is never "falling back" to
    // anything, it is simply English (localized() short-circuits on "en").
    expect(fallbackCount(html)).toBe(0);
  });

  it("renders unmarked English when the English locale is passed explicitly", () => {
    // This used to assert that locale/messages could be OMITTED, which is
    // precisely the defaulting that let components/driver-panel.tsx drop
    // `messages` on its QuoteTiles and print English in Persian mode with
    // nothing failing. Both props are required now, so the English path is
    // stated rather than inherited.
    const html = renderToStaticMarkup(
      <FundamentalPanel stance={parseStance(STANCE)} watchlist={[]} now={NOW}
        locale="en" messages={messages.en} />);
    expect(html).toContain("dips toward 3300 get bought");
    expect(fallbackCount(html)).toBe(0);
  });
});

describe("FundamentalPanel — Persian chrome", () => {
  it("translates the heading, no-stance/no-format states, and the watching section", () => {
    const html = render("fa", null);
    expect(html).toContain(fa["fundamental.heading"]);
    expect(html).not.toContain(">Fundamental<");

    const noStance = renderToStaticMarkup(
      <FundamentalPanel stance={null} watchlist={[]} now={NOW} locale="fa" messages={messages.fa} />);
    expect(noStance).toContain(fa["common.noStanceYet"]);

    const empty = renderToStaticMarkup(
      <FundamentalPanel stance={parseStance(STANCE)} watchlist={[]} now={NOW}
        locale="fa" messages={messages.fa} />);
    expect(empty).toContain(fa["fundamental.watchingHeading"]);
    expect(empty).toContain(fa["fundamental.watchlistEmpty"]);
  });

  it("translates the stance-age label and 'd old' suffix, keeping the number Latin", () => {
    const html = render("fa", faSections());
    expect(html).toContain(fa["fundamental.stancePrefix"]);

    // STANCE is dated 2026-08-01; a later `now` puts it well past the ≥2-day
    // amber threshold, so the age suffix is guaranteed to render here.
    const laterNow = new Date("2026-08-05T12:00:00Z");
    const aged = renderToStaticMarkup(
      <FundamentalPanel stance={parseStance(STANCE)} watchlist={[]} now={laterNow}
        locale="fa" messages={messages.fa} stanceFa={faSections()} />);
    expect(aged).toContain(`4${fa["fundamental.daysOldSuffix"]}`); // "4" + fa suffix, no space
    expect(aged).not.toMatch(/[۰-۹]/);
  });
});

/**
 * The Watching chips' tooltip. /state localizes the very same `why` field
 * through localized() + SourceLang, and this panel rendered the raw English
 * one — so the same sentence was Persian on one page and English on the
 * other.
 *
 * A `title` attribute is a plain string and cannot hold a <SourceLang>
 * element, so an untranslated one appends content.sourceEnglishTitle
 * instead: exactly the shape components/market-map.tsx#tileTitle already
 * uses for the same problem.
 */
describe("FundamentalPanel — Watching chip tooltips", () => {
  const watchlist = [
    { theme: "real_yields", why: "Real yields lead gold.", since: "2026-07-01" },
    { theme: "cb_buying", why: "Central banks keep bidding.", since: "2026-06-15" },
  ];

  it("uses the Persian why as the tooltip when the sidecar has it", () => {
    const html = renderToStaticMarkup(
      <FundamentalPanel stance={null} watchlist={watchlist} now={NOW}
        locale="fa" messages={messages.fa}
        watchlistFa={{ real_yields: "بازده واقعی طلا را هدایت می‌کند." }} />);
    expect(html).toContain('title="بازده واقعی طلا را هدایت می‌کند."');
    expect(html).not.toContain('title="Real yields lead gold."');
  });

  it("marks an untranslated tooltip rather than showing bare English", () => {
    const html = renderToStaticMarkup(
      <FundamentalPanel stance={null} watchlist={watchlist} now={NOW}
        locale="fa" messages={messages.fa}
        watchlistFa={{ real_yields: "بازده واقعی طلا را هدایت می‌کند." }} />);
    // cb_buying has no sidecar entry: English, but said so.
    expect(html).toContain("Central banks keep bidding.");
    expect(html).toContain(messages.fa["content.sourceEnglishTitle"]);
  });

  it("keeps the English tooltip unmarked in the English locale", () => {
    const html = renderToStaticMarkup(
      <FundamentalPanel stance={null} watchlist={watchlist} now={NOW}
        locale="en" messages={messages.en}
        watchlistFa={{ real_yields: "بازده واقعی طلا را هدایت می‌کند." }} />);
    expect(html).toContain('title="Real yields lead gold."');
    expect(html).not.toContain("بازده واقعی");
    expect(html).not.toContain(messages.en["content.sourceEnglishTitle"]);
  });

  it("marks every tooltip when no sidecar has been written at all", () => {
    const html = renderToStaticMarkup(
      <FundamentalPanel stance={null} watchlist={watchlist} now={NOW}
        locale="fa" messages={messages.fa} />);
    expect(html).toContain("Real yields lead gold.");
    expect(html).toContain("Central banks keep bidding.");
    expect((html.match(new RegExp(messages.fa["content.sourceEnglishTitle"], "g")) ?? []))
      .toHaveLength(2);
  });
});
