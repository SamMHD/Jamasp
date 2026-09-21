import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import fa from "@/messages/fa.json";

/**
 * Every theme in weights.yaml must have a label in both dictionaries.
 *
 * The brief this test started from sketched `themes:` as a YAML mapping
 * ("  key: value"), but the real config is a YAML sequence:
 *
 *   themes:
 *     - rates_dollar
 *     - geopolitics
 *     ...
 *
 * so the parser below matches "  - slug" list items, not "  slug:" map
 * entries. Fixed against the actual file rather than loosening the
 * assertion to match a parser that would otherwise silently find nothing.
 */
function themesFromConfig(): string[] {
  const yaml = fs.readFileSync(
    path.join(import.meta.dirname, "..", "..", "config", "weights.yaml"), "utf8");
  const themes: string[] = [];
  let inThemes = false;
  for (const line of yaml.split("\n")) {
    if (/^themes:/.test(line)) { inThemes = true; continue; }
    // Any subsequent top-level line (no leading whitespace — including a
    // comment introducing the next section) ends the themes block.
    if (inThemes && /^\S/.test(line)) break;
    const m = /^\s*-\s*([a-z_]+)\s*$/.exec(line);
    if (inThemes && m) themes.push(m[1]);
  }
  return themes;
}

describe("fixed enums are chrome", () => {
  it("has a label for every theme in weights.yaml", () => {
    const missing = themesFromConfig().filter(k => !(`theme.${k}` in en));
    expect(missing, "themes with no dictionary entry render as raw slugs")
      .toEqual([]);
  });

  it("translates every theme label into Persian", () => {
    for (const k of themesFromConfig()) {
      expect(String(fa[`theme.${k}` as keyof typeof fa] ?? "").trim()).not.toBe("");
    }
  });

  it("keeps ticker-like enum values Latin in Persian", () => {
    // Signal names carry tickers and periods (rsi14@1d, DXY). Those are
    // identifiers a desk reads as-is; translating them is a regression.
    for (const [k, v] of Object.entries(fa)) {
      if (k.startsWith("signal.")) {
        expect(String(v)).not.toMatch(/[۰-۹]/);
      }
    }
  });
});
