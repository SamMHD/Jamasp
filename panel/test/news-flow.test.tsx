import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NewsFlow } from "../components/news-flow";
import { deriveNewsPulse } from "../lib/newsflow";
import type { ClusterHeadRow, ItemRow } from "../lib/db";

const NOW = new Date("2026-08-11T12:00:00Z");

const head = (id: string, headline: string, sourcesN: number): ClusterHeadRow => ({
  id, source: "reuters", published_at: "2026-08-10T10:00:00Z", headline,
  lede: null, url: `https://example.test/${id}`, topic: "gold", cluster_id: id,
  fetched_at: "2026-08-10T10:05:00Z", read_at: null, sources_n: sourcesN,
});

const item = (id: string, headline: string): ItemRow => ({
  id, source: "reuters", published_at: "2026-08-10T08:00:00Z", headline,
  lede: null, url: `https://example.test/${id}`, topic: "regional", cluster_id: id,
  fetched_at: "2026-08-10T08:05:00Z", read_at: null,
});

const PULSE = deriveNewsPulse(
  [{ day: "2026-08-10", topic: "gold", n: 3 },
   { day: "2026-08-10", topic: "regional", n: 9 },
   { day: "2026-08-09", topic: "analysis", n: 4 }],
  "2026-08-10T11:00:00Z", 14);

const render = (over: Partial<Parameters<typeof NewsFlow>[0]> = {}) =>
  renderToStaticMarkup(
    <NewsFlow pulse={PULSE} heads={[head("h1", "Gold holds 4380", 1)]}
      top={null} lastItemTs="2026-08-10T11:00:00Z" now={NOW} {...over} />);

describe("NewsFlow", () => {
  it("renders the volume chart with its accessible name and table twin", () => {
    const html = render();
    expect(html).toContain("news volume, 16 items over 14 days to 2026-08-10");
    expect(html).toContain("daily counts");
    expect(html).toContain("2026-08-09"); // table twin row
    expect(html).toContain("gold topic"); // legend, two series
    expect(html).toContain("other topics");
  });

  it("carries the full per-topic breakdown in the bar titles", () => {
    const html = render();
    expect(html).toContain("2026-08-10: 12 items — regional 9 · gold 3");
    expect(html).toContain("2026-08-09: 4 items — analysis 4");
  });

  it("states the feed age unconditionally", () => {
    expect(render()).toContain("last item 25h ago");
  });

  it("shows the top multi-wire story with its source count", () => {
    const html = render({
      top: { item: item("t1", "Strait strike verified"), sources: 4, items: 6 },
    });
    expect(html).toContain("top story");
    expect(html).toContain("Strait strike verified");
    expect(html).toContain("4 wires");
  });

  it("states the absence of any multi-wire story rather than omitting the line", () => {
    expect(render({ top: null })).toContain("no story on more than one wire");
  });

  it("badges multi-source headlines and leaves single-wire ones unbadged", () => {
    const html = render({
      heads: [head("h1", "Widely carried story", 4), head("h2", "Single-wire story", 1)],
    });
    expect(html).toContain("4 wires");
    expect(html).toContain("Widely carried story");
    expect(html).toContain("Single-wire story");
    expect(html).not.toContain("1 wires");
  });

  it("renders headlines with source and link", () => {
    const html = render();
    expect(html).toContain("Gold holds 4380");
    expect(html).toContain("reuters");
    expect(html).toContain("https://example.test/h1");
  });

  it("shows 'no items' for an empty headline list", () => {
    expect(render({ heads: [] })).toContain("no items");
  });

  it("designs the never-ingested state — no chart, no fabricated axis", () => {
    const html = render({ pulse: deriveNewsPulse([], null), heads: [], lastItemTs: null });
    expect(html).toContain("no news items recorded yet");
    expect(html).toContain("no items");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("last item");
  });

  it("labels only the peak day directly", () => {
    const html = render();
    // Peak day total (12) appears as the single direct bar label; the
    // quieter day's total (4) stays in titles and the table only.
    const labels = html.match(/<text[^>]*text-anchor="middle"[^>]*>(\d+)<\/text>/g) ?? [];
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain(">12<");
  });
});
