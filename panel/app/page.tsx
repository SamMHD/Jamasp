import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { FundamentalPanel } from "@/components/fundamental-panel";
import { TechnicalPanel } from "@/components/technical-panel";
import { FooterStrip, StatusStrip } from "@/components/status-strip";
import * as db from "@/lib/db";
import * as files from "@/lib/files";
import { deriveSourceHealth, deriveWarnings } from "@/lib/health";
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
  const items = db.getItems({ limit: 8 });

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
  const series = db.getPriceSeries("GC", iso(new Date(now.getTime() - 10 * 86400_000)));

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
              : "rounded border border-amber-900 bg-amber-950/50 px-3 py-2 text-sm text-amber-300"}>
              {w.text}
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <FundamentalPanel stance={stance} items={items} now={now} />
        <TechnicalPanel tech={tech} series={series} now={now} />
      </div>

      <FooterStrip wakeup={db.getWakeups("pending")[0]}
        event={db.getEvents(14, now)[0]} lastAlert={db.getNotifyLog(1)[0]} now={now} />
    </div>
  );
}
