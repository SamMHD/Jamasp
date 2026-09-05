import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { PredictionList, STATE_INK, STATE_LABEL } from "@/components/prediction-list";
import * as files from "@/lib/files";
import { cls } from "@/lib/format";
import {
  buildLedger, countByState, LIVE_STATES, RESOLVED_STATES,
  type PredictionState,
} from "@/lib/predictions";

export const dynamic = "force-dynamic";

const FILTERS = [...LIVE_STATES, ...RESOLVED_STATES] as const;

/**
 * `?state=hit` (or due/open/miss/unclear) narrows the ledger to one state;
 * anything else — absent, repeated, or garbage — is the whole ledger. A view
 * param must never throw on unexpected input, and the same tolerance as the
 * overview's `?w=` means a stale bookmark degrades to the full list rather
 * than 404ing.
 */
export function resolveStateFilter(
  param: string | string[] | undefined,
): PredictionState | "all" {
  const v = Array.isArray(param) ? param[0] : param;
  return (FILTERS as readonly string[]).includes(v ?? "")
    ? (v as PredictionState) : "all";
}

function FilterLink({ href, label, n, active, ink }: {
  href: string; label: string; n: number; active: boolean; ink?: string;
}) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined}
      className={cls(
        "inline-flex min-h-8 items-center gap-1.5 rounded border border-border px-2 text-meta",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        active ? "bg-foreground text-background"
          : "hover:bg-secondary",
      )}>
      <span className={cls("uppercase", !active && ink)}>{label}</span>
      <span className="tabular-nums">{n}</span>
    </Link>
  );
}

/**
 * The whole forecast ledger — open and resolved alike — as one list.
 *
 * Unfiltered, it splits at the only line that changes what a reader can do
 * about a row: Live (still actionable — due ones first, then the ones still
 * running) above Resolved (a scoring log, newest first). Filtering by a
 * single state collapses that to one flat list, since the split would then
 * have exactly one side.
 *
 * Read-only, like every page here: predictions are written by
 * `jamasp predictions add|score`, never by the panel.
 */
export default async function PredictionsPage({ searchParams }: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const now = new Date();
  const preds = files.readPredictions();
  const stats = files.predictionStats(preds, now);
  const rows = buildLedger(preds, now);
  const counts = countByState(rows);
  const filter = resolveStateFilter((await searchParams).state);

  const live = rows.filter(r => !r.resolved);
  const resolved = rows.filter(r => r.resolved);
  const decisive = stats.hits + stats.misses;

  // An empty ledger is stated outright, in the Forecast-record card's own
  // words — not drawn as two empty sections under a filter row of zeroes.
  if (rows.length === 0) {
    return (
      <div>
        <AutoRefresh seconds={60} />
        <PageHeader title="Predictions" subtitle="the forecast ledger" />
        <p className="text-sm text-muted-foreground">no predictions recorded</p>
      </div>
    );
  }

  return (
    <div>
      <AutoRefresh seconds={60} />
      <PageHeader title="Predictions" subtitle={
        `${rows.length} in the ledger · ` +
        (stats.hitRate === null
          ? "none scored yet"
          : `${Math.round(stats.hitRate * 100)}% hit rate over ${decisive} decisive`) +
        ` · ${live.length} still live`} />

      <nav aria-label="Filter by state" className="mb-4 flex flex-wrap gap-1.5">
        <FilterLink href="/predictions" label="all" n={rows.length} active={filter === "all"} />
        {FILTERS.map(s => (
          <FilterLink key={s} href={`/predictions?state=${s}`} label={STATE_LABEL[s]}
            n={counts[s]} active={filter === s} ink={STATE_INK[s]} />
        ))}
      </nav>

      {counts.due > 0 && filter === "all" && (
        <p className={cls("mb-4 rounded border border-amber-400 bg-amber-100/60 px-3 py-2 text-sm",
          "text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300")}>
          {counts.due} matured but unscored — <code>jamasp predictions due</code> would hand
          these to the next run.
        </p>
      )}

      {filter === "all" ? (
        <>
          <section aria-label="Live predictions" className="mb-8">
            <h2 className="mb-2 font-medium">
              Live
              <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
                {counts.due} due · {counts.open} open ·{" "}
                {/* One sort rule, two readings: live rows go by maturity
                    ascending, so overdue ones lead when any exist and the
                    next claim to land leads when none do. The caption states
                    whichever of the two the reader is actually looking at. */}
                {counts.due > 0 ? "most overdue first" : "soonest to mature first"}
              </span>
            </h2>
            <PredictionList rows={live} now={now}
              empty="nothing live — every prediction in the ledger is scored" />
          </section>
          <section aria-label="Resolved predictions">
            <h2 className="mb-2 font-medium">
              Resolved
              <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
                {counts.hit} hit · {counts.miss} miss · {counts.unclear} unclear · newest first
              </span>
            </h2>
            <PredictionList rows={resolved} now={now} empty="nothing scored yet" />
          </section>
        </>
      ) : (
        <section aria-label={`${STATE_LABEL[filter]} predictions`}>
          <PredictionList rows={rows.filter(r => r.state === filter)} now={now}
            empty={`no ${STATE_LABEL[filter]} predictions`} />
        </section>
      )}
    </div>
  );
}
