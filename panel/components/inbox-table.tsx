"use client";
import { useState, useTransition } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ItemRow } from "@/lib/db";
import { markInboxRead } from "@/lib/actions";
import { fmtAge } from "@/lib/format";

const fetcher = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`GET ${url} failed: ${r.status} ${r.statusText}${body ? ` — ${body}` : ""}`);
  }
  return r.json();
};

export function InboxTable({ sources, topics }: { sources: string[]; topics: string[] }) {
  const [source, setSource] = useState("");
  const [topic, setTopic] = useState("");
  const [unread, setUnread] = useState(true);
  const [pending, startTransition] = useTransition();
  const qs = new URLSearchParams({
    ...(source && { source }), ...(topic && { topic }), ...(unread && { unread: "1" }),
  }).toString();
  const { data, error, mutate } = useSWR<{ items: ItemRow[] }>(`/api/inbox?${qs}`, fetcher,
    { refreshInterval: 30_000 });

  const items = data?.items ?? [];
  const clusters = new Map<string, ItemRow[]>();
  for (const it of items) {
    const key = it.cluster_id ?? it.id;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key)!.push(it);
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <select value={source} onChange={e => setSource(e.target.value)}
          className="rounded border border-border bg-background px-2 py-1">
          <option value="">all sources</option>
          {sources.map(s => <option key={s}>{s}</option>)}
        </select>
        <select value={topic} onChange={e => setTopic(e.target.value)}
          className="rounded border border-border bg-background px-2 py-1">
          <option value="">all topics</option>
          {topics.map(t => <option key={t}>{t}</option>)}
        </select>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={unread} onChange={e => setUnread(e.target.checked)} />
          unread only
        </label>
        <Button size="sm" variant="outline" disabled={pending}
          onClick={() => startTransition(async () => {
            const r = await markInboxRead();
            if (r.ok) toast.success(r.message); else toast.error(r.message);
            mutate();
          })}>
          Mark delta read
        </Button>
      </div>
      <ul className="space-y-3">
        {[...clusters.entries()].map(([key, group]) => {
          const rep = group.find(g => g.id === key) ?? group[0];
          const others = group.filter(g => g.id !== rep.id);
          return (
            <li key={key} className="rounded border border-border p-3">
              <div className="flex items-start justify-between gap-2">
                <a href={rep.url} target="_blank" rel="noreferrer"
                  className={rep.read_at ? "text-muted-foreground" : "font-medium hover:text-primary"}>
                  {rep.headline}
                </a>
                {!rep.read_at && <Badge>unread</Badge>}
              </div>
              {rep.lede && <p className="mt-1 text-sm text-muted-foreground">{rep.lede}</p>}
              <div className="mt-1 text-xs text-muted-foreground">
                {rep.source} · {rep.topic} · {fmtAge(rep.published_at)}
                {others.length > 0 && <> · also: {others.map(o => o.source).join(", ")}</>}
              </div>
            </li>
          );
        })}
        {!error && items.length === 0 && (
          <li className="text-sm text-muted-foreground">nothing here</li>
        )}
      </ul>
      {error && (
        <div className="mt-3 rounded border border-destructive p-3 text-sm text-destructive">
          Could not load the inbox: {error.message}
        </div>
      )}
    </div>
  );
}
