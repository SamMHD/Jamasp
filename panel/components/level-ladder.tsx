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

const KIND_STYLE: Record<Level["kind"], string> = {
  ma: "border-t border-border",
  pivot: "border-t border-dotted border-border",
  spot: "border-t-2 border-primary",
};

function fmt(v: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export function LevelLadder({ levels }: { levels: Level[] }) {
  if (levels.length === 0) {
    return <p className="text-sm text-muted-foreground">no levels available</p>;
  }
  const gaps = ladderGaps(levels.map(l => l.value));
  return (
    <ol className="tabular-nums">
      {levels.map((l, i) => (
        <li key={l.label}
          style={i === 0 ? undefined : { marginTop: `${gaps[i - 1]}px` }}
          className={cls(
            "flex items-center gap-3 text-sm",
            l.kind === "spot" ? "font-semibold text-foreground" : "text-muted-foreground",
          )}>
          <span className="w-20 text-right">{fmt(l.value)}</span>
          <span className={cls("flex-1", KIND_STYLE[l.kind])} aria-hidden />
          <span className="w-24">{l.label}</span>
        </li>
      ))}
    </ol>
  );
}
