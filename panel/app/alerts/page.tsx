import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import * as db from "@/lib/db";
import { loadSources, maxRunsPerDay } from "@/lib/files";
import { deriveSourceHealth, deriveWarnings } from "@/lib/health";
import { fmtUtc } from "@/lib/format";

export const dynamic = "force-dynamic";

const PERSIAN = /[؀-ۿ]/;

export default function AlertsPage() {
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
      <PageHeader title="Alerts" />
      <Tabs defaultValue="sent">
        <TabsList>
          <TabsTrigger value="sent">Sent ({sent.length})</TabsTrigger>
          <TabsTrigger value="warnings">Warnings ({warnings.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="sent">
          <ul className="mt-4 space-y-3">
            {sent.length === 0 && <li className="text-sm text-muted-foreground">nothing sent yet</li>}
            {sent.map(m => (
              <li key={m.id} className="rounded border border-border p-3">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  {fmtUtc(m.ts)}
                  {m.ok === 0 && <Badge variant="destructive">send failed</Badge>}
                </div>
                <p dir={PERSIAN.test(m.text) ? "rtl" : "ltr"}
                  className="whitespace-pre-wrap text-sm [font-family:Vazirmatn,Tahoma,sans-serif]">
                  {m.text}
                </p>
              </li>
            ))}
          </ul>
        </TabsContent>
        <TabsContent value="warnings">
          <ul className="mt-4 space-y-2">
            {warnings.length === 0 && <li className="text-sm text-emerald-400">all clear</li>}
            {warnings.map((w, i) => (
              <li key={`${i}-${w.severity}`} className={w.severity === "red"
                ? "rounded border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive"
                : "rounded border border-amber-900 bg-amber-950/50 px-3 py-2 text-sm text-amber-300"}>
                {w.text}
              </li>
            ))}
          </ul>
        </TabsContent>
      </Tabs>
    </div>
  );
}
