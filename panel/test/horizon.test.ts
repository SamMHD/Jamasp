import { describe, expect, it } from "vitest";
import { deriveHorizon } from "../lib/horizon";
import type { EventRow, WakeupRow } from "../lib/db";
import type { Prediction } from "../lib/files";

const NOW = new Date("2026-08-11T09:00:00Z");

const ev = (over: Partial<EventRow>): EventRow => ({
  id: "e", source: "ff_calendar", title: "CPI m/m", country: "USD", impact: "High",
  starts_at: "2026-08-12T12:30:00Z", fetched_at: "2026-08-11T00:00:00Z",
  title_fa: null, ...over,
});

const pred = (over: Partial<Prediction>): Prediction => ({
  id: "aaaa0001", date: "2026-08-10", claim: "no settle below 4300", direction: "flat",
  horizon_days: 3, confidence: 0.65, created_at: "2026-08-10T03:00:00Z",
  outcome: null, scored_at: null, note: null, ...over,
});

const wk = (over: Partial<WakeupRow>): WakeupRow => ({
  id: 20, due_at: "2026-08-12T12:45:00Z", run_type: "deepdive", task: "CPI read-through",
  status: "pending", attempts: 0, created_at: "2026-08-07T12:00:00Z", fired_at: null, ...over,
});

describe("deriveHorizon", () => {
  it("merges the three lanes sorted by time", () => {
    const h = deriveHorizon({
      events: [ev({})],
      predictions: [pred({})], // matures 2026-08-13T03:00Z
      wakeups: [wk({})], locale: "en" }, NOW);
    expect(h.entries.map(e => e.lane)).toEqual(["event", "wakeup", "prediction"]);
    expect(h.counts).toEqual({ event: 1, prediction: 1, wakeup: 1 });
    expect(h.start).toBe("2026-08-11T09:00:00Z");
    expect(h.end).toBe("2026-08-18T09:00:00Z");
  });

  it("groups simultaneous same-country same-impact event rows into one entry", () => {
    const h = deriveHorizon({
      events: [
        ev({ id: "1", title: "CPI y/y" }), ev({ id: "2", title: "CPI m/m" }),
        ev({ id: "3", title: "Core CPI m/m" }), ev({ id: "4", title: "Core CPI y/y" }),
      ],
      predictions: [], wakeups: [], locale: "en" }, NOW);
    expect(h.entries).toHaveLength(1);
    // Shortest title (alphabetical among length ties) + fold count.
    expect(h.entries[0].label).toBe("CPI m/m +3");
    expect(h.entries[0].detail).toContain("Core CPI y/y");
    expect(h.entries[0].detail).toContain("USD");
  });

  it("keeps different impacts at the same instant as separate entries", () => {
    const h = deriveHorizon({
      events: [ev({ id: "1", title: "GDP m/m", country: "GBP" }),
        ev({ id: "2", title: "Prelim GDP q/q", country: "GBP", impact: "Medium" })],
      predictions: [], wakeups: [], locale: "en" }, NOW);
    expect(h.entries.map(e => e.impact).sort()).toEqual(["high", "medium"]);
  });

  it("drops Low, Holiday, and null impact events", () => {
    const h = deriveHorizon({
      events: [ev({ impact: "Low" }), ev({ id: "h", impact: "Holiday" }),
        ev({ id: "n", impact: null })],
      predictions: [], wakeups: [], locale: "en" }, NOW);
    expect(h.entries).toEqual([]);
    expect(h.counts.event).toBe(0);
  });

  it("clips events outside the window on both sides", () => {
    const h = deriveHorizon({
      events: [ev({ starts_at: "2026-08-11T08:59:00Z" }),
        ev({ id: "far", starts_at: "2026-08-18T09:00:00Z" })],
      predictions: [], wakeups: [], locale: "en" }, NOW);
    expect(h.entries).toEqual([]);
  });

  it("computes prediction maturity from created_at + horizon_days", () => {
    const h = deriveHorizon({ events: [], predictions: [pred({})], wakeups: [], locale: "en" }, NOW);
    expect(h.entries[0].ts).toBe("2026-08-13T03:00:00Z");
    expect(h.entries[0].confidence).toBe(0.65);
    expect(h.entries[0].label).toBe("aaaa0001");
  });

  it("excludes scored predictions and those maturing outside the window", () => {
    const h = deriveHorizon({
      events: [],
      predictions: [
        pred({ id: "scored", outcome: "hit" }),
        pred({ id: "matured", created_at: "2026-08-07T03:00:00Z" }), // matured 08-10
        pred({ id: "distant", horizon_days: 40 }),
      ],
      wakeups: [], locale: "en" }, NOW);
    // The matured-unscored one belongs to the Forecast panel's amber flag,
    // not this axis — showing it in both would double-count one fact.
    expect(h.entries).toEqual([]);
  });

  it("nulls a malformed confidence rather than fabricating one", () => {
    const h = deriveHorizon({
      events: [],
      predictions: [pred({ confidence: NaN })],
      wakeups: [], locale: "en" }, NOW);
    expect(h.entries[0].confidence).toBeNull();
  });

  it("skips a prediction whose created_at cannot be parsed", () => {
    const h = deriveHorizon({
      events: [], predictions: [pred({ created_at: "not-a-date" })], wakeups: [], locale: "en" }, NOW);
    expect(h.entries).toEqual([]);
  });

  it("keeps past-due pending wakeups, flagged overdue and sorted first", () => {
    const h = deriveHorizon({
      events: [ev({})], predictions: [],
      wakeups: [wk({}), wk({ id: 7, due_at: "2026-08-02T05:00:00Z" })], locale: "en" }, NOW);
    expect(h.entries[0]).toMatchObject({ label: "#7 deepdive", overdue: true });
    expect(h.overdueCount).toBe(1);
    expect(h.counts.wakeup).toBe(2);
  });

  it("ignores non-pending wakeups and those due beyond the window", () => {
    const h = deriveHorizon({
      events: [], predictions: [],
      wakeups: [wk({ status: "done" }), wk({ id: 9, due_at: "2026-09-01T00:00:00Z" })], locale: "en" }, NOW);
    expect(h.entries).toEqual([]);
    expect(h.overdueCount).toBe(0);
  });

  it("returns a fully-stated empty horizon on no input", () => {
    const h = deriveHorizon({ events: [], predictions: [], wakeups: [], locale: "en" }, NOW);
    expect(h.entries).toEqual([]);
    expect(h.counts).toEqual({ event: 0, prediction: 0, wakeup: 0 });
    expect(h.overdueCount).toBe(0);
  });
});

/**
 * The horizon lane built its label and detail from `e.title` alone, so the
 * overview showed English event names unmarked while /calendar and
 * FooterStrip both localized the very same field.
 */
describe("deriveHorizon — event titles by locale", () => {
  const translated = ev({ title: "US CPI (MoM)", title_fa: "شاخص قیمت مصرف‌کننده آمریکا" });

  it("uses the Persian title in Persian, and does not flag a fallback", () => {
    const h = deriveHorizon(
      { events: [translated], predictions: [], wakeups: [], locale: "fa" }, NOW);
    expect(h.entries[0].label).toBe("شاخص قیمت مصرف‌کننده آمریکا");
    expect(h.entries[0].detail).toContain("شاخص قیمت مصرف‌کننده آمریکا");
    expect(h.entries[0].detail).not.toContain("US CPI");
    expect(h.entries[0].fallback).toBe(false);
  });

  it("falls back to English and FLAGS it when there is no Persian title", () => {
    const h = deriveHorizon(
      { events: [ev({ title: "FOMC Statement", title_fa: null })],
        predictions: [], wakeups: [], locale: "fa" }, NOW);
    expect(h.entries[0].label).toBe("FOMC Statement");
    expect(h.entries[0].fallback).toBe(true);
  });

  it("keeps English untouched and unflagged in the English locale", () => {
    const h = deriveHorizon(
      { events: [translated], predictions: [], wakeups: [], locale: "en" }, NOW);
    expect(h.entries[0].label).toBe("US CPI (MoM)");
    expect(h.entries[0].fallback).toBe(false);
  });

  it("flags a group as fallback when ANY of its titles is untranslated", () => {
    // Simultaneous rows at one instant group into one mark. If even one is
    // still English, the mark's text is partly English and must say so.
    const h = deriveHorizon({
      events: [
        ev({ id: "a", title: "US CPI (MoM)", title_fa: "شاخص ماهانه" }),
        ev({ id: "b", title: "US CPI (YoY)", title_fa: null }),
      ],
      predictions: [], wakeups: [], locale: "fa",
    }, NOW);
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0].fallback).toBe(true);
    expect(h.entries[0].detail).toContain("شاخص ماهانه");
    expect(h.entries[0].detail).toContain("US CPI (YoY)");
  });

  it("leaves the other two lanes' text alone", () => {
    // Wakeup tasks and prediction claims have their own sidecars and are not
    // this function's business — it must not invent a fallback flag for them.
    const h = deriveHorizon(
      { events: [], predictions: [pred({})], wakeups: [wk({})], locale: "fa" }, NOW);
    for (const e of h.entries) expect(e.fallback).toBe(false);
  });
});
