import Link from "next/link";
import { LevelLadder } from "@/components/level-ladder";
import { Sparkline } from "@/components/sparkline";
import type { PricePoint } from "@/lib/db";
import type { GoldTechnicals } from "@/lib/technicals";
import { cls, fmtAge } from "@/lib/format";

function num(v: number | null, digits = 1): string {
  return v === null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: digits });
}

// Four distinct states, because "unknown" and "flat" are not the same claim
// and neither is a rise: null means no 24h reference row exists at all, so
// it must not fall through to "0" and read as a genuine flat move.
type Direction = "up" | "down" | "flat" | "unknown";

const DIR_TONE: Record<Direction, string> = {
  up: "text-emerald-400",
  down: "text-destructive",
  flat: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

const DIR_MARK: Record<Direction, string> = { up: "▲", down: "▼", flat: "=", unknown: "" };

function direction(delta: number | null): Direction {
  if (delta === null) return "unknown";
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "flat";
}

export function TechnicalPanel({ tech, series, now }: {
  tech: GoldTechnicals; series: PricePoint[]; now: Date;
}) {
  const delta = tech.spot?.delta24h ?? null;
  const dir = direction(delta);
  return (
    <section className="rounded border border-border p-4">
      <div className="mb-4 flex items-baseline justify-between gap-2">
        <h2 className="font-medium">
          Technical
          <Link className="ml-2 text-xs font-normal text-primary" href="/prices">→ prices</Link>
        </h2>
        {tech.spot && (
          <div className="tabular-nums">
            <span className="text-xl font-semibold">{num(tech.spot.value)}</span>
            <span className={cls("ml-2 text-sm", DIR_TONE[dir])}>
              {dir === "unknown" ? "24h —" : (
                <>
                  {DIR_MARK[dir]} {num(Math.abs(delta!))}
                  {tech.spot.pct24h !== null && ` (${num(Math.abs(tech.spot.pct24h), 2)}%)`}
                </>
              )}
            </span>
            {/* Unconditional, and deliberately not an amber alarm. `stale`
                above tracks the six TradingView series only, which are
                stamped with fetch time — so it keeps ticking over precisely
                when GC, stamped with market bar time, freezes. Nothing else
                on this panel can say the price itself is old. A threshold
                alarm would fire ~26h every weekend when the market is
                legitimately shut and train the desk to ignore it; a plain age
                is self-interpreting in both directions. */}
            <span className="ml-2 text-xs text-muted-foreground">
              {fmtAge(tech.spot.ts, now)}
            </span>
          </div>
        )}
      </div>

      {tech.spot === null ? (
        <p className="text-sm text-muted-foreground">no price data yet</p>
      ) : (
        <>
          <LevelLadder levels={tech.levels} />

          <p className="mt-4 text-sm">
            {tech.regime ?? <span className="text-muted-foreground">insufficient data</span>}
          </p>

          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
            <div><dt className="inline">RSI14 </dt><dd className="inline">{num(tech.indicators.rsi14)}</dd></div>
            <div><dt className="inline">ATR14 </dt><dd className="inline">{num(tech.indicators.atr14)}</dd></div>
            <div><dt className="inline">GVZ </dt><dd className="inline">{num(tech.indicators.gvz, 2)}</dd></div>
            <div><dt className="inline">net spec </dt><dd className="inline">{num(tech.indicators.netSpec, 1)}</dd></div>
          </dl>

          {tech.indicatorsAsOf && (
            <p className={cls("mt-1 text-xs",
              tech.stale ? "text-amber-400" : "text-muted-foreground")}>
              indicators {fmtAge(tech.indicatorsAsOf, now)}
              {tech.stale && " — stale, technicals feed has missed a cycle"}
            </p>
          )}

          <Sparkline points={series} className="mt-4" />
        </>
      )}
    </section>
  );
}
