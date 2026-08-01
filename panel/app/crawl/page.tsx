import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import * as db from "@/lib/db";
import { loadSources } from "@/lib/files";
import { deriveSourceHealth } from "@/lib/health";
import { fmtAge, fmtUtc } from "@/lib/format";

export const dynamic = "force-dynamic";

const BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> =
  { ok: "secondary", stale: "outline", never: "outline", erroring: "destructive" };

export default function CrawlPage() {
  const now = new Date();
  const sinceIso = new Date(now.getTime() - 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const sources = loadSources();
  const errors = db.getSourceErrors(sinceIso);
  const health = deriveSourceHealth(
    sources,
    Object.fromEntries(sources.map(s => [s.name, db.getMeta(`source_last_fetch.${s.name}`)])),
    Object.fromEntries(db.lastItemPerSource().map(r => [r.source, r.last])),
    errors, now);

  return (
    <div>
      <AutoRefresh />
      <PageHeader title="Crawl" subtitle={`${sources.length} sources · ${errors.length} errors in 24h`} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Source</TableHead><TableHead>State</TableHead>
            <TableHead>Interval</TableHead><TableHead>Last fetch</TableHead>
            <TableHead>Last item</TableHead><TableHead>Errors 24h</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {health.map(h => (
            <TableRow key={h.name}>
              <TableCell className="font-medium">{h.name}</TableCell>
              <TableCell><Badge variant={BADGE[h.state]}>{h.state}</Badge></TableCell>
              <TableCell>{h.intervalMinutes}m</TableCell>
              <TableCell>{h.lastFetch ? fmtAge(h.lastFetch, now) : "never"}</TableCell>
              <TableCell>{h.lastItem ? fmtAge(h.lastItem, now) : "—"}</TableCell>
              <TableCell>{h.errors24h || ""}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <h2 className="mb-2 mt-8 font-medium">Recent source errors</h2>
      <ul className="space-y-1 text-sm">
        {errors.length === 0 && <li className="text-muted-foreground">none in 24h</li>}
        {errors.map((e, i) => (
          <li key={i} className="text-muted-foreground">
            <span className="text-foreground">{e.source}</span> · {fmtUtc(e.ts)} · {e.error}
          </li>
        ))}
      </ul>
    </div>
  );
}
