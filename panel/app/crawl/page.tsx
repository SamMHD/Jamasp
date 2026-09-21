import { cookies } from "next/headers";
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import * as db from "@/lib/db";
import { loadSources } from "@/lib/files";
import { deriveSourceHealth } from "@/lib/health";
import { fmtAge, fmtUtc } from "@/lib/format";
import { getMessages, LANG_COOKIE, resolveLocale, t, type Messages } from "@/lib/i18n";

export const dynamic = "force-dynamic";

const BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> =
  { ok: "secondary", stale: "outline", never: "outline", erroring: "destructive" };

/** `h.state` is the closed set lib/health.ts#deriveSourceHealth defines
 *  (ok/stale/never/erroring) — chrome, same treatment as runType.*. Falls
 *  back to the raw value outside the set, never a raw dictionary key. */
function sourceStateLabel(state: string, messages: Messages): string {
  if (state === "never") return t(messages, "common.never");
  const key = `sourceHealth.${state}`;
  const label = t(messages, key);
  return label !== key ? label : state;
}

export default async function CrawlPage() {
  const locale = resolveLocale((await cookies()).get(LANG_COOKIE)?.value);
  const messages = getMessages(locale);
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
      <PageHeader title={t(messages, "nav.crawl")}
        subtitle={`${sources.length} ${t(messages, "crawl.subtitleSources")} · ${errors.length} ${t(messages, "crawl.subtitleErrors")}`} />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t(messages, "table.source")}</TableHead><TableHead>{t(messages, "table.state")}</TableHead>
            <TableHead>{t(messages, "table.interval")}</TableHead><TableHead>{t(messages, "table.lastFetch")}</TableHead>
            <TableHead>{t(messages, "table.lastItem")}</TableHead><TableHead>{t(messages, "table.errors24h")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {health.map(h => (
            <TableRow key={h.name}>
              <TableCell className="font-medium">{h.name}</TableCell>
              <TableCell><Badge variant={BADGE[h.state]}>{sourceStateLabel(h.state, messages)}</Badge></TableCell>
              <TableCell>{h.intervalMinutes}m</TableCell>
              <TableCell>{h.lastFetch ? fmtAge(h.lastFetch, now) : t(messages, "common.never")}</TableCell>
              <TableCell>{h.lastItem ? fmtAge(h.lastItem, now) : "—"}</TableCell>
              <TableCell>{h.errors24h || ""}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <h2 className="mb-2 mt-8 font-medium">{t(messages, "crawl.recentErrors")}</h2>
      <ul className="space-y-1 text-sm">
        {errors.length === 0 && <li className="text-muted-foreground">{t(messages, "crawl.noneIn24h")}</li>}
        {errors.map((e, i) => (
          <li key={i} className="text-muted-foreground">
            <span className="text-foreground">{e.source}</span> · {fmtUtc(e.ts)} · {e.error}
          </li>
        ))}
      </ul>
    </div>
  );
}
