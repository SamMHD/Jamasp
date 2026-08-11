import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HorizonStrip } from "../components/horizon-strip";
import { deriveHorizon } from "../lib/horizon";
import type { EventRow, WakeupRow } from "../lib/db";
import type { Prediction } from "../lib/files";

const NOW = new Date("2026-08-11T09:00:00Z");

const ev = (over: Partial<EventRow>): EventRow => ({
  id: "e", source: "ff_calendar", title: "CPI m/m", country: "USD", impact: "High",
  starts_at: "2026-08-12T12:30:00Z", fetched_at: "2026-08-11T00:00:00Z", ...over,
});
const pred = (over: Partial<Prediction>): Prediction => ({
  id: "772323d6", date: "2026-08-09", claim: "no 200DMA tag pre-CPI", direction: "flat",
  horizon_days: 3, confidence: 0.65, created_at: "2026-08-09T03:33:28Z",
  outcome: null, scored_at: null, note: null, ...over,
});
const wk = (over: Partial<WakeupRow>): WakeupRow => ({
  id: 20, due_at: "2026-08-12T12:45:00Z", run_type: "deepdive", task: "CPI read-through",
  status: "pending", attempts: 0, created_at: "2026-08-07T12:00:00Z", fired_at: null, ...over,
});

const render = (input: { events?: EventRow[]; predictions?: Prediction[]; wakeups?: WakeupRow[] }) =>
  renderToStaticMarkup(
    <HorizonStrip horizon={deriveHorizon(
      { events: input.events ?? [], predictions: input.predictions ?? [],
        wakeups: input.wakeups ?? [] }, NOW)} now={NOW} />);

describe("HorizonStrip", () => {
  it("renders all three lanes with marks, labels, and the list twin", () => {
    const html = render({ events: [ev({})], predictions: [pred({})], wakeups: [wk({})] });
    expect(html).toContain("7-day horizon: 1 event slots, 1 prediction maturities, 1 pending wakeups");
    expect(html).toContain("CPI m/m");        // event label + list row
    expect(html).toContain("772323d6");       // prediction id
    expect(html).toContain("#20 deepdive");   // wakeup
    expect(html).toContain("conf 0.65");      // stated confidence, reported not judged
    expect(html).toContain("maturities");     // lane label
    expect(html).toContain("now");
  });

  it("summarises counts including explicit zeros for empty lanes", () => {
    const html = render({ events: [ev({})] });
    expect(html).toContain("1 event slot");
    expect(html).toContain("0 maturing");
    expect(html).toContain("0 wakeups");
  });

  it("gives the first high-impact event the only direct axis label", () => {
    const html = render({
      events: [ev({}), ev({ id: "2", title: "PPI m/m", starts_at: "2026-08-13T12:30:00Z" })],
    });
    // Both appear in list rows and titles; the axis label is a <text> node.
    const axisLabels = html.match(/<text[^>]*y="9"[^>]*>/g) ?? [];
    expect(axisLabels.length).toBe(1);
  });

  it("flags an overdue wakeup in the list and the summary", () => {
    const html = render({ wakeups: [wk({ id: 7, due_at: "2026-08-02T05:00:00Z" })] });
    expect(html).toContain("overdue");
    expect(html).toContain("1 overdue");
    expect(html).toContain("#7 deepdive");
  });

  it("caps the list and states how many entries it withheld", () => {
    const events = Array.from({ length: 9 }, (_, i) =>
      ev({ id: `e${i}`, title: `Event ${i}`, starts_at: `2026-08-1${2 + (i % 5)}T0${i % 9}:00:00Z` }));
    const html = render({ events });
    expect(html).toContain("+3 more within 7d");
  });

  it("renders a designed empty state instead of a bare axis", () => {
    const html = render({});
    expect(html).toContain("nothing on the horizon");
    expect(html).not.toContain("<svg");
  });

  it("renders medium impact as an open mark, high as filled", () => {
    const html = render({
      events: [ev({}), ev({ id: "m", title: "Unemployment Claims", impact: "Medium",
        starts_at: "2026-08-13T12:30:00Z" })],
    });
    // The open (medium) mark wears the surface fill with the lane hue stroke.
    expect(html).toContain('fill="var(--background)" stroke="var(--viz-1)"');
    // The filled (high) mark wears the lane hue with a surface ring.
    expect(html).toContain('fill="var(--viz-1)" stroke="var(--background)"');
  });

  it("never renders a verdict word", () => {
    const html = render({ events: [ev({})], predictions: [pred({})], wakeups: [wk({})] });
    expect(html).not.toMatch(/strong buy|strong sell|recommend|buy now|sell now/i);
  });
});
