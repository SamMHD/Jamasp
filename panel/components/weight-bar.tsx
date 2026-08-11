import type { StanceWeight } from "@/lib/stance";
import { cls } from "@/lib/format";

/**
 * The stance's scenario split as a stacked probability bar.
 *
 * Categorical hues are the validated --viz-1..3 trio, assigned by position
 * in the triplet (the stance format is a stable three-scenario shape) —
 * never cycled or generated. The legend row beneath repeats every label
 * and value as plain text, so identity and value are never colour-alone;
 * that same row is the relief channel for --viz-3's sub-3:1 light-mode
 * contrast (a validator WARN, discharged by visible labels).
 *
 * Segments are separated by a 2px gap in the surface colour (the flex
 * gap), not by strokes. Should the parser ever hand this more scenarios
 * than there are validated slots, the bar is not drawn at all — a 4th hue
 * would break the palette's checks — and the text legend alone carries
 * the split. Weights that fail to sum positive likewise get no bar: the
 * widths would be fabrication.
 */
export const SLOT_VARS = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)"] as const;

export function WeightBar({ weights }: { weights: StanceWeight[] }) {
  if (weights.length === 0) return null;
  const sum = weights.reduce((n, w) => n + w.pct, 0);
  const drawable = weights.length <= SLOT_VARS.length && sum > 0
    && weights.every(w => w.pct >= 0);
  return (
    <div>
      {drawable && (
        <div className="flex h-2.5 w-full gap-0.5" role="img"
          aria-label={`scenario weights: ${weights.map(w => `${w.label} ${w.pct}%`).join(", ")}`}>
          {weights.map((w, i) => (
            <span key={w.label}
              className={cls("h-full",
                i === 0 && "rounded-l-full",
                i === weights.length - 1 && "rounded-r-full")}
              style={{ width: `${(w.pct / sum) * 100}%`, background: SLOT_VARS[i] }} />
          ))}
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {weights.map((w, i) => (
          <span key={w.label} className="flex items-baseline gap-1.5 tabular-nums">
            {drawable && (
              <span aria-hidden className="h-2 w-2 shrink-0 self-center rounded-[3px]"
                style={{ background: SLOT_VARS[i] }} />
            )}
            <span>{w.label} {w.pct}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}
