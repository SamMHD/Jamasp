import type { Level } from "@/lib/technicals";
import { cls } from "@/lib/format";

/**
 * Vertical spacing between consecutive ladder rows, proportional to the
 * price gap between them and clamped to [min, max].
 *
 * Spacing the gaps rather than absolutely positioning each row keeps the
 * ladder readable when two levels nearly coincide — absolute positioning
 * would overlap the labels. Distance is conveyed, exact scale is not.
 */
export function ladderGaps(values: number[], opts?: { min?: number; max?: number }): number[] {
  const min = opts?.min ?? 8;
  const max = opts?.max ?? 48;
  if (values.length < 2) return [];
  const diffs = values.slice(0, -1).map((v, i) => Math.abs(v - values[i + 1]));
  const widest = Math.max(...diffs);
  if (widest === 0) return diffs.map(() => min);
  return diffs.map(d => min + (max - min) * (d / widest));
}

function fmt(v: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/**
 * The level map as a price rail: a vertical axis line with a tick per
 * stored level and a gold dot where spot sits. Above/below is carried by
 * sorted position (levels arrive descending); MA ticks are longer than
 * pivot ticks, and the label disambiguates regardless, so the encoding is
 * never colour- or length-alone. The dot is the only coloured mark — text
 * stays in text tokens.
 */
export function LevelLadder({ levels }: { levels: Level[] }) {
  if (levels.length === 0) {
    return <p className="text-sm text-muted-foreground">no levels available</p>;
  }
  const gaps = ladderGaps(levels.map(l => l.value));
  return (
    <ol className="relative ml-1 border-l-2 border-border py-1 pl-5 tabular-nums">
      {levels.map((l, i) => (
        <li key={l.label}
          style={i === 0 ? undefined : { marginTop: `${gaps[i - 1]}px` }}
          className={cls(
            "relative flex items-baseline gap-2 text-sm",
            l.kind === "spot" ? "font-semibold text-foreground" : "text-muted-foreground",
          )}>
          {l.kind === "spot" ? (
            <span aria-hidden
              className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-background"
              style={{ left: "-27px", background: "var(--viz-spot)" }} />
          ) : (
            <span aria-hidden
              className={cls("absolute top-1/2 h-px -translate-y-1/2 bg-border",
                l.kind === "ma" ? "w-3.5" : "w-2.5")}
              style={{ left: "-22px" }} />
          )}
          <span className="w-16 shrink-0 text-right">{fmt(l.value)}</span>
          <span className="text-xs">{l.label}</span>
        </li>
      ))}
    </ol>
  );
}
