import Link from "next/link";
import type { ClusterHeadRow, ItemRow } from "@/lib/db";
import type { NewsPulse } from "@/lib/newsflow";
import { niceTicks } from "@/components/spot-chart";
import { fmtAge } from "@/lib/format";

/**
 * News flow as a shape, not a list: a fortnight of daily volume with the
 * gold topic emphasised against everything else, the story most wires
 * carried, and the deduplicated headline trail beneath.
 *
 * Server-rendered SVG in the spot-chart pattern: native <title> per bar
 * carries the full per-topic breakdown, the table twin is the value-exact
 * fallback, so hover never gates a number. Two series → the legend is
 * always present; "other" wears the de-emphasis gray (a wash, not a
 * saturated block) whose sub-contrast is relieved by the titles and the
 * table, per the palette notes in globals.css.
 *
 * Headlines are cluster representatives, not raw rows — ten copies of one
 * story is one story. A story on several wires says so ("4 wires"): the
 * fold count is real signal the flat list used to hide as duplicates.
 */

const W = 640;
const H = 110;
const M = { left: 30, right: 6, top: 14, bottom: 16 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const fmtDay = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;

/** Square base, 3px-rounded top — the data end. */
function topRoundedBar(x: number, yTop: number, w: number, h: number): string {
  const r = Math.min(3, h);
  const yb = yTop + h;
  return `M${x},${yb} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + w - r} ` +
    `Q${x + w},${yTop} ${x + w},${yTop + r} V${yb} Z`;
}

function barTitle(day: { day: string; byTopic: Record<string, number> }, total: number): string {
  const parts = Object.entries(day.byTopic).sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t} ${n}`).join(" · ");
  return `${day.day}: ${total} ${total === 1 ? "item" : "items"}${parts ? ` — ${parts}` : ""}`;
}

function VolumeChart({ pulse }: { pulse: NewsPulse }) {
  const { days, maxTotal } = pulse;
  const slot = PW / days.length;
  const barW = Math.min(24, slot * 0.62);
  const y = (v: number) => M.top + PH - (v / maxTotal) * PH;
  const peak = days.findIndex(d => d.gold + d.other === maxTotal);
  const grid = niceTicks(0, maxTotal, 3).filter(v => v > 0 && v <= maxTotal);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
      aria-label={`news volume, ${pulse.total} items over ${days.length} days to ${pulse.anchorDay}`}>
      {grid.map(v => (
        <g key={v}>
          <line x1={M.left} x2={W - M.right} y1={y(v).toFixed(1)} y2={y(v).toFixed(1)}
            stroke="var(--border)" strokeWidth="1" />
          <text x={M.left - 5} y={y(v).toFixed(1)} fontSize="10" textAnchor="end"
            dominantBaseline="middle" fill="var(--muted-foreground)"
            style={{ fontVariantNumeric: "tabular-nums" }}>{v}</text>
        </g>
      ))}
      <line x1={M.left} x2={W - M.right} y1={M.top + PH} y2={M.top + PH}
        stroke="var(--border)" strokeWidth="1" />

      {days.map((d, i) => {
        const total = d.gold + d.other;
        const cx = M.left + i * slot + (slot - barW) / 2;
        const goldH = (d.gold / maxTotal) * PH;
        const otherH = (d.other / maxTotal) * PH;
        const goldTop = M.top + PH - goldH;
        // 2px surface gap between the stacked segments.
        const otherBottom = d.gold > 0 ? goldTop - 2 : M.top + PH;
        const otherTop = otherBottom - otherH;
        return (
          <g key={d.day}>
            {d.other > 0 && (
              <path d={topRoundedBar(cx, otherTop, barW, Math.max(otherBottom - otherTop, 0.5))}
                fill="var(--muted-foreground)" fillOpacity="0.4" />
            )}
            {d.gold > 0 && (
              d.other > 0
                ? <rect x={cx} y={goldTop.toFixed(1)} width={barW}
                    height={Math.max(goldH, 0.5).toFixed(1)} fill="var(--viz-spot)" />
                : <path d={topRoundedBar(cx, goldTop, barW, Math.max(goldH, 0.5))}
                    fill="var(--viz-spot)" />
            )}
            {i === peak && total > 0 && (
              <text x={(cx + barW / 2).toFixed(1)} y={(y(total) - 4).toFixed(1)} fontSize="10"
                textAnchor="middle" fill="var(--muted-foreground)"
                style={{ fontVariantNumeric: "tabular-nums" }}>{total}</text>
            )}
            {/* hover target spanning the whole slot, not just the bar */}
            <rect x={M.left + i * slot} y={M.top} width={slot} height={PH + M.bottom}
              fill="transparent">
              <title>{barTitle(d, total)}</title>
            </rect>
          </g>
        );
      })}

      {[0, Math.floor(days.length / 2), days.length - 1].map(i => (
        <text key={days[i].day} x={(M.left + i * slot + slot / 2).toFixed(1)} y={H - 3}
          fontSize="10"
          textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"}
          fill="var(--muted-foreground)">{fmtDay(days[i].day)}</text>
      ))}
    </svg>
  );
}

export function NewsFlow({ pulse, heads, top, lastItemTs, now }: {
  pulse: NewsPulse;
  heads: ClusterHeadRow[];
  top: { item: ItemRow; sources: number; items: number } | null;
  lastItemTs: string | null;
  now: Date;
}) {
  return (
    <section aria-label="News flow" className="rounded border border-border p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-medium">
          News flow
          <Link className="ml-2 text-xs font-normal text-primary" href="/inbox">→ inbox</Link>
        </h2>
        {lastItemTs && (
          <span className="text-xs text-muted-foreground">
            last item {fmtAge(lastItemTs, now)}
          </span>
        )}
      </div>

      {pulse.days.length === 0 ? (
        <p className="text-sm text-muted-foreground">no news items recorded yet</p>
      ) : (
        <>
          <VolumeChart pulse={pulse} />
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-muted-foreground">
            <span className="flex items-center gap-1">
              <span aria-hidden className="h-2 w-2 rounded-[2px]"
                style={{ background: "var(--viz-spot)" }} /> gold topic
            </span>
            <span className="flex items-center gap-1">
              <span aria-hidden className="h-2 w-2 rounded-[2px] bg-muted-foreground/40" />
              other topics
            </span>
          </div>
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              daily counts
            </summary>
            <table className="mt-2 w-full text-xs tabular-nums">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="font-normal">day</th>
                  <th className="font-normal">gold</th>
                  <th className="font-normal">other</th>
                  <th className="font-normal">total</th>
                </tr>
              </thead>
              <tbody>
                {pulse.days.map(d => (
                  <tr key={d.day}>
                    <td className="pr-3">{d.day}</td>
                    <td>{d.gold}</td>
                    <td>{d.other}</td>
                    <td>{d.gold + d.other}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          <p className="mt-2 text-sm">
            {top ? (
              <>
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  top story
                </span>{" "}
                <a href={top.item.url} target="_blank" rel="noreferrer"
                  className="hover:underline">{top.item.headline}</a>{" "}
                <span className="text-xs text-muted-foreground tabular-nums"
                  title={`${top.items} items from ${top.sources} distinct sources in 48h`}>
                  · {top.sources} wires
                </span>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">
                no story on more than one wire in the last 48h
              </span>
            )}
          </p>
        </>
      )}

      <div className="mt-4 border-t border-border pt-3">
        <h3 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
          Latest headlines
        </h3>
        <ul className="space-y-1 text-sm">
          {heads.length === 0 && <li className="text-muted-foreground">no items</li>}
          {heads.map(i => (
            <li key={i.id} className="flex items-baseline gap-2">
              <span className="w-14 shrink-0 text-xs text-muted-foreground">
                {fmtAge(i.published_at, now)}
              </span>
              <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">
                {i.source}
              </span>
              <a href={i.url} target="_blank" rel="noreferrer"
                className="min-w-0 flex-1 truncate hover:underline">{i.headline}</a>
              {i.sources_n >= 2 && (
                <span className="shrink-0 rounded border border-border px-1 text-meta text-muted-foreground tabular-nums"
                  title={`carried by ${i.sources_n} distinct sources`}>
                  {i.sources_n} wires
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
