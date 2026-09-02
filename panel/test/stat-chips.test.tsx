import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatChips, type Chip } from "@/components/shell/stat-chips";

const CHIPS: Chip[] = [
  { label: "ingest", value: "4m", tone: "ok", href: "/crawl" },
  { label: "runs", value: "3/8", href: "/schedule" },
  { label: "errors 24h", value: "2", tone: "warn", href: "/crawl" },
];

const html = () => renderToStaticMarkup(<StatChips chips={CHIPS} />);

describe("StatChips", () => {
  it("shows every chip's label and value", () => {
    const out = html();
    for (const c of CHIPS) {
      expect(out).toContain(c.label);
      expect(out).toContain(c.value);
    }
  });

  it("links a chip that has an href", () => {
    expect(html()).toContain('href="/crawl"');
  });

  // Tone is a colour; the label and value carry the meaning regardless, so a
  // toneless chip must render identically apart from ink.
  it("renders a chip with no tone", () => {
    const out = renderToStaticMarkup(<StatChips chips={[{ label: "runs", value: "3/8" }]} />);
    expect(out).toContain("runs");
    expect(out).toContain("3/8");
  });

  it("gives every chip a 44px minimum target when it links", () => {
    expect(html()).toContain("min-h-11");
  });

  it("renders nothing for an empty list", () => {
    expect(renderToStaticMarkup(<StatChips chips={[]} />)).toBe("");
  });
});
