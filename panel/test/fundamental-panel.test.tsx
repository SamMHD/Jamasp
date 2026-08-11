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
    expect(html).toContain("base");
    expect(html).toContain("70");
    expect(html).toContain("lead paragraph text");
    expect(html).toContain("What flips me");
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
