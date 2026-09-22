import Link from "next/link";
import { ArcGauge } from "@/components/arc-gauge";
import { LevelLadder } from "@/components/level-ladder";
import { LiveChart } from "@/components/live-chart";
import { QuoteTile } from "@/components/quote-tile";
import { SeriesTable } from "@/components/series-table";
import { SpotChart } from "@/components/spot-chart";
import type { PricePoint } from "@/lib/db";
import type { GoldTechnicals } from "@/lib/technicals";
import { JAMASP_INSTRUMENT, TV_LIVE_LABEL, TV_LIVE_SYMBOL } from "@/lib/tradingview";
import { cls, fmtAge } from "@/lib/format";
import { t, type Messages } from "@/lib/i18n";

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
 * `tech.regime` is one of exactly four strings lib/technicals.ts#deriveRegime
 * produces — paired byte-for-byte with jamasp/pricesummary.py#_tech_line and
 * asserted exactly by test/technicals.test.ts. This is prose ("above both",
 * not an identifier), so unlike the level ladder's shorthand labels it gets a
 * full Persian rendering rather than staying Latin — an exact-match lookup,
 * never a paraphrase of deriveRegime's own return value.
 */
const REGIME_KEY: Record<string, string> = {
  "above both": "tech.regimeAboveBoth",
  "below both": "tech.regimeBelowBoth",
  "above 50DMA, below 200DMA": "tech.regimeAbove50Below200",
  "below 50DMA, above 200DMA": "tech.regimeBelow50Above200",
};

/** Falls back to the raw string for a regime shape deriveRegime has never
 *  actually produced — never a blank line where a reading belongs. */
function regimeLabel(regime: string, messages: Messages): string {
  const key = REGIME_KEY[regime];
  return key ? t(messages, key) : regime;
}

/**
 * Jamasp's own stored gold reading, boxed and labelled as such.
 *
 * This used to be the panel's unlabelled hero figure, which was the whole
 * problem: `prices.GC` carries the market bar timestamp, so a frozen feed
 * (or any weekend) presented a day-old number in the typography of a live
 * quote. Beside a live chart it becomes what it always was — a reading, with
 * a provenance and an age — and the desk can see in one glance whether the
 * two agree.
 *
 * The age line is unconditional and deliberately not an amber alarm: a
 * threshold would fire ~26h every weekend when the market is legitimately
 * shut and train the desk to ignore it, whereas a plain age is
 * self-interpreting in both directions.
 */
function LastReading({ spot, now, messages }: {
  spot: NonNullable<GoldTechnicals["spot"]>;
  now: Date;
  messages: Messages;
}) {
  const dir = direction(spot.delta24h);
  return (
    <div className="rounded-md border border-border/60 p-3">
      <div className="text-label uppercase text-ink-dim">{t(messages, "tech.lastReadingLabel")}</div>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {/* hero figure: proportional digits — tabular is for columns */}
        <span className="text-3xl font-semibold leading-none tracking-tight">
          {num(spot.value)}
        </span>
        <span className={cls("text-sm tabular-nums", DIR_TONE[dir])}>
          {/* "24h" and the em dash are Latin/unit chrome in both locales — see
              components/quote-tile.tsx's Delta, which renders the identical
              "<label> —" shape for the same reason. */}
          {dir === "unknown" ? "24h —" : (
            <>
              {DIR_MARK[dir]} {num(Math.abs(spot.delta24h!))}
              {spot.pct24h !== null && ` (${num(Math.abs(spot.pct24h), 2)}%)`}
            </>
          )}
        </span>
      </div>
      <p className="mt-2 text-meta text-ink-dim">
        {JAMASP_INSTRUMENT} · {t(messages, "tech.comexFrontMonth")} · {t(messages, "tech.readPrefix")}{" "}
        {fmtAge(spot.ts, messages, now)}
      </p>
      {/* The one thing a side-by-side must not leave the reader to guess.
          The widget charts SPOT (lib/tradingview.ts explains why it cannot
          chart the future), and the front-month future trades above spot by
          the carry — so a standing gap of tens of dollars is the basis, and
          reading it as a stale or broken feed would be exactly wrong. */}
      {/* "trades at", not "runs": e2e/smoke.spec.ts asserts an unrelated
          getByText("runs") for the ops strip, and a second match anywhere on
          the page is a Playwright strict-mode violation — kept true in
          Persian too, since TV_LIVE_LABEL ("spot XAU/USD") stays Latin. */}
      <p className="text-meta text-ink-dim">
        {t(messages, "tech.vsLive")} {TV_LIVE_LABEL} — {t(messages, "tech.carryNote")}
      </p>
    </div>
  );
}

/**
 * The technical instrument cluster: a live TradingView gold chart, Jamasp's
 * own last reading boxed beside it, the level rail, and a gauge row (RSI arc
 * + GVZ/ATR/net-spec tiles, each stating its own cadence and age).
 *
 * The split is the point. Left is live and belongs to TradingView; right is
 * stored and belongs to Jamasp — reading, levels, regime. Nothing on the
 * right claims to be current, and the widget cannot be read from this page
 * (cross-origin iframe), so the two are never silently merged into one
 * number: the comparison is the reader's, made with their eyes. Both sides
 * name their own instrument, because they are not the same one — see
 * lib/tradingview.ts on why the widget charts spot while Jamasp reads the
 * front-month future.
 *
 * Deliberately absent, here as everywhere: any aggregate verdict. The RSI
 * gauge shows where 66 sits on 0–100; nothing points at a word. The widget
 * is configured the same way — config/sources.yaml records why Jamasp does
 * not store TradingView's buy/sell gauges either.
 */
export function TechnicalPanel({ tech, series, tvSymbol = TV_LIVE_SYMBOL, gvzSeries = [],
  gvzDelta = null, netSpecDelta = null, now, messages }: {
  tech: GoldTechnicals;
  series: PricePoint[];
  /** What the widget charts; overridable from config — see lib/tradingview.ts. */
  tvSymbol?: string;
  gvzSeries?: PricePoint[];
  gvzDelta?: number | null;
  netSpecDelta?: number | null;
  now: Date;
  messages: Messages;
}) {
  const atrPctOfSpot = tech.indicators.atr14 !== null && tech.spot !== null && tech.spot.value > 0
    ? (tech.indicators.atr14 / tech.spot.value) * 100
    : null;
  return (
    <section aria-label={t(messages, "tech.technicalHeading")} className="rounded border border-border p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-medium">
          {t(messages, "tech.technicalHeading")}
          <Link className="ml-2 text-xs font-normal text-primary" href="/prices">
            → {t(messages, "nav.prices").toLowerCase()}
          </Link>
        </h2>
      </div>

      {/* 260px rather than the old 230: the reading box now shares this
          column with the ladder, and "24h ▲ 6.5 (0.15%)" beside a four-digit
          figure needs the extra rail to stay on one line. */}
      <div className="grid gap-x-6 gap-y-4 md:grid-cols-[minmax(0,1fr)_260px]">
        <div>
          {/* The widget renders whatever Jamasp's own feed is doing — a dead
              price feed is exactly when the desk most needs a live number to
              check against, so this is deliberately outside the spot guard
              below. */}
          <LiveChart symbol={tvSymbol} messages={messages}>
            {/* `undefined`, not `&&`: LiveChart distinguishes "no fallback
                chart to show" from a rendered one, and a `false` child would
                read as the latter. */}
            {series.length >= 2 ? (
              <SpotChart points={series}
                levels={tech.levels
                  .filter(l => l.kind !== "spot")
                  .map(l => ({ label: l.label, value: l.value }))} />
            ) : undefined}
          </LiveChart>
          <SeriesTable points={series} label={t(messages, "tech.storedReadingsTable")} messages={messages} />
        </div>

        <div className="flex flex-col gap-3">
          {tech.spot === null ? (
            <p className="text-sm text-muted-foreground">{t(messages, "common.noPriceData")}</p>
          ) : (
            <>
              <LastReading spot={tech.spot} now={now} messages={messages} />
              <div>
                <LevelLadder levels={tech.levels} messages={messages} />
                <p className="mt-3 text-sm">
                  {tech.regime
                    ? regimeLabel(tech.regime, messages)
                    : <span className="text-muted-foreground">{t(messages, "tech.insufficientData")}</span>}
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      {tech.spot !== null && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="flex items-center justify-center rounded-md border border-border/60 p-2">
              <ArcGauge label={t(messages, "signal.rsi14")} value={tech.indicators.rsi14}
                min={0} max={100} messages={messages}
                ticks={[{ at: 30, text: "30" }, { at: 70, text: "70" }]} />
            </div>
            <QuoteTile label={t(messages, "signal.gvz")} value={tech.indicators.gvz} digits={2}
              ts={tech.gvzAsOf} delta={gvzDelta} series={gvzSeries} now={now} messages={messages} />
            <QuoteTile label={t(messages, "signal.atr14")} value={tech.indicators.atr14} digits={1}
              ts={tech.indicatorsAsOf}
              note={atrPctOfSpot === null ? undefined
                : `${num(atrPctOfSpot)}% ${t(messages, "tech.ofSpotSuffix")}`}
              now={now} messages={messages} />
            {/* "w/w" (week-over-week) is compact chrome notation in the same
                register as "24h" elsewhere on this panel — Latin in both
                locales, the same reasoning that keeps fmtAge's magnitude and
                unit Latin ("3h", "2d"). fmtAge's "ago"/"in" wrapper is NOT
                notation but an English word, and does go through the
                dictionary; see lib/format.ts. */}
            <QuoteTile label={t(messages, "signal.netSpec")} value={tech.indicators.netSpec} digits={1}
              ts={tech.netSpecAsOf} delta={netSpecDelta} deltaLabel="w/w"
              deltaTone="neutral" note={t(messages, "tech.cftcWeekly")} now={now} messages={messages} />
          </div>

          {tech.indicatorsAsOf && (
            <p className={cls("mt-2 text-xs",
              tech.stale ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
              {t(messages, "tech.indicatorsPrefix")} {fmtAge(tech.indicatorsAsOf, messages, now)}
              {tech.stale && <> — {t(messages, "tech.stale")}</>}
            </p>
          )}
        </>
      )}
    </section>
  );
}
