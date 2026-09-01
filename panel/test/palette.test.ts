import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkInks, checkSeries, parseTokens, type Theme } from "@/lib/palette";

const css = readFileSync(path.join(import.meta.dirname, "../app/globals.css"), "utf8");
const T = parseTokens(css);

const DARK: Theme = {
  name: "dark",
  surfaces: { field: T["dk-background"], panel: T["dk-card"], raised: T["dk-secondary"] },
  inks: {
    foreground: T["dk-foreground"], muted: T["dk-muted-foreground"],
    dim: T["dk-ink-dim"], gold: T["dk-primary"], up: T["dk-up"], down: T["dk-down"],
  },
};
const LIGHT: Theme = {
  name: "light",
  surfaces: { field: T["background"], panel: T["card"], inset: T["secondary"] },
  inks: {
    foreground: T["foreground"], muted: T["muted-foreground"],
    dim: T["ink-dim"], gold: T["primary"], up: T["up"], down: T["down"],
  },
};

describe("token extraction", () => {
  it("finds every token both themes need", () => {
    for (const theme of [DARK, LIGHT]) {
      for (const [k, v] of Object.entries({ ...theme.surfaces, ...theme.inks })) {
        expect(v, `${theme.name}.${k} is missing from globals.css`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});

describe.each([DARK, LIGHT])("$name theme", theme => {
  // The cross-product, not a representative pair. Checking inks against the
  // panel alone is what let three sub-floor values through spec review.
  it("clears 4.5:1 for every ink on every surface", () => {
    const failures = checkInks(theme).filter(f => !f.ok);
    expect(failures.map(f => `${f.label} ${f.measured.toFixed(2)}:1`)).toEqual([]);
  });
});

describe("categorical series", () => {
  it("separates --viz-1..3 on the dark panel under every CVD type", () => {
    const failures = checkSeries(
      [T["dk-viz-1"], T["dk-viz-2"], T["dk-viz-3"]], DARK.surfaces.panel,
    ).filter(f => !f.ok);
    expect(failures.map(f => `${f.label} dE ${f.measured.toFixed(1)}`)).toEqual([]);
  });
  it("separates --viz-1..3 on the light panel under every CVD type", () => {
    const failures = checkSeries(
      [T["viz-1"], T["viz-2"], T["viz-3"]], LIGHT.surfaces.panel,
    ).filter(f => !f.ok);
    expect(failures.map(f => `${f.label} dE ${f.measured.toFixed(1)}`)).toEqual([]);
  });
});
