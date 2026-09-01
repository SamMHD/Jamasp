import Link from "next/link";
import { chartBins, type CalibrationBin } from "@/lib/calibration";
import type { PredictionStats } from "@/lib/files";

/**
 * The analyst's forecast record: counts, hit rate, and a diverging
 * calibration chart — hits above the baseline, misses below, bucketed by
 * stated confidence. Hit/miss is a genuine good/bad, so the bars wear
 * status colours and never impersonate a series; the arm legend and the
 * table twin keep the encoding from being colour-alone.
 *
 * This scores the analyst, not the market: no bar here is a view on
 * gold. Empty states are stated — an empty ledger says so, a ledger with
 * nothing scored yet says so — rather than drawing empty axes.
 */

const BAR_W = 26;
const SLOT_W = 34;
const ARM_H = 34;
const TOP_PAD = 6;
const LABEL_H = 14;

/** Square at the baseline, 3px-rounded at the data end. */
function barPath(x: number, y0: number, h: number, up: boolean): string {
  const r = Math.min(3, h);
  const w = BAR_W;
  if (up) {
    const yt = y0 - h;
    return `M${x},${y0} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + w - r} Q${x + w},${yt} ${x + w},${yt + r} V${y0} Z`;
  }
  const yb = y0 + h;
  return `M${x},${y0} V${yb - r} Q${x},${yb} ${x + r},${yb} H${x + w - r} Q${x + w},${yb} ${x + w},${yb - r} V${y0} Z`;
}

function CalibrationChart({ bins }: { bins: CalibrationBin[] }) {
  const slice = chartBins(bins);
  const maxCount = Math.max(1, ...slice.flatMap(b => [b.hits, b.misses]));
  const unit = ARM_H / maxCount;
  const w = slice.length * SLOT_W;
  const h = TOP_PAD + ARM_H * 2 + LABEL_H;
  const y0 = TOP_PAD + ARM_H;
  const total = slice.reduce((n, b) => n + b.hits + b.misses, 0);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full max-w-64" role="img"
      aria-label={`calibration by stated confidence: ${total} scored predictions, hits above the line, misses below`}>
      <line x1="0" x2={w} y1={y0} y2={y0} stroke="var(--border)" strokeWidth="1" />
      {slice.map((b, i) => {
        const x = i * SLOT_W + (SLOT_W - BAR_W) / 2;
        return (
          <g key={b.lo}>
            {b.hits > 0 && (
              <path d={barPath(x, y0 - 1, b.hits * unit, true)}
                className="fill-emerald-700 dark:fill-emerald-400">
                <title>{`confidence ${b.lo * 100}–${b.hi * 100}%: ${b.hits} hit`}</title>
              </path>
            )}
            {b.misses > 0 && (
              <path d={barPath(x, y0 + 1, b.misses * unit, false)}
                className="fill-destructive">
                <title>{`confidence ${b.lo * 100}–${b.hi * 100}%: ${b.misses} miss`}</title>
              </path>
            )}
          </g>
        );
      })}
      <text x="0" y={h - 3} fontSize="9" fill="var(--muted-foreground)">
        {slice[0].lo * 100}%
      </text>
      <text x={w} y={h - 3} fontSize="9" textAnchor="end" fill="var(--muted-foreground)">
        100%
      </text>
      <text x={w / 2} y={h - 3} fontSize="9" textAnchor="middle" fill="var(--muted-foreground)">
        stated confidence
      </text>
    </svg>
  );
}

export function PredictionPanel({ stats, bins }: {
  stats: PredictionStats;
  bins: CalibrationBin[];
}) {
  const none = stats.scored === 0 && stats.open === 0 && stats.maturedUnscored === 0;
  const decisive = stats.hits + stats.misses;
  return (
    <section aria-label="Forecast record" className="rounded border border-border p-4">
      <h2 className="mb-3 font-medium">
        Forecast record
        <Link className="ml-2 text-xs font-normal text-primary" href="/state">→ state</Link>
      </h2>
      {none ? (
        <p className="text-sm text-muted-foreground">no predictions recorded</p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            {stats.hitRate !== null ? (
              <div>
                <span className="text-3xl font-semibold leading-none">
                  {Math.round(stats.hitRate * 100)}%
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  hit rate · {decisive} decisive
                </span>
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">none scored yet</span>
            )}
            <div className="text-xs text-muted-foreground tabular-nums">
              {stats.hits} hit · {stats.misses} miss · {stats.unclear} unclear · {stats.open} open
              {stats.maturedUnscored > 0 && (
                <span className="text-amber-600 dark:text-amber-400">
                  {" "}· {stats.maturedUnscored} awaiting score
                </span>
              )}
            </div>
          </div>
          {decisive > 0 && (
            <div className="mt-3">
              <CalibrationChart bins={bins} />
              <div className="mt-1 flex gap-4 text-meta text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span aria-hidden className="h-2 w-2 rounded-[2px] bg-emerald-700 dark:bg-emerald-400" />
                  hit (above line)
                </span>
                <span className="flex items-center gap-1">
                  <span aria-hidden className="h-2 w-2 rounded-[2px] bg-destructive" />
                  miss (below line)
                </span>
              </div>
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  view as table
                </summary>
                <table className="mt-2 w-full text-xs tabular-nums">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="font-normal">confidence</th>
                      <th className="font-normal">hits</th>
                      <th className="font-normal">misses</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chartBins(bins).map(b => (
                      <tr key={b.lo}>
                        <td>{b.lo * 100}–{b.hi * 100}%</td>
                        <td>{b.hits}</td>
                        <td>{b.misses}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </div>
          )}
        </>
      )}
    </section>
  );
}
