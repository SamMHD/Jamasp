import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import * as files from "@/lib/files";
import { fmtAge } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function StatePage() {
  const stance = files.readStance();
  const playbook = files.readPlaybook();
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
        {stance ? <Markdown text={stance} /> : <p className="text-sm text-muted-foreground">no stance yet</p>}
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
        {playbook ? <Markdown text={playbook} /> : <p className="text-sm text-muted-foreground">no playbook yet</p>}
      </section>
    </div>
  );
}
