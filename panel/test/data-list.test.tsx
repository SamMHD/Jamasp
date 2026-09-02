import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataList, type Column } from "@/components/ui/data-list";

type Row = { id: string; source: string; state: string };

const ROWS: Row[] = [
  { id: "a", source: "cnbc_finance", state: "ok" },
  { id: "b", source: "reuters_metals", state: "stale" },
];

const COLUMNS: Column<Row>[] = [
  { key: "source", header: "Source", cell: r => r.source },
  { key: "state", header: "State", cell: r => r.state },
];

const render = (rows: Row[]) => renderToStaticMarkup(
  <DataList columns={COLUMNS} rows={rows} rowKey={r => r.id} empty="none in 24h" />);

describe("DataList", () => {
  it("renders a real table for wide containers", () => {
    const html = render(ROWS);
    expect(html).toContain("<table");
    expect(html).toContain("Source");
  });

  it("renders every row's cells", () => {
    const html = render(ROWS);
    expect(html).toContain("cnbc_finance");
    expect(html).toContain("reuters_metals");
  });

  // The narrow rendering repeats the header as a label per cell, which is
  // what makes a stacked row readable without a header row above it.
  it("labels each cell in the stacked rendering", () => {
    const html = render(ROWS);
    expect(html.match(/Source/g)!.length).toBeGreaterThan(1);
  });

  // Both renderings are in the DOM at once; only one is visible. Without
  // aria-hidden a screen reader would read every row twice.
  it("hides one rendering from assistive technology", () => {
    expect(render(ROWS)).toContain('aria-hidden="true"');
  });

  it("switches on the container, not the viewport", () => {
    const html = render(ROWS);
    expect(html).toContain("@md:");
  });

  it("shows the empty text once when there are no rows", () => {
    const html = render([]);
    expect(html).toContain("none in 24h");
    expect(html).not.toContain("<table");
  });
});
