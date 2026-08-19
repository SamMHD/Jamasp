/**
 * Fundamental market map: encoding and layout.
 *
 * Pure, like lib/technicals.ts and lib/newsflow.ts — the page does the
 * database read and passes rows in.
 *
 * Two channels carry two different things, deliberately. AREA is materiality
 * (the triage call's tier), so the map's shape answers "what is big today".
 * COLOUR is direction scaled by conviction, so a story that plainly matters
 * but cannot be called comes out large and grey rather than fading away —
 * the desk should see that it matters and is unresolved.
 */

export type ScoredItem = {
  itemId: string;
  tier: number;
  direction: number;   // -2..+2, gold-relative
  conviction: number;  // 0..1
  theme: string;
  headline: string;
  source: string;
  url: string;
  publishedAt: string;
};

/**
 * Tier -> area weight. Mirrors config/weights.yaml's tier_weight, which the
 * later fit also reads; if that file's values change, change these with it.
 */
export const TIER_WEIGHT: Record<number, number> = {
  5: 100, 4: 60, 3: 30, 2: 10, 1: 3,
};

const MIN_WEIGHT = 3;

export function tierWeight(tier: number): number {
  return TIER_WEIGHT[tier] ?? MIN_WEIGHT;
}

export type Tone = "bull" | "bull-mid" | "neutral" | "bear-mid" | "bear";

/** Below this the read is treated as no call at all. */
const NEUTRAL_BAND = 0.15;
/** At or above this the arm reaches its pole. */
const POLE_BAND = 0.55;

/**
 * Signed intensity s = (direction / 2) * conviction, in [-1, +1], mapped onto
 * the five-step diverging ramp.
 *
 * Conviction multiplies rather than gates: direction says which way, and
 * conviction says how far along that arm to travel. A confident +1 and a
 * hesitant +2 can legitimately land on the same step.
 */
export function tone(direction: number, conviction: number): Tone {
  const s = (direction / 2) * conviction;
  const a = Math.abs(s);
  if (a < NEUTRAL_BAND) return "neutral";
  if (a < POLE_BAND) return s < 0 ? "bear-mid" : "bull-mid";
  return s < 0 ? "bear" : "bull";
}
