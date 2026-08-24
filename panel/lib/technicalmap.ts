/**
 * Technical market map: encoding and layout.
 *
 * Pure, like lib/marketmap.ts — the page does the database read and passes
 * rows in.
 *
 * Two things differ from the fundamental map, and both are deliberate.
 *
 * AREA is the learned multiplier ALONE. There is no tier for a signal. That
 * is what makes the Bourse analogy exact: there, market cap is stable and
 * sets the shape while the day's move sets the colour. Here the multiplier —
 * how much a signal has historically mattered — sets the shape, and the
 * current state sets the colour. A consequence worth stating: this map's
 * shape barely changes between refreshes. That is correct, not stale.
 *
 * COLOUR is the signal's state, already a single number in [-1, +1], mapped
 * onto the same five-step ramp with the same mandatory hatch on BOTH bearish
 * tones.
 *
 * Before the first fit every multiplier is 1.0, so the map reads as a uniform
 * grid. Honest, but it looks odd — which is why unfitted tiles are drawn with
 * a dashed outline rather than silently rendering as a measurement.
 *
 * `fitted` and `pinned` are two different claims and must stay that way.
 * `fitted` means the regression measured this column — it comes straight off
 * jamasp/fit.py's under-observed check and never changes because of a pin.
 * `pinned` means a human overrode it via config/weights.yaml's `pins:` block.
 * A pin applies whether or not its column was ever fitted — a retro reaches
 * for a pin exactly for the columns short of min_observations, or with no
 * stories yet, so gating it on `fitted` would discard it for precisely the
 * cases it exists to fix. A tile is solid (not dashed) when EITHER is true:
 * fitted means "measured", pinned means "a human's deliberate number", and
 * dashed is reserved for the third case — 1.0 for want of either.
 */
import {
  layoutGroups, type GroupBox, type Rect,
} from "@/lib/marketmap";

export type SignalState = { key: string; ts: string; value: number };

export type SignalSpecConfig = {
  name: string; family: string; timeframes: string[];
};

export type WeightsConfig = {
  themes: string[];
  signals: SignalSpecConfig[];
};

export type FittedCoefficient = {
  beta: number; se: number; multiplier: number;
  observations: number; fitted: boolean; pinned: boolean;
};

export type FittedWeights = {
  fittedAt: string;
  fits: Record<string, {
    n: number; horizonHours: number; flags: string[];
    coefficients: Record<string, FittedCoefficient>;
  }>;
};

export type SignalTile = {
  key: string; signal: string; timeframe: string; family: string;
  state: number; ts: string; multiplier: number; fitted: boolean; pinned: boolean;
};

/** What every tile weighs before anything has been learned. */
export const NEUTRAL_MULTIPLIER = 1;

export function buildSignalTiles(
  states: SignalState[],
  specs: SignalSpecConfig[],
  weights: FittedWeights | null,
): SignalTile[] {
  const family = new Map<string, string>();
  for (const s of specs) {
    for (const tf of s.timeframes) family.set(`${s.name}@${tf}`, s.family);
  }
  const coefficients = weights?.fits?.technical?.coefficients ?? {};

  const out: SignalTile[] = [];
  for (const st of states) {
    const fam = family.get(st.key);
    // A stale row from a signal that has since been removed from the
    // taxonomy has no family to sit in; drawing it would invent a group.
    if (!fam) continue;
    const [signal, timeframe] = st.key.split("@");
    const c = coefficients[st.key];
    const fitted = c?.fitted === true;
    const pinned = c?.pinned === true;
    out.push({
      key: st.key, signal, timeframe, family: fam,
      state: st.value, ts: st.ts,
      // An unfitted, unpinned column weighs neutral whatever number happens
      // to sit in the file: a coefficient from three observations is not a
      // measurement, and sizing a tile by it would render confidence nobody
      // earned. A pin is not a measurement either, but it IS a deliberate
      // number a human chose — honouring it is the entire point of a pin,
      // so it must survive even when `fitted` is false.
      multiplier: fitted || pinned ? c!.multiplier : NEUTRAL_MULTIPLIER,
      fitted,
      pinned,
    });
  }
  return out;
}

export function layoutSignalMap(
  tiles: SignalTile[], rect: Rect, headerHeight: number,
): GroupBox<SignalTile>[] {
  return layoutGroups(
    tiles.map(t => ({ group: t.family, value: t.multiplier, node: t })),
    rect, headerHeight);
}
