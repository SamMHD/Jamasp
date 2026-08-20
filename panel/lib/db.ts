import Database from "better-sqlite3";
import { DB_PATH } from "./paths";
import type { ScoredItem } from "./marketmap";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) _db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  return _db;
}

/** One retry on SQLITE_BUSY; the CLI writers hold short transactions. */
function q<T>(fn: (db: Database.Database) => T): T {
  try {
    return fn(getDb());
  } catch (e: unknown) {
    if ((e as { code?: string }).code?.startsWith("SQLITE_BUSY")) return fn(getDb());
    throw e;
  }
}

/**
 * A freshly deployed host has no `item_scores` table until the first CLI
 * scoring run creates it — the panel must keep serving through that window
 * rather than 500ing, so callers that read item_scores check for it first
 * rather than relying on q() to paper over the error: q() only retries
 * SQLITE_BUSY and deliberately rethrows everything else, including
 * "no such table", which is a real bug everywhere else in this file.
 */
function hasTable(db: Database.Database, name: string): boolean {
  return db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name) !== undefined;
}

// ---- types (exactly as in the Interfaces block above) ----
export type ItemRow = { id: string; source: string; published_at: string; headline: string;
  lede: string | null; url: string; topic: string; cluster_id: string | null;
  fetched_at: string; read_at: string | null };
export type WakeupRow = { id: number; due_at: string; run_type: string; task: string;
  status: string; attempts: number; created_at: string; fired_at: string | null };
export type AgentRunRow = { id: number; run_type: string; task: string | null;
  started_at: string; finished_at: string | null; exit_code: number | null; status: string };
export type EventRow = { id: string; source: string; title: string; country: string | null;
  impact: string | null; starts_at: string; fetched_at: string };
export type SourceErrorRow = { source: string; ts: string; error: string };
export type NotifyLogRow = { id: number; ts: string; text: string; ok: number };
export type PricePoint = { ts: string; value: number };
export type PriceSnapshot = { symbol: string; ts: string; value: number;
  delta24h: number | null; delta7d: number | null };

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export function getMeta(key: string): string | null {
  return q(db => (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    { value: string } | undefined)?.value ?? null);
}

export function getUnreadCount(): number {
  return q(db => (db.prepare(
    "SELECT COUNT(*) c FROM items WHERE read_at IS NULL AND (cluster_id = id OR cluster_id IS NULL)"
  ).get() as { c: number }).c);
}

export function getItems(opts?: { limit?: number; offset?: number; source?: string;
  topic?: string; unreadOnly?: boolean; search?: string }): ItemRow[] {
  const o = opts ?? {};
  const cond: string[] = [];
  const args: unknown[] = [];
  if (o.source) { cond.push("source = ?"); args.push(o.source); }
  if (o.topic) { cond.push("topic = ?"); args.push(o.topic); }
  if (o.unreadOnly) cond.push("read_at IS NULL");
  if (o.search) {
    const like = `%${o.search.replace(/[\\%_]/g, m => `\\${m}`)}%`;
    cond.push("(headline LIKE ? ESCAPE '\\' OR lede LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
  return q(db => db.prepare(
    `SELECT * FROM items ${where} ORDER BY published_at DESC LIMIT ? OFFSET ?`
  ).all(...args, o.limit ?? 200, o.offset ?? 0) as ItemRow[]);
}

/** Newest published_at across all items; null on an empty table. */
export function newestItemTs(): string | null {
  return q(db => (db.prepare("SELECT MAX(published_at) ts FROM items").get() as
    { ts: string | null }).ts);
}

/**
 * Item counts per UTC day per topic, aggregated in SQL — the overview's
 * news-volume chart must not pull two weeks of full rows to count them.
 */
export function itemVolumeByDay(sinceIso: string): { day: string; topic: string; n: number }[] {
  return q(db => db.prepare(
    `SELECT substr(published_at, 1, 10) day, topic, COUNT(*) n
     FROM items WHERE published_at >= ? GROUP BY day, topic ORDER BY day`
  ).all(sinceIso) as { day: string; topic: string; n: number }[]);
}

export type ClusterHeadRow = ItemRow & { sources_n: number };

/**
 * Newest cluster representatives with the number of distinct sources
 * carrying each story. The head convention matches getUnreadCount:
 * `cluster_id = id` marks the representative, NULL means unclustered
 * (counted as its own single source — the subquery would otherwise return
 * 0 for NULL and claim a sourceless story).
 */
export function getClusterHeads(limit: number): ClusterHeadRow[] {
  return q(db => db.prepare(
    `SELECT i.*, CASE WHEN i.cluster_id IS NULL THEN 1 ELSE
       (SELECT COUNT(DISTINCT c.source) FROM items c WHERE c.cluster_id = i.cluster_id)
     END AS sources_n
     FROM items i WHERE i.cluster_id = i.id OR i.cluster_id IS NULL
     ORDER BY i.published_at DESC LIMIT ?`
  ).all(limit) as ClusterHeadRow[]);
}

/**
 * The story most sources carried since the cutoff — a story on four wires
 * is a different signal from a story on one, so a single-source cluster
 * never qualifies (HAVING >= 2). Ties break toward the larger cluster.
 * The representative row is fetched by the head convention (id =
 * cluster_id) and can predate the cutoff: a story that broke earlier but
 * is still being picked up is still the top story.
 */
export function topStory(sinceIso: string):
  { item: ItemRow; sources: number; items: number } | null {
  return q(db => {
    const top = db.prepare(
      `SELECT cluster_id, COUNT(DISTINCT source) sources_n, COUNT(*) items_n
       FROM items WHERE published_at >= ? AND cluster_id IS NOT NULL
       GROUP BY cluster_id HAVING COUNT(DISTINCT source) >= 2
       ORDER BY sources_n DESC, items_n DESC, cluster_id LIMIT 1`
    ).get(sinceIso) as { cluster_id: string; sources_n: number; items_n: number } | undefined;
    if (!top) return null;
    const item = db.prepare("SELECT * FROM items WHERE id = ?")
      .get(top.cluster_id) as ItemRow | undefined;
    if (!item) return null;
    return { item, sources: top.sources_n, items: top.items_n };
  });
}

export function getItemFilters(): { sources: string[]; topics: string[] } {
  return q(db => ({
    sources: (db.prepare("SELECT DISTINCT source FROM items ORDER BY source").all() as
      { source: string }[]).map(r => r.source),
    topics: (db.prepare("SELECT DISTINCT topic FROM items ORDER BY topic").all() as
      { topic: string }[]).map(r => r.topic),
  }));
}

/**
 * Ordering depends on whether `status` is passed:
 *  - filtered by status: ascending by due_at (soonest-due first — for "what's next").
 *  - unfiltered: descending by due_at (newest first — for the wakeup history view).
 */
export function getWakeups(status?: string): WakeupRow[] {
  return q(db => (status
    ? db.prepare("SELECT * FROM wakeups WHERE status = ? ORDER BY due_at").all(status)
    : db.prepare("SELECT * FROM wakeups ORDER BY due_at DESC").all()) as WakeupRow[]);
}

export function getAgentRuns(limit: number): AgentRunRow[] {
  return q(db => db.prepare(
    "SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?").all(limit) as AgentRunRow[]);
}

/**
 * Most recent run per `run_type`, regardless of how far back it falls —
 * unlike `getAgentRuns(N)`, which is a fixed-size window that can silently
 * drop infrequent run types (retro runs weekly; at ~13 runs/day, 50 rows
 * is under four days, so a plain `.find()` over that window would wrongly
 * report retro as "never run" for roughly half of every week).
 */
export function lastRunPerType(): AgentRunRow[] {
  return q(db => db.prepare(
    `SELECT a.* FROM agent_runs a
     WHERE a.id = (
       SELECT b.id FROM agent_runs b
       WHERE b.run_type = a.run_type
       ORDER BY b.started_at DESC, b.id DESC
       LIMIT 1
     )`
  ).all() as AgentRunRow[]);
}

export function runsTodayDubai(now: Date = new Date()): number {
  const dubaiDay = new Date(now.getTime() + 4 * 3600_000).toISOString().slice(0, 10);
  return q(db => (db.prepare("SELECT started_at FROM agent_runs WHERE status != 'deferred'")
    .all() as { started_at: string }[])
    .filter(r => new Date(new Date(r.started_at).getTime() + 4 * 3600_000)
      .toISOString().slice(0, 10) === dubaiDay).length);
}

export function getEvents(daysAhead: number, now: Date = new Date()): EventRow[] {
  const until = iso(new Date(now.getTime() + daysAhead * 86400_000));
  return q(db => db.prepare(
    "SELECT * FROM events WHERE starts_at >= ? AND starts_at <= ? ORDER BY starts_at"
  ).all(iso(now), until) as EventRow[]);
}

export function getSourceErrors(sinceIso: string): SourceErrorRow[] {
  return q(db => db.prepare(
    "SELECT * FROM source_errors WHERE ts >= ? ORDER BY ts DESC").all(sinceIso) as SourceErrorRow[]);
}

export function lastItemPerSource(): { source: string; last: string }[] {
  return q(db => db.prepare(
    "SELECT source, MAX(fetched_at) last FROM items GROUP BY source"
  ).all() as { source: string; last: string }[]);
}

export function getNotifyLog(limit: number): NotifyLogRow[] {
  return q(db => db.prepare(
    "SELECT * FROM notify_log ORDER BY id DESC LIMIT ?").all(limit) as NotifyLogRow[]);
}

function priceAtOrBefore(db: Database.Database, symbol: string, ts: string): number | null {
  const r = db.prepare(
    "SELECT value FROM prices WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 1"
  ).get(symbol, ts) as { value: number } | undefined;
  return r?.value ?? null;
}

export function getPriceSnapshots(now: Date = new Date()): PriceSnapshot[] {
  return q(db => {
    const symbols = (db.prepare("SELECT DISTINCT symbol FROM prices ORDER BY symbol").all() as
      { symbol: string }[]).map(r => r.symbol);
    return symbols.map(symbol => {
      const latest = db.prepare(
        "SELECT ts, value FROM prices WHERE symbol = ? ORDER BY ts DESC LIMIT 1"
      ).get(symbol) as { ts: string; value: number };
      const v24 = priceAtOrBefore(db, symbol, iso(new Date(now.getTime() - 86400_000)));
      const v7d = priceAtOrBefore(db, symbol, iso(new Date(now.getTime() - 7 * 86400_000)));
      return { symbol, ts: latest.ts, value: latest.value,
        delta24h: v24 === null ? null : latest.value - v24,
        delta7d: v7d === null ? null : latest.value - v7d };
    });
  });
}

export function getPriceSeries(symbol: string, sinceIso: string): PricePoint[] {
  return q(db => db.prepare(
    "SELECT ts, value FROM prices WHERE symbol = ? AND ts >= ? ORDER BY ts"
  ).all(symbol, sinceIso) as PricePoint[]);
}

/**
 * Newest row per symbol in one query. The overview needs nine series at
 * once (spot, two SMAs, two pivots, RSI, ATR, GVZ, net spec); nine separate
 * `latest()` round trips is the shape this avoids. Symbols with no rows are
 * absent from the result rather than mapped to null.
 */
export function latestPrices(symbols: string[]): Record<string, { ts: string; value: number }> {
  if (symbols.length === 0) return {};
  const placeholders = symbols.map(() => "?").join(",");
  return q(db => {
    const rows = db.prepare(
      `SELECT p.symbol, p.ts, p.value FROM prices p
       WHERE p.symbol IN (${placeholders})
         AND p.ts = (SELECT MAX(b.ts) FROM prices b WHERE b.symbol = p.symbol)`
    ).all(...symbols) as { symbol: string; ts: string; value: number }[];
    return Object.fromEntries(rows.map(r => [r.symbol, { ts: r.ts, value: r.value }]));
  });
}

/**
 * The value a delta should be measured *against*: the newest row at or before
 * `ts`, but only when that row is a different observation from the latest one
 * (`latestTs`). Null otherwise — no reference exists.
 *
 * At-or-before, never at-or-after: gold has overnight and weekend gaps, so
 * the first row *after* a cutoff can sit hours away and would silently skew
 * a 24h delta. This matches jamasp/ingest/prices.py#row_at_or_before.
 *
 * The `ts >= latestTs` rejection is the other half, and it is why this is a
 * delta-reference lookup rather than a bare row lookup. When a series has
 * not printed since the cutoff, the newest row at or before the cutoff *is*
 * the latest row, so subtracting the two fabricates a confident "unchanged,
 * 0.00%". That is not exotic: COMEX gold closes Friday ~21:00Z and reopens
 * Sunday ~23:00Z, and parse_yahoo_chart_json stamps rows with the market bar
 * timestamp rather than fetch time, so from Saturday ~21:00Z the 24h cutoff
 * falls before Friday's last bar for roughly 26 hours every weekend. The
 * guard is jamasp/pricesummary.py#_delta's, which prints "n/a" in exactly
 * this case — the panel's 24h change must be computed the same way the
 * Telegram brief computes it, and a null here renders as "24h —".
 */
export function priceDeltaReference(
  symbol: string, ts: string, latestTs: string,
): number | null {
  return q(db => {
    const r = db.prepare(
      "SELECT ts, value FROM prices WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 1"
    ).get(symbol, ts) as { ts: string; value: number } | undefined;
    if (r === undefined || r.ts >= latestTs) return null;
    return r.value;
  });
}

/**
 * Scored news for the fundamental map, with both coverage guards applied.
 *
 * Guard 1 — collapse on URL. rss.item_id() hashes (source, url, headline),
 * so a publisher rewriting a live article's headline mints a new item for a
 * URL already seen (docs/todo/002). On a treemap that is arithmetic, not
 * cosmetics: six tiles for one story is six times the area in its theme.
 * Highest tier wins, because the strongest read of a story is the one the
 * desk should see. Among rows tied on tier, newest `published_at` wins, and
 * `itemId` breaks any remaining tie — an explicit, stable rule rather than
 * whatever order SQLite happens to visit rows in.
 *
 * The collapse MUST be computed over the same filtered set the outer query
 * returns (window + date floor), not over the whole table. An earlier
 * version picked the winner with a correlated subquery —
 * `s.tier = (SELECT MAX(s2.tier) ... WHERE i2.url = i.url)` — with no window
 * or date-floor clause of its own. That subquery could pick a winning tier
 * that lives *outside* the window (or behind the date floor): the in-window
 * row then fails `s.tier = <that max>` and gets dropped, while the
 * out-of-window sibling is dropped by the outer WHERE — net result, zero
 * rows for a story that plainly has a legitimate in-window score. It fails
 * silently: the item is neither returned nor counted as unscored, so the
 * coverage footer's scored/unscored no longer sum to the true candidate
 * count. Do not reintroduce that shape. Instead: filter first (the
 * `windowed` CTE), THEN rank and collapse only within that already-filtered
 * set (the `ROW_NUMBER() ... PARTITION BY url` below). See
 * test/db-marketmap.test.ts for fixtures that straddle exactly this
 * boundary and fail against the correlated-subquery form.
 *
 * Guard 2 — reject implausible dates. Feeds carrying a raw Unix epoch had it
 * parsed as a year before #16, so "1786971720" became 1786-08-01. Those rows
 * would silently fall outside every window; excluding them explicitly means
 * the coverage count can state how many were dropped. This filter lives
 * inside the `windowed` CTE for the same reason guard 1 must — the collapse
 * has to rank over rows that have already been date-floored, not the raw
 * table.
 *
 * Collapsing happens on read, never on write: item_scores keeps one row per
 * item, and folding on the way in would destroy information that cannot be
 * recovered.
 *
 * Guard 3 — a freshly deployed host has no item_scores table until the
 * first CLI scoring run creates it. Returns an empty array rather than
 * throwing, so the panel keeps rendering (with its existing "no scored
 * stories" empty state) through that window instead of taking the whole
 * overview page down with it.
 */
export function getScoredItems(sinceIso: string): ScoredItem[] {
  return q(db => {
    if (!hasTable(db, "item_scores")) return [];
    return db.prepare(`
      WITH windowed AS (
        SELECT s.item_id AS itemId, s.tier, s.direction, s.conviction, s.theme,
               i.headline, i.source, i.url, i.published_at AS publishedAt
          FROM item_scores s JOIN items i ON i.id = s.item_id
         WHERE i.published_at >= ? AND i.published_at >= '2000-01-01T00:00:00Z'
      )
      SELECT itemId, tier, direction, conviction, theme, headline, source, url, publishedAt
        FROM (SELECT *, ROW_NUMBER() OVER (
                PARTITION BY url ORDER BY tier DESC, publishedAt DESC, itemId
              ) AS rn FROM windowed)
       WHERE rn = 1
       ORDER BY publishedAt DESC
    `).all(sinceIso) as ScoredItem[];
  });
}

/**
 * Count of items in the window with no `item_scores` row, collapsed by URL
 * the same way getScoredItems collapses its own rows — a story scored under
 * one of several URL-duplicate ids must not double-count as both scored and
 * unscored (see getScoredItems's guard-1 comment for why duplicate ids
 * happen at all). This is the map's coverage footer: "N scored, M unscored
 * not shown".
 *
 * Same missing-table guard as getScoredItems: 0 rather than a thrown error
 * when item_scores does not exist yet.
 */
export function unscoredCountSince(sinceIso: string): number {
  return q(db => {
    if (!hasTable(db, "item_scores")) return 0;
    return (db.prepare(`
      SELECT COUNT(DISTINCT i.url) c
        FROM items i
       WHERE i.published_at >= ?
         AND NOT EXISTS (
               SELECT 1 FROM item_scores s
                 JOIN items i2 ON i2.id = s.item_id
                WHERE i2.url = i.url)
    `).get(sinceIso) as { c: number }).c;
  });
}
