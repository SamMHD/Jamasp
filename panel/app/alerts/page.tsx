import { cookies } from "next/headers";
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import * as db from "@/lib/db";
import { loadSources, maxRunsPerDay } from "@/lib/files";
import { deriveSourceHealth, deriveWarnings } from "@/lib/health";
import { fmtUtc } from "@/lib/format";
import { getMessages, LANG_COOKIE, resolveLocale, t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

const PERSIAN = /[؀-ۿ]/;

export default async function AlertsPage() {
  const locale = resolveLocale((await cookies()).get(LANG_COOKIE)?.value);
  const messages = getMessages(locale);
  const now = new Date();
  const sinceIso = new Date(now.getTime() - 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const sent = db.getNotifyLog(100);
  const sources = loadSources();
  const health = deriveSourceHealth(
    sources,
    Object.fromEntries(sources.map(s => [s.name, db.getMeta(`source_last_fetch.${s.name}`)])),
    Object.fromEntries(db.lastItemPerSource().map(r => [r.source, r.last])),
    db.getSourceErrors(sinceIso), now);
  const warnings = deriveWarnings({
    lastIngestAt: db.getMeta("last_ingest_at"), runs: db.getAgentRuns(50),
    sourceHealth: health, runsToday: db.runsTodayDubai(now), cap: maxRunsPerDay() }, now);

  return (
    <div>
      <AutoRefresh />
      <PageHeader title={t(messages, "nav.alerts")} />
      <Tabs defaultValue="sent">
        <TabsList>
          <TabsTrigger value="sent">{t(messages, "alerts.tabSent")} ({sent.length})</TabsTrigger>
          <TabsTrigger value="warnings">{t(messages, "alerts.tabWarnings")} ({warnings.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="sent">
          <ul className="mt-4 space-y-3">
            {sent.length === 0 && <li className="text-sm text-muted-foreground">{t(messages, "alerts.nothingSentYet")}</li>}
            {sent.map(m => (
              <li key={m.id} className="rounded border border-border p-3">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  {fmtUtc(m.ts)}
                  {m.ok === 0 && <Badge variant="destructive">{t(messages, "alerts.sendFailed")}</Badge>}
                </div>
                <p dir={PERSIAN.test(m.text) ? "rtl" : "ltr"}
                  className="whitespace-pre-wrap text-sm">
                  {m.text}
                </p>
              </li>
            ))}
          </ul>
        </TabsContent>
        <TabsContent value="warnings">
          <ul className="mt-4 space-y-2">
            {warnings.length === 0 && <li className="text-sm text-up">{t(messages, "alerts.allClear")}</li>}
            {warnings.map((w, i) => (
              <li key={`${i}-${w.severity}`} className={w.severity === "red"
                ? "rounded border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive"
                : "rounded border border-primary/40 bg-primary/5 px-3 py-2 text-sm text-foreground"}>
                {w.text}
              </li>
            ))}
          </ul>
        </TabsContent>
      </Tabs>
    </div>
  );
}
