import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Panel } from "@/components/ui/panel";

describe("Panel", () => {
  it("renders its children", () => {
    expect(renderToStaticMarkup(<Panel>body text</Panel>)).toContain("body text");
  });

  it("renders a title and an action side by side", () => {
    const html = renderToStaticMarkup(
      <Panel title="Drivers" action={<button>refresh</button>}>rows</Panel>);
    expect(html).toContain("Drivers");
    expect(html).toContain("refresh");
  });

  // The empty slot replaces children entirely — rendering both would show a
  // "no data" note above a populated body.
  it("renders the empty slot instead of children when supplied", () => {
    const html = renderToStaticMarkup(
      <Panel empty="no price data yet">should not appear</Panel>);
    expect(html).toContain("no price data yet");
    expect(html).not.toContain("should not appear");
  });

  it("still renders the title alongside an empty slot", () => {
    const html = renderToStaticMarkup(<Panel title="Prices" empty="nothing yet">x</Panel>);
    expect(html).toContain("Prices");
    expect(html).toContain("nothing yet");
  });

  // Guard audit: `empty !== undefined` treated `empty={false}` and
  // `empty={null}` as "supplied", rendering an empty <p> and hiding the
  // children — exactly what an idiomatic `empty={rows.length === 0 && "..."}`
  // passes when rows.length is 0. `empty != null && empty !== false` is the
  // fix; both falsy-but-not-empty-string forms must fall through to children.
  it("renders children, not an empty paragraph, when empty is false", () => {
    const html = renderToStaticMarkup(<Panel empty={false}>real content</Panel>);
    expect(html).toContain("real content");
  });

  it("renders children, not an empty paragraph, when empty is null", () => {
    const html = renderToStaticMarkup(<Panel empty={null}>real content</Panel>);
    expect(html).toContain("real content");
  });

  // Tone must not rest on colour alone; it sets role=status so the state is
  // announced, and the caller supplies the words.
  it("marks a warn tone as a status region", () => {
    expect(renderToStaticMarkup(<Panel tone="warn">stale</Panel>)).toContain('role="status"');
  });

  it("leaves a default panel without a status role", () => {
    expect(renderToStaticMarkup(<Panel>plain</Panel>)).not.toContain('role="status"');
  });

  it("appends caller classes rather than replacing its own", () => {
    const html = renderToStaticMarkup(<Panel className="mt-4">x</Panel>);
    expect(html).toContain("mt-4");
    expect(html).toContain("rounded-lg");
  });
});
