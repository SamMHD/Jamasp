import { contrast, deltaE2000, labOf, simulateCvd, type CvdKind } from "@/lib/color";

export type Theme = {
  name: "light" | "dark";
  surfaces: Record<string, string>;
  inks: Record<string, string>;
};
export type Finding = { ok: boolean; label: string; measured: number; floor: number };

/** Body-text floor. Large/bold text may use 3:1, but nothing in these token
 *  sets is large-only, so the whole cross-product is held to 4.5:1. */
export const INK_FLOOR = 4.5;
/** Adjacent categorical marks must stay distinguishable under CVD. 6.0 is the
 *  bottom of the 6–8 band that is legal only alongside a secondary encoding;
 *  below 6.0 no secondary encoding rescues it. */
export const SERIES_FLOOR = 6.0;

const CVDS: CvdKind[] = ["protan", "deutan", "tritan"];

/** Pulls `--name: #hex;` declarations out of the stylesheet. Non-hex values
 *  (oklch, var() aliases, percentages) are skipped rather than guessed at —
 *  a token the validator cannot read must fail loudly in the test that looks
 *  it up, not silently pass here.
 *
 *  Only 3- and 6-digit (fully opaque) hex forms are accepted. hexToRgb only
 *  ever reads the first six hex digits, so a 4-digit (#rgba) or 8-digit
 *  (#rrggbbaa) token would silently be treated as fully opaque and validated
 *  for a contrast nobody actually sees once the alpha channel is composited
 *  over whatever sits behind it. The base commit's `--border` really was
 *  `oklch(1 0 0 / 10%)` before this branch, so alpha tokens are not a
 *  hypothetical here — an alpha hex form throws instead of being silently
 *  truncated into a false pass. */
export function parseTokens(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    const [, name, hex] = m;
    const digits = hex.length - 1;
    if (digits !== 3 && digits !== 6) {
      throw new Error(
        `parseTokens: --${name}: ${hex} is a ${digits}-digit hex value with an ` +
        "alpha channel, which hexToRgb cannot measure correctly (it reads only " +
        "the first six digits). Use a 3- or 6-digit opaque hex, or express the " +
        "alpha as a separate, non-colour token."
      );
    }
    out[name] = hex.toLowerCase();
  }
  return out;
}

export function checkInks(theme: Theme): Finding[] {
  const out: Finding[] = [];
  for (const [inkName, ink] of Object.entries(theme.inks)) {
    for (const [surfName, surf] of Object.entries(theme.surfaces)) {
      const measured = contrast(ink, surf);
      out.push({
        ok: measured >= INK_FLOOR,
        label: `${theme.name}: ${inkName} on ${surfName}`,
        measured, floor: INK_FLOOR,
      });
    }
  }
  return out;
}

/** Every unordered pair, under normal vision and each CVD type. `surface` is
 *  accepted so callers record which ground the reading applies to; the
 *  separation itself is mark-to-mark. */
export function checkSeries(hexes: string[], surface: string): Finding[] {
  const out: Finding[] = [];
  for (let i = 0; i < hexes.length; i++) {
    for (let j = i + 1; j < hexes.length; j++) {
      const pairs: [string, string, string][] = [["normal", hexes[i], hexes[j]]];
      for (const c of CVDS) pairs.push([c, simulateCvd(hexes[i], c), simulateCvd(hexes[j], c)]);
      for (const [kind, a, b] of pairs) {
        const measured = deltaE2000(labOf(a), labOf(b));
        out.push({
          ok: measured >= SERIES_FLOOR,
          label: `${hexes[i]}/${hexes[j]} under ${kind} on ${surface}`,
          measured, floor: SERIES_FLOOR,
        });
      }
    }
  }
  return out;
}
