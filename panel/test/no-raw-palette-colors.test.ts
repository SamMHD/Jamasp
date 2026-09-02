import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A2: five files reached past the validated colour tokens to raw Tailwind
 * palette classes (`text-emerald-400`, `bg-amber-400`, ...) with no `dark:`
 * counterpart, so they rendered identically — and unreadably — in light
 * mode. Raw palette colours have no light variant in this codebase; only
 * the tokens in app/globals.css (`--up`, `--primary`, `--destructive`, ...)
 * are validated against both themes by lib/palette.ts + test/palette.test.ts.
 * A class that bypasses the tokens silently fails the contrast floor the
 * moment the theme flips, with nothing else in the suite positioned to catch
 * it — hence this direct source scan.
 *
 * Scoped to exactly the five files the A2 fix touched, not the whole tree:
 * other files (app/page.tsx, components/quote-tile.tsx, etc.) still carry
 * raw palette colours deliberately left for later phases — see the panel
 * design-system plan — and a whole-tree scan would fail on those without
 * fixing pages this task was told not to touch.
 */
const FIXED_FILES = [
  "components/status-strip.tsx",
  "components/stat-card.tsx",
  "components/schedule-forms.tsx",
  "app/alerts/page.tsx",
  "app/error.tsx",
];

// Every Tailwind v4 default palette family that ships a numeric weight ramp.
// (`black`/`white`/`transparent`/`current` have no numeric weight and are
// not colour-token bypasses in the same sense, so they're excluded.)
const PALETTE_FAMILIES = [
  "slate", "gray", "zinc", "neutral", "stone",
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal",
  "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
];

const RAW_PALETTE_CLASS = new RegExp(
  `\\b(?:text|bg|border)-(?:${PALETTE_FAMILIES.join("|")})-\\d{2,3}\\b`,
);

describe("A2: no raw Tailwind palette colours in the fixed files", () => {
  it.each(FIXED_FILES)("%s uses only design tokens for colour", file => {
    const src = readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
    const matches = src.match(new RegExp(RAW_PALETTE_CLASS, "g")) ?? [];
    expect(matches, `${file} still reaches past the tokens: ${matches.join(", ")}`).toEqual([]);
  });
});
