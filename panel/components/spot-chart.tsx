import type { PricePoint } from "@/lib/db";
import { fmtUtc } from "@/lib/format";

/**
 * The overview's gold futures chart — server-rendered inline SVG, real
 * axes, no client JS.
 *
 * Deliberately not recharts: this panel is a wall-screen instrument and
 * must paint fully from the server render alone (this dev deployment
 * demonstrably serves pages whose client hydration never completes — the
 * recharts charts on /prices draw nothing there). Native SVG <title>
 * elements give per-point hover readouts and the table view underneath is
 * the value-exact twin, so nothing is gated on a tooltip layer.
 *
 * Stored levels (SMAs, pivots) are drawn as hairline reference lines, but
 * only those falling inside the price window: stretching the domain to
 * reach a far-away pivot would flatten the actual price action, and the
 * ladder beside this chart already maps the full set. The chart never
 * claims a level it cannot place.
 *
 * With fewer than two points there is no line to draw and the component
 * says so — no empty axes pretending to be a chart.
 */

const W = 720;
const H = 260;
const M = { left: 56, right: 10, top: 10, bottom: 26 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

/** Hover-target budget: one invisible <title> circle per sampled point. */
const MAX_HOVER_POINTS = 120;

function fmtValue(v: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/** Round-numbered axis ticks covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, target = 4): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(v);
  return out;
}

export function SpotChart({ points, levels }: {
  points: PricePoint[];
  levels: { label: string; value: number }[];
}) {
  if (points.length < 2) {
    return (
      <p className="flex h-full min-h-40 items-center justify-center rounded-md border border-border/60 p-4 text-center text-sm text-muted-foreground">
        not enough price history to draw — the ladder carries the levels
      </p>
    );
  }

  const times = points.map(p => new Date(p.ts).getTime());
  const values = points.map(p => p.value);
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo || 1) * 0.06;
  const yLo = lo - pad;
  const yHi = hi + pad;

  const x = (t: number) => M.left + ((t - t0) / (t1 - t0 || 1)) * PW;
  const y = (v: number) => M.top + (1 - (v - yLo) / (yHi - yLo)) * PH;

  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(times[i]).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join(" ");

  const yTicks = niceTicks(yLo, yHi);
  const xTicks = [0, 1 / 3, 2 / 3, 1].map(f => t0 + f * (t1 - t0));
  const shown = levels.filter(l => l.value >= yLo && l.value <= yHi);

  const hoverStep = Math.max(1, Math.ceil(points.length / MAX_HOVER_POINTS));
  const hover = points.filter((_, i) => i % hoverStep === 0 || i === points.length - 1);

  const last = points[points.length - 1];

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
        aria-label={`gold futures, ${points.length} points from ${fmtUtc(points[0].ts)} to ${fmtUtc(last.ts)}, latest ${fmtValue(last.value)}`}>
        {/* hairline horizontal grid + y labels */}
        {yTicks.map(v => (
          <g key={`y${v}`}>
            <line x1={M.left} x2={W - M.right} y1={y(v).toFixed(1)} y2={y(v).toFixed(1)}
              stroke="var(--border)" strokeWidth="1" />
            <text x={M.left - 8} y={y(v).toFixed(1)} fontSize="11" textAnchor="end"
              dominantBaseline="middle" fill="var(--muted-foreground)"
              style={{ fontVariantNumeric: "tabular-nums" }}>{fmtValue(v)}</text>
          </g>
        ))}
        {/* x labels */}
        {xTicks.map((t, i) => (
          <text key={`x${t}`} x={x(t).toFixed(1)} y={H - 8} fontSize="11"
            textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
            fill="var(--muted-foreground)">{fmtUtc(new Date(t).toISOString())}</text>
        ))}
        {/* stored levels inside the window, hairline + right-anchored label */}
        {shown.map(l => (
          <g key={l.label}>
            <line x1={M.left} x2={W - M.right} y1={y(l.value).toFixed(1)} y2={y(l.value).toFixed(1)}
              stroke="var(--muted-foreground)" strokeOpacity="0.45" strokeWidth="1" />
            <text x={W - M.right - 2} y={(y(l.value) - 4).toFixed(1)} fontSize="10"
              textAnchor="end" fill="var(--muted-foreground)">{l.label}</text>
          </g>
        ))}
        {/* the series */}
        <path d={d} fill="none" stroke="var(--viz-spot)" strokeWidth="2"
          strokeLinejoin="round" strokeLinecap="round" />
        {/* end marker, surface-ringed */}
        <circle cx={x(times[times.length - 1]).toFixed(1)} cy={y(last.value).toFixed(1)}
          r="4.5" fill="var(--viz-spot)" stroke="var(--background)" strokeWidth="2" />
        {/* no-JS hover readouts: native SVG titles on invisible hit areas */}
        {hover.map(p => (
          <circle key={p.ts} cx={x(new Date(p.ts).getTime()).toFixed(1)}
            cy={y(p.value).toFixed(1)} r="9" fill="transparent">
            <title>{`${fmtValue(p.value)} — ${fmtUtc(p.ts)}`}</title>
          </circle>
        ))}
      </svg>
      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          view as table
        </summary>
        <div className="mt-2 max-h-40 overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="font-normal">time (UTC)</th>
                <th className="font-normal">value</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {points.map(p => (
                <tr key={p.ts}>
                  <td className="pr-4">{fmtUtc(p.ts)}</td>
                  <td>{fmtValue(p.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
