import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SeriesTable } from "../components/series-table";
import type { PricePoint } from "../lib/db";

const pt = (ts: string, value: number): PricePoint => ({ ts, value });

const SERIES = [
  pt("2026-08-01T00:00:00Z", 4300),
  pt("2026-08-05T00:00:00Z", 4350),
  pt("2026-08-10T00:00:00Z", 4383.7),
];

describe("SeriesTable", () => {
  it("keeps every stored value reachable without hover", () => {
    const html = renderToStaticMarkup(<SeriesTable points={SERIES} />);
    expect(html).toContain("view as table");
    expect(html).toContain("4,383.7");
    expect(html).toContain("Aug 10 00:00Z");
  });

  it("renders nothing at all with no points", () => {
    // An empty disclosure inviting a click onto an empty table is worse than
    // silence — and the technical panel hands it an empty series whenever
    // the GC feed has no rows.
    expect(renderToStaticMarkup(<SeriesTable points={[]} />)).toBe("");
  });

  it("takes a caller-supplied summary label", () => {
    const html = renderToStaticMarkup(
      <SeriesTable points={SERIES} label="view Jamasp’s stored readings as table" />);
    expect(html).toContain("view Jamasp");
    expect(html).toContain("stored readings as table");
  });
});
