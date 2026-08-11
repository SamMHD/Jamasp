import Database from "better-sqlite3";
import { DB_PATH } from "./paths";

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
