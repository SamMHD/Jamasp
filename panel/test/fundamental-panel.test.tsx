import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FundamentalPanel } from "../components/fundamental-panel";
import { parseStance } from "../lib/stance";
import type { WatchlistEntry } from "../lib/files";

const NOW = new Date("2026-08-01T12:00:00Z");

const STANCE = `# Stance — 2026-08-01 (updated 12:05 Dubai)

**EVENT-PENDING:** lead paragraph text.

## View

**Weights 70/5/25 (base/event-bearish/kinetic), conviction medium-high.**

- **Base (~70%):** dips toward 3300 get bought.
- **Event-bearish (~5%):** re-arms only on a verified pivot.
- **Mystery scenario:** matches no weight label.

## What flips me

- Settle below 3250 → respect it.
- A close above 3400 on volume.

## Extra section from the agent

Ad-hoc content.
`;

const WATCH: WatchlistEntry[] = [
  { theme: "fed-rate-path", why: "dominant driver of real yields", since: "2026-07-31" },
];

const render = (stance: ReturnType<typeof parseStance> | null,
  watchlist: WatchlistEntry[] = []) =>
  renderToStaticMarkup(
    <FundamentalPanel stance={stance} watchlist={watchlist} now={NOW} />);

/** Every key that appears twice among the same array of siblings. */
function duplicateSiblingKeys(node: ReactNode): string[] {
  const dups: string[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      const seen = new Set<string>();
      for (const child of n) {
        if (!isValidElement(child) || child.key === null) continue;
        if (seen.has(child.key)) dups.push(child.key);
        seen.add(child.key);
      }
      n.forEach(visit);
      return;
    }
    if (isValidElement(n)) visit((n.props as { children?: unknown }).children);
  };
  visit(node);
  return dups;
}

describe("FundamentalPanel", () => {
  it("renders weight chips, preamble and sections", () => {
    const html = render(parseStance(STANCE));
    // "base 70%" is chip-only: the View body's markdown says
    // "Weights 70/5/25 (base/event-bearish/kinetic)", never this shape.
    expect(html).toContain("base 70%");
    expect(html).toContain("event-bearish 5%");
    expect(html).toContain("lead paragraph text");
    expect(html).toContain("What flips me");
  });

  it("renders the View section with its heading and body", () => {
    const html = render(parseStance(STANCE));
    expect(html).toContain("View");
    expect(html).toContain("conviction medium-high");
    expect(html).toContain("dips toward 3300 get bought");
  });

  it("ties matching View bullets to their weight-bar slots", () => {
    const html = render(parseStance(STANCE));
    // Each viz var paints the bar segment + its legend swatch; a matched
    // scenario bullet adds a third occurrence. The kinetic slot has no
    // matching bullet in this stance, so it stays at two.
    expect(html.split("var(--viz-1)").length - 1).toBe(3);
    expect(html.split("var(--viz-2)").length - 1).toBe(3);
    expect(html.split("var(--viz-3)").length - 1).toBe(2);
  });

  it("gives an unmatched View bullet a hollow marker, not a guessed colour", () => {
    const html = render(parseStance(STANCE));
    expect(html).toContain("matches no weight label");
    expect(html).toContain("border-muted-foreground/50");
  });

  it("renders the whole View body verbatim when no weights parsed", () => {
    const html = render(parseStance(
      "# S — 2026-08-01\n\n## View\n\nno triplet here\n\n- **Base:** a bullet"));
    expect(html).toContain("no triplet here");
    expect(html).toContain("a bullet");
    // No weights → no slots to tie to → no swatches at all.
    expect(html).not.toContain("var(--viz-1)");
  });

  it("splits falsifiers at the analyst's arrow into condition and consequence", () => {
    const html = render(parseStance(STANCE));
    // The condition ends its own element — the arrow is layout, not text.
    expect(html).toContain("Settle below 3250</p>");
    expect(html).toContain("respect it.");
  });

  it("renders an arrowless falsifier whole, inventing nothing", () => {
    const html = render(parseStance(STANCE));
    expect(html).toContain("A close above 3400 on volume.");
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

  it("does not flag a same-day or day-old stance as stale", () => {
    expect(render(parseStance(STANCE))).not.toContain("d old");
  });

  it("flags a stance two or more days old in the header", () => {
    const old = STANCE.replace("2026-08-01 (updated 12:05 Dubai)", "2026-07-30");
    const html = render(parseStance(old));
    expect(html).toContain("2d old");
  });

  it("renders unrecognised sections rather than dropping them", () => {
    expect(render(parseStance(STANCE))).toContain("Extra section from the agent");
  });

  // Headings in `extra` are free-form agent prose: two ad-hoc sections can
  // share a title, and a repeated "## View" is routed to extra rather than
  // overwriting the first. Keying on the heading alone collides.
  //
  // Asserted on the element tree, not on the markup: React's static renderer
  // emits both sections and does not warn, so duplicate keys are invisible in
  // HTML. The damage is client-side, where this page re-renders on every
  // AutoRefresh tick and the reconciler matches siblings by key.
  it("gives repeated extra headings distinct React keys", () => {
    const dup = `# S — 2026-08-01

## View

body

## Watching

first block

## Watching

second block
`;
    const parsed = parseStance(dup);
    expect(parsed.extra.map(s => s.heading)).toEqual(["Watching", "Watching"]);

    expect(duplicateSiblingKeys(
      FundamentalPanel({ stance: parsed, watchlist: [], now: NOW })))
      .toEqual([]);

    const html = render(parsed);
    expect(html).toContain("first block");
    expect(html).toContain("second block");
  });

  it("shows 'no stance yet' when there is no stance file", () => {
    expect(render(null)).toContain("no stance yet");
  });

  it("falls back to raw markdown on an unparseable stance", () => {
    const html = render(parseStance("just prose, no structure at all"));
    expect(html).toContain("just prose, no structure at all");
    expect(html).toContain("unrecognised format");
  });

  it("keeps the watchlist visible beneath a degraded stance", () => {
    const html = render(parseStance("just prose, no structure at all"), WATCH);
    expect(html).toContain("unrecognised format");
    expect(html).toContain("fed-rate-path");
  });

  it("omits the chips when no weights line is present", () => {
    const html = render(parseStance("# S — 2026-08-01\n\n## View\n\nno triplet here"));
    expect(html).not.toContain("%</");
  });

  it("renders watchlist themes as chips with age and reason", () => {
    const html = render(parseStance(STANCE), WATCH);
    expect(html).toContain("fed-rate-path");
    expect(html).toContain("dominant driver of real yields"); // title = why
    expect(html).toContain("ago"); // since date rendered as an age
  });

  it("states an empty watchlist rather than omitting the block", () => {
    expect(render(parseStance(STANCE), [])).toContain("watchlist empty");
  });
});
