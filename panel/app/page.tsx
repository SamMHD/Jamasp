import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { DriverPanel } from "@/components/driver-panel";
import { FundamentalPanel } from "@/components/fundamental-panel";
import { HorizonStrip } from "@/components/horizon-strip";
import { NewsFlow } from "@/components/news-flow";
import { PredictionPanel } from "@/components/prediction-panel";
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
import { deriveTechnicals, TECHNICAL_SYMBOLS } from "@/lib/technicals";
import { fmtUtc } from "@/lib/format";

export const dynamic = "force-dynamic";

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export default function Overview() {
  const now = new Date();
  const dayAgo = iso(new Date(now.getTime() - 86400_000));

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
  const weekAgo = iso(new Date(now.getTime() - 7 * 86400_000));
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

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
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
