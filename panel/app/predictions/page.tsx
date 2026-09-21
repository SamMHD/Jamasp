import { cookies } from "next/headers";
import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { PredictionList, STATE_INK, stateLabel } from "@/components/prediction-list";
import * as files from "@/lib/files";
import { cls } from "@/lib/format";
import { getMessages, LANG_COOKIE, resolveLocale, t } from "@/lib/i18n";
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
  // Same pattern as app/page.tsx and app/schedule/page.tsx: the locale
  // cookie is httpOnly, so only a server component may read it.
  const locale = resolveLocale((await cookies()).get(LANG_COOKIE)?.value);
  const messages = getMessages(locale);

  const now = new Date();
  const preds = files.readPredictions();
  const predictionsFa = files.readPredictionsFa();
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
        <PageHeader title={t(messages, "nav.predictions")} subtitle={t(messages, "predictions.forecastLedgerSubtitle")} />
        <p className="text-sm text-muted-foreground">{t(messages, "predictions.noneRecorded")}</p>
      </div>
    );
  }

  return (
    <div>
      <AutoRefresh seconds={60} />
      <PageHeader title={t(messages, "nav.predictions")} subtitle={
        `${rows.length} ${t(messages, "predictions.subtitleLedger")} · ` +
        (stats.hitRate === null
          ? t(messages, "predictions.noneScoredYet")
          : `${Math.round(stats.hitRate * 100)}% ${t(messages, "predictions.subtitleHitRateOver")} ${decisive} ${t(messages, "predictions.subtitleDecisive")}`) +
        ` · ${live.length} ${t(messages, "predictions.subtitleStillLive")}`} />

      <nav aria-label={t(messages, "predictions.filterByStateAria")} className="mb-4 flex flex-wrap gap-1.5">
        <FilterLink href="/predictions" label={t(messages, "predictions.filterAll")}
          n={rows.length} active={filter === "all"} />
        {FILTERS.map(s => (
          <FilterLink key={s} href={`/predictions?state=${s}`} label={stateLabel(s, messages)}
            n={counts[s]} active={filter === s} ink={STATE_INK[s]} />
        ))}
      </nav>

      {counts.due > 0 && filter === "all" && (
        <p className={cls("mb-4 rounded border border-amber-400 bg-amber-100/60 px-3 py-2 text-sm",
          "text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300")}>
          {counts.due} {t(messages, "predictions.maturedUnscoredWarning")} <code>jamasp predictions due</code>{" "}
          {t(messages, "predictions.wouldHandOff")}
        </p>
      )}

      {filter === "all" ? (
        <>
          <section aria-label={`${t(messages, "predictions.liveHeading")} ${t(messages, "predictions.noStateSuffixWord")}`} className="mb-8">
            <h2 className="mb-2 font-medium">
              {t(messages, "predictions.liveHeading")}
              <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
                {counts.due} {t(messages, "predictions.wordDue")} · {counts.open} {t(messages, "predictions.wordOpen")} ·{" "}
                {/* One sort rule, two readings: live rows go by maturity
                    ascending, so overdue ones lead when any exist and the
                    next claim to land leads when none do. The caption states
                    whichever of the two the reader is actually looking at. */}
                {counts.due > 0
                  ? t(messages, "predictions.mostOverdueFirst")
                  : t(messages, "predictions.soonestFirst")}
              </span>
            </h2>
            <PredictionList rows={live} now={now} locale={locale} messages={messages}
              predictionsFa={predictionsFa}
              empty={t(messages, "predictions.nothingLive")} />
          </section>
          <section aria-label={`${t(messages, "predictions.resolvedHeading")} ${t(messages, "predictions.noStateSuffixWord")}`}>
            <h2 className="mb-2 font-medium">
              {t(messages, "predictions.resolvedHeading")}
              <span className="ml-2 text-xs font-normal text-muted-foreground tabular-nums">
                {counts.hit} {t(messages, "predictions.wordHit")} · {counts.miss} {t(messages, "predictions.wordMiss")} ·{" "}
                {counts.unclear} {t(messages, "predictions.wordUnclear")} · {t(messages, "predictions.newestFirst")}
              </span>
            </h2>
            <PredictionList rows={resolved} now={now} locale={locale} messages={messages}
              predictionsFa={predictionsFa}
              empty={t(messages, "predictions.nothingScoredYet")} />
          </section>
        </>
      ) : (
        <section aria-label={`${stateLabel(filter, messages)} ${t(messages, "predictions.noStateSuffixWord")}`}>
          <PredictionList rows={rows.filter(r => r.state === filter)} now={now}
            locale={locale} messages={messages} predictionsFa={predictionsFa}
            empty={t(messages, "predictions.emptyStateFilteredTemplate").replace("{state}", stateLabel(filter, messages))} />
        </section>
      )}
    </div>
  );
}
