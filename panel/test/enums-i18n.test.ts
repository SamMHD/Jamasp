import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import fa from "@/messages/fa.json";
import { TONE_FILL, TONE_LABEL_KEY } from "@/components/map-tiles";

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

  /**
   * `Tone` (lib/marketmap.ts) has no runtime existence of its own — it is
   * erased at compile time like every TS type — so this derives the list of
   * real tone values from `TONE_FILL`, map-tiles.tsx's own
   * `Record<Tone, string>` color table, rather than hard-coding
   * "bear"/"bear-mid"/"neutral"/"bull-mid"/"bull" here. `TONE_FILL` is
   * already exhaustive over `Tone` by construction (TypeScript refuses to
   * compile a `Record<Tone, string>` missing a member), so a fifth
   * (currently) or future sixth tone shows up in `Object.keys(TONE_FILL)`
   * automatically — and if `TONE_LABEL_KEY` (map-tiles.tsx's tone -> dict-key
   * map, exhaustive the same way) has not been extended to cover it, the
   * lookup below is `undefined` and the assertion fails, exactly the
   * "a fourth tone added later fails the test" guarantee asked for.
   */
  it("has a dictionary key for every Tone value", () => {
    const missing = (Object.keys(TONE_FILL) as (keyof typeof TONE_FILL)[])
      .filter(tone => !(TONE_LABEL_KEY[tone] in en));
    expect(missing, "tones with no dictionary entry render as raw English")
      .toEqual([]);
  });

  it("translates every tone label into Persian", () => {
    for (const tone of Object.keys(TONE_FILL) as (keyof typeof TONE_FILL)[]) {
      const key = TONE_LABEL_KEY[tone] as keyof typeof fa;
      expect(String(fa[key] ?? "").trim()).not.toBe("");
    }
  });
});
