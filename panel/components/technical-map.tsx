import { fmtAge } from "@/lib/format";
import { toneFromIntensity } from "@/lib/marketmap";
import { layoutSignalMap, type SignalTile } from "@/lib/technicalmap";
import {
  MapHatchDefs, MapLegend, MapTile, LABEL_PAD, MIN_LABEL_H, MIN_LABEL_W,
  truncateForWidth, wrapForTile,
} from "@/components/map-tiles";
import { FullscreenButton } from "@/components/fullscreen-button";

/**
 * Technical market map: a two-level treemap of signal states, drawn as
 * server-rendered inline SVG for the same reasons as the fundamental map.
 *
 * AREA is the learned multiplier and nothing else — there is no tier for a
 * signal. So this map's shape barely changes between refreshes, which is
 * correct rather than stale: the multiplier says how much a signal has
 * historically mattered, and only the colour is today's read.
 *
 * COLOUR is the state itself, already in [-1, +1], on the same five-step
 * ramp as the fundamental map, with the same mandatory hatch on BOTH bearish
 * tones. See components/map-tiles.tsx for why both, and why the hatch is a
 * required second encoding rather than decoration.
 *
 * The confidence treatment finally does real work here: fitted weights render
 * solid, weights still at 1.0 for want of a sample render dashed. On day one
 * the map is largely solid, since Fit A learns from five years of backfill.
 *
 * A PINNED tile also renders solid, whether or not it was ever fitted. Solid
 * means "measured", dashed means "1.0 for want of a sample" — a pin is
 * neither of those, it is a human's deliberate override, and the value
 * behind it is exactly as real as a fitted one. Dashing it would say "no
 * confidence," which is the opposite of what a pin means; leaving it
 * visually identical to a genuinely fitted tile is the honest call, since
 * both cases share the property the dashed/solid split exists to signal —
 * "trust this number" — even though they arrive at it differently. The
 * hover title (below) still says PINNED for anyone who wants the detail.
 */

const FAMILY_HEADER_H = 20;
const HEADER_FONT = 9;

export const TECHNICAL_MAP_ELEMENT_ID = "technical-map";

const FAMILY_LABELS: Record<string, string> = {
  trend: "Trend",
  momentum: "Momentum",
  levels: "Levels",
  volatility: "Volatility",
  positioning: "Positioning",
};

/** Unrecognised slugs degrade to a readable label rather than crashing. */
function familyLabel(family: string): string {
  return FAMILY_LABELS[family] ??
    family.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function tileTitle(t: SignalTile, now: Date): string {
  const read = t.state > 0.15 ? "bullish" : t.state < -0.15 ? "bearish" : "neutral";
  // A pin overrides the fitted value outright (jamasp/fit.py's run_fit
  // applies it regardless of `fitted`), so it takes priority here too.
  const weight = t.pinned ? `weight ${t.multiplier.toFixed(2)} (pinned)`
    : t.fitted ? `weight ${t.multiplier.toFixed(2)}`
    : `weight ${t.multiplier.toFixed(2)} (not yet fitted)`;
  // Provenance is named only when it is NOT our own bars. A state computed
  // from our bars is the normal path and the one the TradingView oracle test
  // cross-checks; a state read straight off TradingView is a real reading
  // taken from somewhere else, and the desk should be able to see that on
  // the tile rather than having to know which host has bars.
  const via = t.source === "tradingview" ? ", via TradingView" : "";
  return `${t.signal} ${t.timeframe} — ${read} ${t.state.toFixed(2)}, `
    + `${weight}${via}, ${fmtAge(t.ts, now)}`;
}

export function TechnicalMap({ tiles, width, height, fittedAt }: {
  tiles: SignalTile[];
  width: number;
  height: number;
  fittedAt: string | null;
}) {
  const now = new Date();

  if (tiles.length === 0) {
    return (
      <section aria-label="Technical signal treemap"
        className="rounded border border-border p-4">
        <p className="text-sm text-muted-foreground">
          No technical signals yet — run <code>jamasp bars backfill</code> and{" "}
          <code>jamasp signals refresh</code>.
        </p>
      </section>
    );
  }

  const boxes = layoutSignalMap(
    tiles, { x: 0, y: 0, w: width, h: height }, FAMILY_HEADER_H);
  // Dashed (and counted here as "not yet fitted") means neither measured nor
  // pinned. A pinned-but-unfitted tile is neither of the two things solid
  // usually means, but it IS a deliberate number a human stands behind, so
  // it renders solid — see the module comment above.
  const unfitted = tiles.filter(t => !t.fitted && !t.pinned).length;

  return (
    <section id={TECHNICAL_MAP_ELEMENT_ID} aria-label="Technical signal treemap"
      className="rounded border border-border p-4 bg-background">
      <div className="mb-2 flex items-center justify-end">
        <FullscreenButton targetId={TECHNICAL_MAP_ELEMENT_ID} />
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img"
        aria-label={`technical signal treemap, ${tiles.length} signals`}>
        <MapHatchDefs />
        {boxes.map(box => (
          <g key={box.group}>
            <text x={box.x + LABEL_PAD} y={box.y + 13} fontSize={HEADER_FONT}
              fill="var(--muted-foreground)"
              style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>
              {truncateForWidth(familyLabel(box.group), box.w, HEADER_FONT)}
            </text>
            {box.items.map(cell => {
              const showLabel = cell.w >= MIN_LABEL_W && cell.h >= MIN_LABEL_H;
              return (
                <MapTile key={cell.node.key}
                  x={cell.x} y={cell.y} w={cell.w} h={cell.h}
                  tone={toneFromIntensity(cell.node.state)}
                  title={tileTitle(cell.node, now)}
                  dashed={!cell.node.fitted && !cell.node.pinned}
                  lines={showLabel
                    ? wrapForTile(
                        `${cell.node.signal} ${cell.node.timeframe}`,
                        cell.w, cell.h)
                    : []} />
              );
            })}
          </g>
        ))}
      </svg>
      <MapLegend />
      <p className="mt-2 text-xs text-muted-foreground">
        {tiles.length} signals
        {unfitted > 0 ? ` · ${unfitted} not yet fitted (dashed)` : ""}
        {fittedAt ? ` · weights fitted ${fmtAge(fittedAt, now)}` : " · no fit yet"}
      </p>
    </section>
  );
}
