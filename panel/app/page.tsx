import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { DriverPanel } from "@/components/driver-panel";
import { FundamentalPanel } from "@/components/fundamental-panel";
import { HorizonStrip } from "@/components/horizon-strip";
import { MarketMap } from "@/components/market-map";
import { NewsFlow } from "@/components/news-flow";
import { PredictionPanel } from "@/components/prediction-panel";
import { TechnicalMap } from "@/components/technical-map";
import { TechnicalPanel } from "@/components/technical-panel";
import { FooterStrip, StatusStrip } from "@/components/status-strip";
import * as db from "@/lib/db";
import * as files from "@/lib/files";
import { calibrationBins } from "@/lib/calibration";
import { deriveDriver, printDelta, DRIVER_SPECS } from "@/lib/drivers";
import { deriveSourceHealth, deriveWarnings } from "@/lib/health";
import { deriveHorizon } from "@/lib/horizon";
import { deriveNewsPulse } from "@/lib/newsflow";
import { parseStance } from "@/lib/stance";
import { buildSignalTiles } from "@/lib/technicalmap";
import { deriveTechnicals, TECHNICAL_SYMBOLS } from "@/lib/technicals";
import { buildThemeMultipliers, type MapRange } from "@/lib/marketmap";
import { cls, fmtUtc } from "@/lib/format";

export const dynamic = "force-dynamic";

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * `?w=week` selects the trailing 7 days; anything else — including the
 * param being absent, an array (repeated `?w=`), or a garbage value —
 * is the rolling 24h window. A view param must never throw on unexpected
 * input, and the fallback also means a bookmarked `?w=today` from before
 * this window was rolling degrades quietly instead of 404ing or throwing.
 */
export function resolveRange(param: string | string[] | undefined): MapRange {
  const v = Array.isArray(param) ? param[0] : param;
  return v === "week" ? "week" : "24h";
}

/**
 * Window start for the map: trailing 24 hours, or trailing 7 days.
 *
 * Both are rolling. See lib/marketmap.ts#MapRange for why the short window
 * is not the Dubai calendar day it used to be — in short, the map emptied
 * at 00:00 Dubai and stayed near-empty for hours, and "what is moving now"
 * is not a calendar-day question.
 */
export function windowSinceIso(range: MapRange, now: Date): string {
  const days = range === "week" ? 7 : 1;
  return iso(new Date(now.getTime() - days * 86400_000));
}

export default async function Overview({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const now = new Date();
  const dayAgo = iso(new Date(now.getTime() - 86400_000));
  const weekAgo = windowSinceIso("week", now);

  // --- fundamental map ---
  const sp = await searchParams;
  const range = resolveRange(sp.w);
  const mapSince = windowSinceIso(range, now);
  const mapItems = db.getScoredItems(mapSince);
  const mapUnscored = db.unscoredCountSince(mapSince);

  // --- technical map ---
  const signalStates = db.latestSignalStates();
  const fittedWeights = files.readFittedWeights();
  const signalTiles = buildSignalTiles(
    signalStates, files.loadWeightsConfig().signals, fittedWeights);

  // See lib/marketmap.ts#buildThemeMultipliers for why a pinned-but-unfitted
  // coefficient must still reach the map.
  const themeMultipliers = buildThemeMultipliers(fittedWeights?.fits?.theme?.coefficients);

  // --- ops health (unchanged derivations, demoted presentation) ---
  const lastIngest = db.getMeta("last_ingest_at");
  const sources = files.loadSources();
  const lastFetch = Object.fromEntries(
    sources.map(s => [s.name, db.getMeta(`source_last_fetch.${s.name}`)]));
  const lastItems = Object.fromEntries(
    db.lastItemPerSource().map(r => [r.source, r.last]));
  const sourceErrors = db.getSourceErrors(dayAgo);
  const health = deriveSourceHealth(sources, lastFetch, lastItems, sourceErrors, now);
  const runsToday = db.runsTodayDubai(now);
  const cap = files.maxRunsPerDay();
  const warnings = deriveWarnings({ lastIngestAt: lastIngest, runs: db.getAgentRuns(50),
    sourceHealth: health, runsToday, cap }, now);

  // --- fundamental ---
  const stanceText = files.readStance();
  const stance = stanceText === null ? null : parseStance(stanceText);
  const watchlist = files.readWatchlist();
  const preds = files.readPredictions();
  const pendingWakeups = db.getWakeups("pending");
  const horizon = deriveHorizon(
    { events: db.getEvents(7, now), predictions: preds, wakeups: pendingWakeups }, now);
  // News-volume window anchored to the newest item (see lib/newsflow.ts);
  // the SQL cutoff is a day wider than the 14-day day-window so its first
  // day is never a partial count.
  const lastItemTs = db.newestItemTs();
  const volume = lastItemTs
    ? db.itemVolumeByDay(iso(new Date(new Date(lastItemTs).getTime() - 14 * 86400_000)))
    : [];
  const pulse = deriveNewsPulse(volume, lastItemTs);
  const heads = db.getClusterHeads(8);
  const top = db.topStory(iso(new Date(now.getTime() - 48 * 3600_000)));

  // --- technical ---
  const p = db.latestPrices([...TECHNICAL_SYMBOLS]);
  const spot = p.GC ?? null;
  // At-or-before, matching pricesummary.py's _delta — the first row *after*
  // the cutoff can sit hours away across an overnight or weekend gap. Passing
  // the latest GC timestamp is what lets the lookup refuse to compare the
  // latest row against itself: when GC has not printed since the cutoff (every
  // weekend, ~26h) the reference is null and the panel renders "24h —" rather
  // than a confident flat zero.
  const spot24h = spot ? db.priceDeltaReference("GC", dayAgo, spot.ts) : null;
  const tech = deriveTechnicals({
    spot,
    spot24hAgo: spot24h,
    sma50: p.GC_SMA50 ?? null,
    sma200: p.GC_SMA200 ?? null,
    pivotS1: p.GC_PIV_S1 ?? null,
    pivotR1: p.GC_PIV_R1 ?? null,
    rsi14: p.GC_RSI14 ?? null,
    atr14: p.GC_ATR14 ?? null,
    gvz: p["^GVZ"] ?? null,
    netSpec: p.GC_NET_SPEC ?? null,
  }, now);
  // Chart window anchored to the newest GC bar, not to `now`: when the feed
  // freezes the desk should see the final ten days of shape — the hero age
  // and the x-axis dates state the staleness — rather than an emptying box
  // as wall-clock time drifts past a window no new bars are entering.
  const series = spot
    ? db.getPriceSeries("GC", iso(new Date(new Date(spot.ts).getTime() - 10 * 86400_000)))
    : [];
  // Gauge-row context. Each delta goes through the same honest-reference
  // lookup as the GC hero: a frozen series yields null, rendered "24h —".
  const gvz = p["^GVZ"] ?? null;
  const gvzRef = gvz ? db.priceDeltaReference("^GVZ", dayAgo, gvz.ts) : null;
  const gvzSeries = db.getPriceSeries("^GVZ", iso(new Date(now.getTime() - 7 * 86400_000)));
  const netSpecDelta = printDelta(
    db.getPriceSeries("GC_NET_SPEC", iso(new Date(now.getTime() - 35 * 86400_000))));

  // --- drivers (cross-asset) ---
  const driverQuotes = db.latestPrices(DRIVER_SPECS.map(s => s.symbol));
  const drivers = DRIVER_SPECS.map(spec => {
    const quote = driverQuotes[spec.symbol] ?? null;
    const ref = quote ? db.priceDeltaReference(spec.symbol, dayAgo, quote.ts) : null;
    return deriveDriver(spec, quote, ref, db.getPriceSeries(spec.symbol, weekAgo));
  });

  // --- forecast record ---
  const predStats = files.predictionStats(preds, now);

  return (
    <div>
      <AutoRefresh />
      <PageHeader title="Overview" subtitle={`as of ${fmtUtc(iso(now))}`} />

      <section aria-label="Market map" className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">Market map</h2>
          <nav aria-label="Map window" className="flex gap-1 text-sm">
            <Link href="/?w=24h" aria-current={range === "24h" ? "page" : undefined}
              className={cls("rounded px-2 py-0.5",
                range === "24h" ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground")}>
              24h
            </Link>
            <Link href="/?w=week" aria-current={range === "week" ? "page" : undefined}
              className={cls("rounded px-2 py-0.5",
                range === "week" ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground")}>
              This week
            </Link>
          </nav>
        </div>
        {/* 2:1 rather than 3:1. The SVG preserves its aspect ratio — stretching
            would distort tile areas, and area is the encoding — so the viewBox
            ratio decides how much of a screen fullscreen actually fills. 2:1
            also buys tiles the height that wrapped headlines need. */}
        <MarketMap items={mapItems} width={1200} height={600} range={range}
          coverage={{ scored: mapItems.length, unscored: mapUnscored }}
          themeMultipliers={themeMultipliers}
          fittedAt={fittedWeights?.fittedAt ?? null} />
      </section>

      <section aria-label="Technical map" className="mb-4">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Technical map</h2>
        {/* Same 2:1 viewBox as the fundamental map. The SVG preserves its
            aspect ratio on purpose — stretching would distort tile areas, and
            area is the encoding on a treemap. */}
        <TechnicalMap tiles={signalTiles} width={1200} height={600}
          fittedAt={fittedWeights?.fittedAt ?? null} />
      </section>

      <StatusStrip lastIngest={lastIngest} runsToday={runsToday} cap={cap}
        sourceErrors={sourceErrors.length} lastRuns={db.lastRunPerType()} now={now} />

      {warnings.length > 0 && (
        <div className="mt-3 space-y-2">
          {warnings.map((w, i) => (
            <div key={i} className={w.severity === "red"
              ? "rounded border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive"
              : "rounded border border-amber-400 bg-amber-100/60 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300"}>
              {w.text}
            </div>
          ))}
        </div>
      )}

      <div className="mt-4">
        <TechnicalPanel tech={tech} series={series} gvzSeries={gvzSeries}
          gvzDelta={gvz && gvzRef !== null ? gvz.value - gvzRef : null}
          netSpecDelta={netSpecDelta?.delta ?? null} now={now} />
      </div>

      {/* grid-cols-1 at the base is load-bearing, not decorative: an
          unprefixed `grid` with only `lg:grid-cols-5` leaves the implicit
          single track sized `auto` below 1024px, so CSS Grid's default
          `min-width: auto` on grid items lets that track grow to whichever
          child's content is widest instead of the container's own width —
          exactly the kind of overflow the mobile sweep exists to catch. */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="flex flex-col gap-4 lg:col-span-3">
          <FundamentalPanel stance={stance} watchlist={watchlist} now={now} />
          <HorizonStrip horizon={horizon} now={now} />
          <NewsFlow pulse={pulse} heads={heads} top={top} lastItemTs={lastItemTs} now={now} />
        </div>
        <div className="flex flex-col gap-4 lg:col-span-2">
          <DriverPanel drivers={drivers} now={now} />
          <PredictionPanel stats={predStats} bins={calibrationBins(preds)} />
        </div>
      </div>

      <FooterStrip wakeup={pendingWakeups[0]}
        event={db.getEvents(14, now)[0]} lastAlert={db.getNotifyLog(1)[0]} now={now} />
    </div>
  );
}
