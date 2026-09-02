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
