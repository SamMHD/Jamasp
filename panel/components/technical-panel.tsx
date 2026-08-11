import Link from "next/link";
import { ArcGauge } from "@/components/arc-gauge";
import { LevelLadder } from "@/components/level-ladder";
import { QuoteTile } from "@/components/quote-tile";
import { SpotChart } from "@/components/spot-chart";
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
  up: "text-emerald-700 dark:text-emerald-400",
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

/**
 * The technical instrument cluster: hero quote, price chart with stored
 * levels, the level rail, and a gauge row (RSI arc + GVZ/ATR/net-spec
 * tiles, each stating its own cadence and age).
 *
 * Deliberately absent, here as everywhere: any aggregate verdict. The RSI
 * gauge shows where 66 sits on 0–100; nothing points at a word.
 */
export function TechnicalPanel({ tech, series, gvzSeries = [], gvzDelta = null,
  netSpecDelta = null, now }: {
  tech: GoldTechnicals;
  series: PricePoint[];
  gvzSeries?: PricePoint[];
  gvzDelta?: number | null;
  netSpecDelta?: number | null;
  now: Date;
}) {
  const delta = tech.spot?.delta24h ?? null;
  const dir = direction(delta);
  const atrPctOfSpot = tech.indicators.atr14 !== null && tech.spot !== null && tech.spot.value > 0
    ? (tech.indicators.atr14 / tech.spot.value) * 100
    : null;
  return (
    <section aria-label="Technical" className="rounded border border-border p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-medium">
          Technical
          <Link className="ml-2 text-xs font-normal text-primary" href="/prices">→ prices</Link>
        </h2>
        {tech.spot && (
          <div className="flex flex-wrap items-baseline gap-x-3">
            {/* hero figure: proportional digits — tabular is for columns */}
            <span className="text-4xl font-semibold leading-none tracking-tight">
              {num(tech.spot.value)}
            </span>
            <span className={cls("text-sm tabular-nums", DIR_TONE[dir])}>
              {dir === "unknown" ? "24h —" : (
                <>
                  {DIR_MARK[dir]} {num(Math.abs(delta!))}
                  {tech.spot.pct24h !== null && ` (${num(Math.abs(tech.spot.pct24h), 2)}%)`}
                </>
              )}
            </span>
            {/* Unconditional, and deliberately not an amber alarm. `stale`
                below tracks the six TradingView series only, which are
                stamped with fetch time — so it keeps ticking over precisely
                when GC, stamped with market bar time, freezes. Nothing else
                on this panel can say the price itself is old. A threshold
                alarm would fire ~26h every weekend when the market is
                legitimately shut and train the desk to ignore it; a plain age
                is self-interpreting in both directions. */}
            <span className="text-xs text-muted-foreground">
              {fmtAge(tech.spot.ts, now)}
            </span>
          </div>
        )}
      </div>

      {tech.spot === null ? (
        <p className="text-sm text-muted-foreground">no price data yet</p>
      ) : (
        <>
          <div className="grid gap-x-6 gap-y-4 md:grid-cols-[minmax(0,1fr)_230px]">
            <SpotChart points={series}
              levels={tech.levels
                .filter(l => l.kind !== "spot")
                .map(l => ({ label: l.label, value: l.value }))} />
            <div>
              <LevelLadder levels={tech.levels} />
              <p className="mt-3 text-sm">
                {tech.regime ?? <span className="text-muted-foreground">insufficient data</span>}
              </p>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="flex items-center justify-center rounded-md border border-border/60 p-2">
              <ArcGauge label="RSI14" value={tech.indicators.rsi14} min={0} max={100}
                ticks={[{ at: 30, text: "30" }, { at: 70, text: "70" }]} />
            </div>
            <QuoteTile label="GVZ implied vol" value={tech.indicators.gvz} digits={2}
              ts={tech.gvzAsOf} delta={gvzDelta} series={gvzSeries} now={now} />
            <QuoteTile label="ATR14 range" value={tech.indicators.atr14} digits={1}
              ts={tech.indicatorsAsOf}
              note={atrPctOfSpot === null ? undefined : `${num(atrPctOfSpot)}% of spot`}
              now={now} />
            <QuoteTile label="Net spec" value={tech.indicators.netSpec} digits={1}
              ts={tech.netSpecAsOf} delta={netSpecDelta} deltaLabel="w/w"
              deltaTone="neutral" note="CFTC weekly" now={now} />
          </div>

          {tech.indicatorsAsOf && (
            <p className={cls("mt-2 text-xs",
              tech.stale ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
              indicators {fmtAge(tech.indicatorsAsOf, now)}
              {tech.stale && " — stale, technicals feed has missed a cycle"}
            </p>
          )}
        </>
      )}
    </section>
  );
}
