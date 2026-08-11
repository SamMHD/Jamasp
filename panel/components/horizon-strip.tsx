import Link from "next/link";
import type { Horizon, HorizonEntry, HorizonLane } from "@/lib/horizon";
import { cls, fmtAge, fmtUtc } from "@/lib/format";

/**
 * The fundamental band's forward axis: what is scheduled that could move
 * the view, and when. Server-rendered SVG in the spot-chart pattern —
 * paints fully with zero client JS, native <title> hover readouts, and
 * the list beneath is the value-exact twin (the SVG shows timing shape
 * and density; the list carries every entry's text, so nothing is gated
 * on hovering a 10px mark).
 *
 * Lane identity is carried by the in-SVG lane labels and the list rows,
 * never by hue alone; the hues are the validated --viz-1..3 trio in fixed
 * order (events, maturities, wakeups). Event impact is encoded filled
 * (high) vs open (medium) with a text legend, not by a second hue.
 *
 * Exactly one direct label rides the axis — the first high-impact event,
 * the print the desk trades around. Everything else stays in titles and
 * the list: axis labels collide by construction on a dense week.
 *
 * An overdue pending wakeup is pinned at the left edge and flagged in
 * amber in the list — a wakeup the dispatcher missed is a genuine
 * attention state, not a series.
 */

const W = 640;
const H = 100;
const GUTTER = 78;
const RIGHT_PAD = 12;
const PW = W - GUTTER - RIGHT_PAD;
const LANE_Y: Record<HorizonLane, number> = { event: 18, prediction: 42, wakeup: 66 };
const LANE_VAR: Record<HorizonLane, string> = {
  event: "var(--viz-1)", prediction: "var(--viz-2)", wakeup: "var(--viz-3)",
};
const LANE_TEXT: Record<HorizonLane, string> = {
  event: "events", prediction: "maturities", wakeup: "wakeups",
};
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const AXIS_Y = 82;
const MAX_ROWS = 6;

function Mark({ entry, x }: { entry: HorizonEntry; x: number }) {
  const cy = LANE_Y[entry.lane];
  const open = entry.lane === "event" && entry.impact === "medium";
  return (
    <circle cx={x.toFixed(1)} cy={cy}
      r={open ? 4 : entry.impact === "high" ? 5 : 4.5}
      fill={open ? "var(--background)" : LANE_VAR[entry.lane]}
      stroke={open ? LANE_VAR[entry.lane] : "var(--background)"}
      strokeWidth={open ? 1.5 : 2}>
      <title>{`${fmtUtc(entry.ts)} — ${entry.detail}`}</title>
    </circle>
  );
}

export function HorizonStrip({ horizon, now }: { horizon: Horizon; now: Date }) {
  const { entries, counts, overdueCount, days } = horizon;
  const t0 = Date.parse(horizon.start);
  const t1 = Date.parse(horizon.end);
  const x = (ts: string) => {
    const t = Date.parse(ts);
    const raw = GUTTER + ((t - t0) / (t1 - t0)) * PW;
    return Math.min(Math.max(raw, GUTTER), W - RIGHT_PAD);
  };

  const ticks: number[] = [];
  const firstMidnight = new Date(t0);
  firstMidnight.setUTCHours(0, 0, 0, 0);
  for (let ms = firstMidnight.getTime() + 86400_000; ms < t1; ms += 86400_000) ticks.push(ms);

  const labelled = entries.find(e => e.lane === "event" && e.impact === "high");

  return (
    <section aria-label="Horizon" className="rounded border border-border p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-medium">
          Horizon
          <Link className="ml-2 text-xs font-normal text-primary" href="/calendar">→ calendar</Link>
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          next {days}d · {counts.event} event {counts.event === 1 ? "slot" : "slots"} ·{" "}
          {counts.prediction} maturing · {counts.wakeup} {counts.wakeup === 1 ? "wakeup" : "wakeups"}
          {overdueCount > 0 && (
            <span className="text-amber-600 dark:text-amber-400"> · {overdueCount} overdue</span>
          )}
        </span>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          nothing on the horizon — no high/medium-impact events, open-prediction
          maturities, or pending wakeups in the next {days} days
        </p>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
            aria-label={`${days}-day horizon: ${counts.event} event slots, ${counts.prediction} prediction maturities, ${counts.wakeup} pending wakeups`}>
            {/* day boundaries: hairline verticals + weekday labels */}
            {ticks.map(ms => {
              const tx = x(new Date(ms).toISOString());
              const d = new Date(ms);
              return (
                <g key={ms}>
                  <line x1={tx.toFixed(1)} x2={tx.toFixed(1)} y1="8" y2={AXIS_Y}
                    stroke="var(--border)" strokeWidth="1" />
                  {/* a midnight hugging the left edge would set its centred
                      label over the gutter; skip it — the next one names the
                      day and the list rows carry exact times */}
                  {tx - GUTTER > 22 && (
                    <text x={tx.toFixed(1)} y={H - 4} fontSize="10" textAnchor="middle"
                      fill="var(--muted-foreground)">
                      {WEEKDAYS[d.getUTCDay()]} {d.getUTCDate()}
                    </text>
                  )}
                </g>
              );
            })}
            <line x1={GUTTER} x2={W - RIGHT_PAD} y1={AXIS_Y} y2={AXIS_Y}
              stroke="var(--border)" strokeWidth="1" />
            {/* end-anchored into the gutter so it can never collide with the
                first day label, whatever hour the render lands on */}
            <text x={GUTTER - 4} y={H - 4} fontSize="10" textAnchor="end"
              fill="var(--muted-foreground)">now</text>

            {/* lane labels — identity by text, never colour alone */}
            {(Object.keys(LANE_Y) as HorizonLane[]).map(lane => (
              <text key={lane} x={GUTTER - 10} y={LANE_Y[lane] + 3.5} fontSize="10"
                textAnchor="end" fill="var(--muted-foreground)">{LANE_TEXT[lane]}</text>
            ))}

            {/* the one direct label: the first high-impact event */}
            {labelled && (
              <text x={Math.min(Math.max(x(labelled.ts), GUTTER + 24), W - 40).toFixed(1)}
                y={LANE_Y.event - 9} fontSize="10" textAnchor="middle"
                fill="var(--muted-foreground)">{labelled.label}</text>
            )}

            {entries.map(e => (
              <Mark key={`${e.lane}-${e.ts}-${e.label}`} entry={e} x={x(e.ts)} />
            ))}
          </svg>

          <div className="mt-1 flex gap-4 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span aria-hidden className="h-2.5 w-2.5 rounded-full"
                style={{ background: "var(--viz-1)" }} /> high impact
            </span>
            <span className="flex items-center gap-1">
              <span aria-hidden className="h-2.5 w-2.5 rounded-full border-[1.5px]"
                style={{ borderColor: "var(--viz-1)" }} /> medium
            </span>
          </div>

          <ul className="mt-3 space-y-1 text-sm">
            {entries.slice(0, MAX_ROWS).map(e => (
              <li key={`${e.lane}-${e.ts}-${e.label}`}>
                <Link href={e.href} className="flex items-baseline gap-2 hover:underline"
                  title={e.detail}>
                  <span aria-hidden className="h-2 w-2 shrink-0 self-center rounded-full"
                    style={{ background: LANE_VAR[e.lane] }} />
                  <span className="w-24 shrink-0 text-xs text-muted-foreground tabular-nums">
                    {fmtUtc(e.ts)}
                  </span>
                  <span className={cls("w-14 shrink-0 text-xs",
                    e.overdue ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
                    {e.overdue ? "overdue" : fmtAge(e.ts, now)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{e.label}</span>
                    <span className="text-muted-foreground"> — {e.detail}</span>
                  </span>
                  {e.lane === "prediction" && e.confidence !== null && (
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      conf {e.confidence}
                    </span>
                  )}
                </Link>
              </li>
            ))}
            {entries.length > MAX_ROWS && (
              <li className="text-xs text-muted-foreground">
                +{entries.length - MAX_ROWS} more within {days}d
              </li>
            )}
          </ul>
        </>
      )}
    </section>
  );
}
