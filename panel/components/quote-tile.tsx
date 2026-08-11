import { Sparkline } from "@/components/sparkline";
import type { PricePoint } from "@/lib/db";
import { cls, fmtAge } from "@/lib/format";

function num(v: number, digits: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: digits });
}

/**
 * Signed change annotation. Four distinct states, matching the technical
 * hero's discipline: null means "no honest reference exists" and renders
 * as "<label> —" — never as a green zero, which would assert flatness the
 * data cannot support.
 *
 * tone="direction" colours a move by its direction (market-screen
 * convention: direction of change, not advice). tone="neutral" keeps the
 * ink plain — used where colour could read as judgement, e.g. speculative
 * positioning, where "more crowded" is a fact and not a good or bad one.
 */
export function Delta({ delta, digits = 2, label = "24h", tone = "direction" }: {
  delta: number | null; digits?: number; label?: string; tone?: "direction" | "neutral";
}) {
  if (delta === null) {
    return <span className="text-muted-foreground">{label} —</span>;
  }
  const dir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const mark = dir === "up" ? "▲" : dir === "down" ? "▼" : "=";
  const toneCls =
    dir === "flat" ? "text-muted-foreground"
    : tone === "neutral" ? "text-foreground"
    : dir === "up" ? "text-emerald-700 dark:text-emerald-400"
    : "text-destructive";
  return (
    <span className="tabular-nums">
      <span className="text-muted-foreground">{label} </span>
      <span className={toneCls}>{mark} {num(Math.abs(delta), digits)}</span>
    </span>
  );
}

/**
 * A quote instrument: label, reading, change, de-emphasised trend, age.
 * Used for the cross-asset drivers and the unbounded gold indicators
 * (GVZ, ATR, net spec).
 *
 * Empty state: a symbol with no rows renders "no data" — no figure, no
 * sparkline, no delta. Sparklines need two points to claim a trend; a
 * single print renders the value with no line. The age line is
 * unconditional for a live value: on this dashboard a reading without its
 * age is a claim of freshness nothing has verified.
 *
 * `delta` is tri-state: a number is a change, null means "no honest
 * reference exists" (renders "<period> —"), and undefined means the tile
 * makes no change claim at all (e.g. ATR, where a day-over-day diff is
 * not something the desk reads) — no delta slot renders.
 */
export function QuoteTile({ label, value, digits = 2, ts, delta, deltaLabel = "24h",
  deltaTone = "direction", series, note, now, className }: {
  label: string;
  value: number | null;
  digits?: number;
  ts: string | null;
  delta?: number | null;
  deltaLabel?: string;
  deltaTone?: "direction" | "neutral";
  series?: PricePoint[];
  note?: string;
  now: Date;
  className?: string;
}) {
  return (
    <div className={cls("rounded-md border border-border/60 p-3", className)}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      {value === null ? (
        <div className="mt-1 text-sm text-muted-foreground">no data</div>
      ) : (
        <>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
            <span className="text-lg font-semibold">{num(value, digits)}</span>
            {delta !== undefined && (
              <span className="text-xs">
                <Delta delta={delta} digits={digits} label={deltaLabel} tone={deltaTone} />
              </span>
            )}
          </div>
          {series && series.length >= 2 && (
            <Sparkline points={series} stroke="var(--muted-foreground)"
              className="mt-1.5 h-6 opacity-70" />
          )}
          <div className="mt-1.5 text-[10px] text-muted-foreground">
            {note ? `${note} · ` : ""}{ts ? fmtAge(ts, now) : "no timestamp"}
          </div>
        </>
      )}
    </div>
  );
}
