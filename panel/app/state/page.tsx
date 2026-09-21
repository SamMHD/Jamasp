import { cookies } from "next/headers";
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { Markdown } from "@/components/markdown";
import { SourceLang } from "@/components/source-lang";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import * as files from "@/lib/files";
import { fmtAge } from "@/lib/format";
import { getMessages, LANG_COOKIE, resolveLocale, type Locale, type Messages } from "@/lib/i18n";

export const dynamic = "force-dynamic";

/**
 * A whole-document sidecar rendered as one block: the sidecar's own body
 * when its hash matches the English source, the English body with ONE
 * marker otherwise. Unlike FundamentalPanel's per-section treatment, this
 * page is a raw dump — its Markdown block has no sub-structure to match
 * Persian bodies into by position, so a stance whose sidecar carries a
 * single failed section (see lib/files.ts#readStanceFa's empty-per-section-
 * hash contract) renders that one section's literal English text inline,
 * unmarked, rather than gaining a second, finer-grained marker here. That
 * asymmetry is deliberate: this page trades precision for simplicity, and
 * FundamentalPanel is where the precise per-section marker lives.
 */
function LocalizedDocument({ english, sidecarBody, locale, messages }: {
  english: string;
  sidecarBody: string | null;
  locale: Locale;
  messages: Messages;
}) {
  if (locale === "en" || sidecarBody === null) {
    return (
      <SourceLang fallback={locale === "fa"} messages={messages}>
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
  const stanceFa = files.readStanceFa();
  const stanceFaBody = stanceFa ? stanceFa.sections.map(s => s.body).join("") : null;
  const playbook = files.readPlaybook();
  const playbookFa = files.readPlaybookFa();
  const watchlist = files.readWatchlist();
  const preds = files.readPredictions();
  const stats = files.predictionStats(preds);
  const openOrDue = preds.filter(p => p.outcome === null);

  return (
    <div>
      <AutoRefresh seconds={60} />
      <PageHeader title="State" />
      <section className="mb-8">
        <h2 className="mb-2 font-medium">Stance</h2>
        {stance
          ? <LocalizedDocument english={stance} sidecarBody={stanceFaBody}
              locale={locale} messages={messages} />
          : <p className="text-sm text-muted-foreground">no stance yet</p>}
      </section>
      <section className="mb-8">
        <h2 className="mb-2 font-medium">Watchlist</h2>
        <ul className="space-y-1 text-sm">
          {watchlist.length === 0 && <li className="text-muted-foreground">empty</li>}
          {watchlist.map(w => (
            <li key={w.theme}>
              <span className="font-medium">{w.theme}</span>
              <span className="text-muted-foreground"> — {w.why} · since {w.since}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="mb-8">
        <h2 className="mb-2 font-medium">
          Predictions
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {stats.open} open · {stats.maturedUnscored} due · {stats.scored} scored ·
            hit rate {stats.hitRate === null ? "—" : `${Math.round(stats.hitRate * 100)}%`}
          </span>
        </h2>
        <Table>
          <TableHeader><TableRow>
            <TableHead>Claim</TableHead><TableHead>Dir</TableHead><TableHead>Conf</TableHead>
            <TableHead>Horizon</TableHead><TableHead>Made</TableHead><TableHead>Outcome</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {[...openOrDue, ...preds.filter(p => p.outcome !== null)].map(p => (
              <TableRow key={p.id}>
                <TableCell className="max-w-md">{p.claim}</TableCell>
                <TableCell>{p.direction}</TableCell>
                <TableCell>{Math.round(p.confidence * 100)}%</TableCell>
                <TableCell>{p.horizon_days}d</TableCell>
                <TableCell>{fmtAge(p.created_at)}</TableCell>
                <TableCell>
                  {p.outcome
                    ? <Badge variant={p.outcome === "hit" ? "secondary" : p.outcome === "miss" ? "destructive" : "outline"}>{p.outcome}</Badge>
                    : <Badge variant="outline">open</Badge>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
      <section>
        <h2 className="mb-2 font-medium">Playbook</h2>
        {playbook
          ? <LocalizedDocument english={playbook} sidecarBody={playbookFa}
              locale={locale} messages={messages} />
          : <p className="text-sm text-muted-foreground">no playbook yet</p>}
      </section>
    </div>
  );
}
