import { cookies } from "next/headers";
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { Markdown } from "@/components/markdown";
import { SourceLang } from "@/components/source-lang";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import * as files from "@/lib/files";
import { fmtAge } from "@/lib/format";
import { getMessages, LANG_COOKIE, localized, resolveLocale, t, type Locale, type Messages } from "@/lib/i18n";
import { directionLabel } from "@/lib/predictions";
import { STATE_LABEL_KEY } from "@/components/prediction-list";

/** `outcome` is null (open) | "hit" | "miss" | "unclear" — reuses the same
 *  `predictions.word*` keys components/prediction-list.tsx's STATE_LABEL_KEY
 *  reads, so the ledger's own word for "hit" can never drift from this
 *  table's. */
const OUTCOME_KEY: Record<string, string> = {
  hit: STATE_LABEL_KEY.hit, miss: STATE_LABEL_KEY.miss, unclear: STATE_LABEL_KEY.unclear,
};

export const dynamic = "force-dynamic";

/**
 * A whole-document sidecar rendered as one block: the sidecar's own body
 * when its hash matches the English source, the English body with ONE
 * marker otherwise. Unlike FundamentalPanel's per-section treatment, this
 * page is a raw dump — its Markdown block has no sub-structure to hang a
 * finer-grained marker on, so `sidecarBody` is `null` (forcing the English
 * fallback) not only when the top-level hash mismatches but also when ANY
 * section still carries the empty-hash hazard (see lib/files.ts#readStanceFa):
 * a coarse page gets the coarse treatment, all-or-nothing, rather than
 * splicing that one section's literal English into an otherwise-Persian
 * block with no way to mark it.
 *
 * BLANK counts as absent, hence `.trim()` rather than a `=== null` test. A
 * sidecar can be structurally valid and hash-correct while carrying nothing
 * — an interrupted write, a model that returned empty, every section body
 * blank behind real hashes — and rendering `<Markdown text="" />` for that
 * put an empty stance or playbook on screen wearing no EN marker at all.
 * Nothing about the page would say the translation had failed. The guard
 * lives here as well as in lib/files.ts#readWholeDocumentFa because this
 * component also takes the CONCATENATED per-section stance body, which no
 * reader-level check covers.
 */
function LocalizedDocument({ english, sidecarBody, locale, messages }: {
  english: string;
  sidecarBody: string | null;
  locale: Locale;
  messages: Messages;
}) {
  if (locale === "en" || !sidecarBody?.trim()) {
    return (
      <SourceLang fallback={locale === "fa"} messages={messages} block>
        <Markdown text={english} />
      </SourceLang>
    );
  }
  return <Markdown text={sidecarBody} />;
}

export default async function StatePage() {
  const locale = resolveLocale((await cookies()).get(LANG_COOKIE)?.value);
  const messages = getMessages(locale);

  const stance = files.readStance();
  // Sections concatenated with their front matter AND per-section hash
  // markers stripped — "the sidecar's body" readStanceFa hands back, with
  // headings dropped: jamasp/translatetext.py's own note is that a
  // section's heading line is "an anchor, never rendered," and this page
  // has no dictionary to render a canonical heading through anyway.
  //
  // A sidecar can pass its OWN top-level hash check while one section still
  // carries the empty-hash hazard (a failed or budget-skipped section with
  // no prior Persian — see readStanceFa's doc comment). This page has no
  // per-section marker to hang on that one section, so ANY empty hash here
  // discards the whole sidecar, same as a stale top-level hash: better one
  // honest English page than a silent, unmarked splice of English into
  // Persian.
  const stanceFa = files.readStanceFa();
  const stanceFaBody = stanceFa && stanceFa.sections.every(s => s.hash !== "")
    ? stanceFa.sections.map(s => s.body).join("")
    : null;
  const playbook = files.readPlaybook();
  const playbookFa = files.readPlaybookFa();
  const watchlist = files.readWatchlist();
  // Keyed by theme, per lib/files.ts#readWatchlistFa's own contract: a theme
  // missing here (not yet translated, or stale against the current `why`)
  // is simply absent from the map, and `localized` below reads that as "no
  // Persian" the same way it would read a missing `why_fa` column.
  const watchlistFa = files.readWatchlistFa();
  const preds = files.readPredictions();
  const predictionsFa = files.readPredictionsFa();
  const stats = files.predictionStats(preds);
  const openOrDue = preds.filter(p => p.outcome === null);

  const allPreds = [...openOrDue, ...preds.filter(p => p.outcome !== null)];

  return (
    <div>
      <AutoRefresh seconds={60} />
      <PageHeader title={t(messages, "nav.state")} />
      <section className="mb-8">
        <h2 className="mb-2 font-medium">{t(messages, "state.stanceHeading")}</h2>
        {stance
          ? <LocalizedDocument english={stance} sidecarBody={stanceFaBody}
              locale={locale} messages={messages} />
          : <p className="text-sm text-muted-foreground">{t(messages, "common.noStanceYet")}</p>}
      </section>
      <section className="mb-8">
        <h2 className="mb-2 font-medium">{t(messages, "state.watchlistHeading")}</h2>
        <ul className="space-y-1 text-sm">
          {watchlist.length === 0 && (
            <li className="text-muted-foreground">{t(messages, "state.watchlistEmptyWord")}</li>
          )}
          {watchlist.map(w => {
            // Shaped as a one-off {why, why_fa} "row" for `localized`, the
            // same pattern lib/files.ts's own doc comment on readWatchlistFa
            // points callers at — the theme slug itself stays Latin, an
            // identifier, never routed through localized/SourceLang.
            const { text, fallback } = localized(
              { why: w.why, why_fa: watchlistFa[w.theme] }, "why", locale);
            return (
              <li key={w.theme}>
                <span className="font-medium">{w.theme}</span>
                <span className="text-muted-foreground">
                  {" — "}<SourceLang fallback={fallback} messages={messages}>{text}</SourceLang>
                  {" · "}{t(messages, "state.sinceWord")} {w.since}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
      <section className="mb-8">
        <h2 className="mb-2 font-medium">
          {t(messages, "nav.predictions")}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {stats.open} {t(messages, "predictions.wordOpen")} · {stats.maturedUnscored}{" "}
            {t(messages, "predictions.wordDue")} · {stats.scored} {t(messages, "predictions.wordScored")} ·{" "}
            {t(messages, "predictions.wordHitRate")}{" "}
            {stats.hitRate === null ? "—" : `${Math.round(stats.hitRate * 100)}%`}
          </span>
        </h2>
        <Table>
          <TableHeader><TableRow>
            <TableHead>{t(messages, "table.claim")}</TableHead>
            <TableHead>{t(messages, "table.direction")}</TableHead>
            <TableHead>{t(messages, "table.confidence")}</TableHead>
            <TableHead>{t(messages, "table.horizon")}</TableHead>
            <TableHead>{t(messages, "table.made")}</TableHead>
            <TableHead>{t(messages, "table.outcome")}</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {allPreds.map(p => {
              // Same {claim, claim_fa} shaping as the watchlist above, keyed
              // by prediction id per lib/files.ts#readPredictionsFa.
              const { text, fallback } = localized(
                { claim: p.claim, claim_fa: predictionsFa[p.id] }, "claim", locale);
              return (
                <TableRow key={p.id}>
                  <TableCell className="max-w-md">
                    <SourceLang fallback={fallback} messages={messages}>{text}</SourceLang>
                  </TableCell>
                  <TableCell>{directionLabel(p.direction, messages)}</TableCell>
                  <TableCell>{Math.round(p.confidence * 100)}%</TableCell>
                  <TableCell>{p.horizon_days}d</TableCell>
                  <TableCell>{fmtAge(p.created_at)}</TableCell>
                  <TableCell>
                    {p.outcome
                      ? <Badge variant={p.outcome === "hit" ? "secondary" : p.outcome === "miss" ? "destructive" : "outline"}>
                          {t(messages, OUTCOME_KEY[p.outcome] ?? "predictions.wordUnclear")}
                        </Badge>
                      : <Badge variant="outline">{t(messages, "predictions.wordOpen")}</Badge>}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>
      <section>
        <h2 className="mb-2 font-medium">{t(messages, "state.playbookHeading")}</h2>
        {playbook
          ? <LocalizedDocument english={playbook} sidecarBody={playbookFa}
              locale={locale} messages={messages} />
          : <p className="text-sm text-muted-foreground">{t(messages, "state.noPlaybookYet")}</p>}
      </section>
    </div>
  );
}
