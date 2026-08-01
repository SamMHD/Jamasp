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

export function getItems(opts: { limit?: number; source?: string; topic?: string;
  unreadOnly?: boolean } = {}): ItemRow[] {
  const cond: string[] = [];
  const args: unknown[] = [];
  if (opts.source) { cond.push("source = ?"); args.push(opts.source); }
  if (opts.topic) { cond.push("topic = ?"); args.push(opts.topic); }
  if (opts.unreadOnly) cond.push("read_at IS NULL");
  const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
  return q(db => db.prepare(
    `SELECT * FROM items ${where} ORDER BY published_at DESC LIMIT ?`
  ).all(...args, opts.limit ?? 200) as ItemRow[]);
}

export function getItemFilters(): { sources: string[]; topics: string[] } {
  return q(db => ({
    sources: (db.prepare("SELECT DISTINCT source FROM items ORDER BY source").all() as
      { source: string }[]).map(r => r.source),
    topics: (db.prepare("SELECT DISTINCT topic FROM items ORDER BY topic").all() as
      { topic: string }[]).map(r => r.topic),
  }));
}

export function getWakeups(status?: string): WakeupRow[] {
  return q(db => (status
    ? db.prepare("SELECT * FROM wakeups WHERE status = ? ORDER BY due_at").all(status)
    : db.prepare("SELECT * FROM wakeups ORDER BY due_at DESC").all()) as WakeupRow[]);
}

export function getAgentRuns(limit: number): AgentRunRow[] {
  return q(db => db.prepare(
    "SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?").all(limit) as AgentRunRow[]);
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
