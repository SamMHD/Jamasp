import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { CONFIG_DIR, REPORTS_DIR, STATE_DIR } from "./paths";

export type WatchlistEntry = { theme: string; why: string; since: string };
export type Prediction = { id: string; date: string; claim: string; direction: string;
  horizon_days: number; confidence: number; created_at: string;
  outcome: string | null; scored_at: string | null; note: string | null };
export type PredictionStats = { open: number; maturedUnscored: number; scored: number;
  hits: number; misses: number; unclear: number; hitRate: number | null };
export type SourceConfig = { name: string; type: string; url: string;
  interval_minutes: number; topic?: string };
export type ReportMeta = { slug: string; date: string };

function readText(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function readStance(): string | null {
  return readText(path.join(STATE_DIR, "stance.md"));
}

export function readPlaybook(): string | null {
  return readText(path.join(STATE_DIR, "playbook.md"));
}

export function readWatchlist(): WatchlistEntry[] {
  const raw = readText(path.join(STATE_DIR, "watchlist.yaml"));
  if (!raw) return [];
  const doc = YAML.parse(raw) as { watchlist?: unknown[] } | null;
  return (doc?.watchlist ?? []).map(e => {
    const r = e as Record<string, unknown>;
    return { theme: String(r.theme ?? ""), why: String(r.why ?? ""),
      since: String(r.since ?? "") };
  });
}

export function readPredictions(): Prediction[] {
  const raw = readText(path.join(STATE_DIR, "predictions.jsonl"));
  if (!raw) return [];
  const out: Prediction[] = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as Prediction);
    } catch {
      // skip malformed/truncated lines (e.g. an interrupted append)
    }
  }
  return out;
}

export function predictionStats(preds: Prediction[], now: Date = new Date()): PredictionStats {
  let open = 0, maturedUnscored = 0, hits = 0, misses = 0, unclear = 0;
  for (const p of preds) {
    if (p.outcome === "hit") hits++;
    else if (p.outcome === "miss") misses++;
    else if (p.outcome === "unclear") unclear++;
    else {
      const matures = new Date(p.created_at).getTime() + p.horizon_days * 86400_000;
      if (matures <= now.getTime()) maturedUnscored++;
      else open++;
    }
  }
  const decisive = hits + misses;
  return { open, maturedUnscored, scored: hits + misses + unclear, hits, misses,
    unclear, hitRate: decisive ? hits / decisive : null };
}

export function loadSources(): SourceConfig[] {
  const raw = readText(path.join(CONFIG_DIR, "sources.yaml"));
  if (!raw) return [];
  const doc = YAML.parse(raw) as { sources?: SourceConfig[] } | null;
  return doc?.sources ?? [];
}

export function loadSettings(): Record<string, unknown> {
  const raw = readText(path.join(CONFIG_DIR, "settings.yaml"));
  if (!raw) return {};
  const parsed = YAML.parse(raw);
  return (parsed ?? {}) as Record<string, unknown>;
}

export function maxRunsPerDay(): number {
  const runs = loadSettings().runs as { max_agent_runs_per_day?: number } | undefined;
  return runs?.max_agent_runs_per_day ?? 20;
}

export function listReports(): ReportMeta[] {
  if (!existsSync(REPORTS_DIR)) return [];
  const out: ReportMeta[] = [];
  for (const year of readdirSync(REPORTS_DIR)) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const month of readdirSync(path.join(REPORTS_DIR, year))) {
      if (!/^\d{2}$/.test(month)) continue;
      for (const f of readdirSync(path.join(REPORTS_DIR, year, month))) {
        if (!f.endsWith(".md")) continue;
        out.push({ slug: `${year}/${month}/${f.replace(/\.md$/, "")}`,
          date: f.slice(0, 10) });
      }
    }
  }
  return out.sort((a, b) => b.slug.localeCompare(a.slug));
}

export function readReport(slug: string): string | null {
  const p = path.resolve(REPORTS_DIR, `${slug}.md`);
  if (!p.startsWith(path.resolve(REPORTS_DIR) + path.sep)) return null; // traversal guard
  return readText(p);
}
