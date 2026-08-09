"use client";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import useSWRInfinite from "swr/infinite";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import type { ItemRow } from "@/lib/db";
import { markInboxRead } from "@/lib/actions";
import { fmtAge, fmtUtc } from "@/lib/format";

const PAGE_SIZE = 50;

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
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const baseQs = new URLSearchParams({
    ...(source && { source }), ...(topic && { topic }), ...(unread && { unread: "1" }),
    ...(search && { q: search }),
  }).toString();

  const getKey = (index: number, prev: { items: ItemRow[] } | null) => {
    if (prev && prev.items.length < PAGE_SIZE) return null; // last page was short: end reached
    return `/api/inbox?${baseQs}&limit=${PAGE_SIZE}&offset=${index * PAGE_SIZE}`;
  };
  const { data, error, mutate, size, setSize } = useSWRInfinite<{ items: ItemRow[] }>(
    getKey, fetcher, { refreshInterval: 30_000 });

  // Flatten, deduping by id: new arrivals shift offsets between page fetches.
  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: ItemRow[] = [];
    for (const page of data ?? []) for (const it of page.items) {
      if (!seen.has(it.id)) { seen.add(it.id); out.push(it); }
    }
    return out;
  }, [data]);

  const hasMore = !!data && data.length > 0 && data[data.length - 1].items.length === PAGE_SIZE;
  const loadingMore = !!data && size > data.length;
  const loadingRef = useRef(false);
  loadingRef.current = loadingMore;

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const obs = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting) && !loadingRef.current) setSize(s => s + 1);
    }, { rootMargin: "400px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, setSize, data]);

  const clusters = new Map<string, ItemRow[]>();
  for (const it of items) {
    const key = it.cluster_id ?? it.id;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key)!.push(it);
  }

  const selectedGroup = selectedKey ? clusters.get(selectedKey) : undefined;
  const selectedRep = selectedGroup
    ? (selectedGroup.find(g => g.id === selectedKey) ?? selectedGroup[0])
    : undefined;
  const selectedOthers = selectedGroup?.filter(g => g.id !== selectedRep!.id) ?? [];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Input value={searchInput} onChange={e => setSearchInput(e.target.value)}
          placeholder="search headlines…" className="h-8 w-56" />
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
                <button type="button" onClick={() => setSelectedKey(key)}
                  className={`text-left ${rep.read_at
                    ? "text-muted-foreground hover:text-foreground"
                    : "font-medium hover:text-primary"}`}>
                  {rep.headline}
                </button>
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
          <li className="text-sm text-muted-foreground">
            {search ? `nothing matches “${search}”` : "nothing here"}
          </li>
        )}
      </ul>
      {hasMore && (
        <div ref={sentinelRef} className="mt-3 flex justify-center">
          <Button size="sm" variant="outline" disabled={loadingMore}
            onClick={() => setSize(s => s + 1)}>
            {loadingMore ? "loading…" : "Load more"}
          </Button>
        </div>
      )}
      {error && (
        <div className="mt-3 rounded border border-destructive p-3 text-sm text-destructive">
          Could not load the inbox: {error.message}
        </div>
      )}
      <Dialog open={!!selectedRep} onOpenChange={open => { if (!open) setSelectedKey(null); }}>
        <DialogContent className="sm:max-w-xl">
          {selectedRep && (
            <>
              <DialogHeader>
                <DialogTitle className="leading-snug">{selectedRep.headline}</DialogTitle>
                {selectedRep.lede && <DialogDescription>{selectedRep.lede}</DialogDescription>}
              </DialogHeader>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">source</dt>
                <dd>{selectedRep.source}</dd>
                <dt className="text-muted-foreground">topic</dt>
                <dd>{selectedRep.topic}</dd>
                <dt className="text-muted-foreground">published</dt>
                <dd>{fmtUtc(selectedRep.published_at)} · {fmtAge(selectedRep.published_at)}</dd>
                <dt className="text-muted-foreground">ingested</dt>
                <dd>{fmtUtc(selectedRep.fetched_at)} · {fmtAge(selectedRep.fetched_at)}</dd>
                <dt className="text-muted-foreground">status</dt>
                <dd>{selectedRep.read_at ? `read ${fmtAge(selectedRep.read_at)}` : "unread"}</dd>
                <dt className="text-muted-foreground">item id</dt>
                <dd className="font-mono text-xs leading-5">{selectedRep.id}</dd>
                <dt className="text-muted-foreground">cluster</dt>
                <dd className="font-mono text-xs leading-5">
                  {selectedRep.cluster_id ?? "—"}
                  {selectedOthers.length > 0 && <span className="font-sans"> · {selectedOthers.length + 1} sources</span>}
                </dd>
                {selectedOthers.length > 0 && (
                  <>
                    <dt className="text-muted-foreground">also covered by</dt>
                    <dd className="space-y-0.5">
                      {selectedOthers.map(o => (
                        <div key={o.id}>
                          <a href={o.url} target="_blank" rel="noreferrer" className="hover:text-primary underline underline-offset-2">
                            {o.source}
                          </a>{" "}
                          <span className="text-muted-foreground">· {fmtAge(o.published_at)}</span>
                        </div>
                      ))}
                    </dd>
                  </>
                )}
                <dt className="text-muted-foreground">url</dt>
                <dd className="break-all text-xs text-muted-foreground">{selectedRep.url}</dd>
              </dl>
              <DialogFooter>
                <Button asChild>
                  <a href={selectedRep.url} target="_blank" rel="noreferrer">Open article ↗</a>
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
