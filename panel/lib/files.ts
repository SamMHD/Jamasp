import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { CONFIG_DIR, REPORTS_DIR, STATE_DIR } from "./paths";
import { predictionState } from "./predictions";
import type { FittedCoefficient, FittedWeights, WeightsConfig } from "@/lib/technicalmap";

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

/**
 * Counted through lib/predictions.ts#predictionState rather than with its own
 * copy of the branch: the Forecast-record card (these counts) and the
 * /predictions page (the same classifier, per row) must never be able to
 * disagree about how many predictions are open, due or scored.
 */
export function predictionStats(preds: Prediction[], now: Date = new Date()): PredictionStats {
  const n = { due: 0, open: 0, hit: 0, miss: 0, unclear: 0 };
  for (const p of preds) n[predictionState(p, now)]++;
  const decisive = n.hit + n.miss;
  return { open: n.open, maturedUnscored: n.due, scored: n.hit + n.miss + n.unclear,
    hits: n.hit, misses: n.miss, unclear: n.unclear,
    hitRate: decisive ? n.hit / decisive : null };
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

/**
 * Persian sidecars, mirroring jamasp/translatetext.py.
 *
 * The translate job writes these beside the English documents it reads —
 * never in them — so `jamasp predictions add`'s append, the agent's
 * freehand rewrite of stance.md, and this 10-minute timer never race the
 * same file. Every reader here re-derives its own verdict on whether a
 * sidecar is usable rather than trusting the job's last run: a sidecar is
 * only as current as the hash it carries, checked against the English
 * source *now*, at read time — a stale sidecar is treated as no sidecar,
 * because better English than confidently wrong Persian.
 */

const FRONT_MATTER_FENCE = "---";

/**
 * Split a sidecar into (meta, body) — the TypeScript twin of
 * jamasp/translatetext.py's `parse_front_matter`, byte-for-byte, because a
 * reader that disagreed with the writer about where the front matter ends
 * would misread every sidecar on disk.
 *
 * Front matter is recognised ONLY when `---\n` opens the very first line. A
 * file that merely contains a `---` somewhere is a body, not a sidecar with
 * metadata — treating it as one would invent a hash that never matches.
 */
function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  if (!text.startsWith(`${FRONT_MATTER_FENCE}\n`)) return { meta: {}, body: text };
  const end = text.indexOf(`\n${FRONT_MATTER_FENCE}\n`, FRONT_MATTER_FENCE.length);
  if (end === -1) return { meta: {}, body: text };
  const block = text.slice(FRONT_MATTER_FENCE.length + 1, end);
  const meta: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: text.slice(end + FRONT_MATTER_FENCE.length + 2) };
}

/** sha256 hex of the English source's exact bytes — what src_hash records. */
function srcHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Lines with their line-ending kept, the way Python's `str.splitlines
 * (keepends=True)` does for "\n"-only text — which is all `write_atomic`
 * ever produces. A trailing newline yields no trailing empty element.
 */
function keependsLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/**
 * Split at `## ` headings into [(heading_line, body)] — the TypeScript
 * twin of translatetext.py's `split_sections`. Position 0 always carries
 * the empty heading for whatever precedes the first `## ` line (the
 * preamble, H1 included), so a document's lead is never silently dropped.
 */
function splitMarkdownSections(markdown: string): { heading: string; body: string }[] {
  const sections: { heading: string; body: string }[] = [];
  let heading = "";
  let body: string[] = [];
  for (const line of keependsLines(markdown)) {
    if (line.startsWith("## ")) {
      sections.push({ heading, body: body.join("") });
      heading = line.replace(/\n$/, "");
      body = [];
    } else {
      body.push(line);
    }
  }
  sections.push({ heading, body: body.join("") });
  return sections;
}

const SECTION_HASH_PREFIX = "<!-- src_hash: ";

export type StanceFaSection = { heading: string; hash: string; body: string };

/**
 * The inverse of translatetext.py's `render_stance_sidecar`. A section
 * whose comment line is missing or malformed is skipped — matching the
 * writer, which never emits one without it — but a section whose hash is
 * merely EMPTY is kept: see readStanceFa's doc comment for why that
 * distinction is load-bearing.
 */
function parseStanceSidecar(text: string): StanceFaSection[] {
  const { body } = parseFrontMatter(text);
  if (!body.trim()) return [];
  const out: StanceFaSection[] = [];
  for (const { heading, body: chunk } of splitMarkdownSections(body)) {
    const lines = keependsLines(chunk);
    if (lines.length === 0 || !lines[0].startsWith(SECTION_HASH_PREFIX)) continue;
    const hash = lines[0].slice(SECTION_HASH_PREFIX.length).split(" -->")[0].trim();
    out.push({ heading, hash, body: lines.slice(1).join("") });
  }
  return out;
}

/**
 * `state/stance.fa.md`, section bodies in source order.
 *
 * The front-matter `src_hash` covers the WHOLE English file; a mismatch —
 * sidecar absent, stale, or front-matter-less — discards the sidecar
 * entirely and this returns null, same as every other reader here.
 *
 * A section can still carry its ENGLISH body under an EMPTY per-section
 * hash even when the file as a whole is returned: a failed or
 * budget-skipped section with no prior Persian to keep (see
 * jamasp/translate.py#translate_stance). That section is returned here
 * exactly as found — empty hash, English body, same array position — never
 * dropped. Dropping it would shift every later section under the wrong
 * heading, because the caller matches sections to the English structure by
 * order, not by heading text. The caller is what turns `hash === ""` into
 * an English-with-marker render via SourceLang; this function only carries
 * the fact forward.
 */
export function readStanceFa(): { sections: StanceFaSection[] } | null {
  const english = readText(path.join(STATE_DIR, "stance.md"));
  if (english === null) return null;
  const raw = readText(path.join(STATE_DIR, "stance.fa.md"));
  if (raw === null) return null;
  const { meta } = parseFrontMatter(raw);
  if (meta.src_hash !== srcHash(english)) return null;
  return { sections: parseStanceSidecar(raw) };
}

/** One whole-document sidecar: front matter stripped, body returned as-is. */
function readWholeDocumentFa(englishPath: string, sidecarPath: string): string | null {
  const english = readText(englishPath);
  if (english === null) return null;
  const raw = readText(sidecarPath);
  if (raw === null) return null;
  const { meta, body } = parseFrontMatter(raw);
  if (meta.src_hash !== srcHash(english)) return null;
  return body;
}

/** `state/playbook.fa.md` — the whole document, nothing parsed out of it. */
export function readPlaybookFa(): string | null {
  return readWholeDocumentFa(
    path.join(STATE_DIR, "playbook.md"), path.join(STATE_DIR, "playbook.fa.md"));
}

/**
 * `state/watchlist.fa.yaml` — Persian `why` keyed by theme.
 *
 * No front matter here (see jamasp/translate.py#translate_watchlist): each
 * entry carries its own `src_hash` of the English `why` it translates, so
 * staleness is judged per theme rather than for the file as a whole. A
 * theme absent from the sidecar, or whose hash no longer matches the
 * theme's current `why` in watchlist.yaml, is simply missing from the
 * returned map — there is no "fallback to English" marker to raise here,
 * unlike the document readers, because the caller already has the English
 * `why` from readWatchlist() and can run it through `localized()` itself.
 */
export function readWatchlistFa(): Record<string, string> {
  const raw = readText(path.join(STATE_DIR, "watchlist.fa.yaml"));
  if (!raw) return {};
  const englishRaw = readText(path.join(STATE_DIR, "watchlist.yaml"));
  const englishWhy = new Map<string, string>();
  const englishDoc = englishRaw
    ? (YAML.parse(englishRaw) as { watchlist?: Record<string, unknown>[] } | null) : null;
  for (const e of englishDoc?.watchlist ?? []) {
    if (typeof e.theme === "string") englishWhy.set(e.theme, String(e.why ?? ""));
  }

  const doc = YAML.parse(raw) as { watchlist?: Record<string, unknown>[] } | null;
  const out: Record<string, string> = {};
  for (const e of doc?.watchlist ?? []) {
    const theme = e.theme;
    const whyFa = e.why_fa;
    if (typeof theme !== "string" || typeof whyFa !== "string" || !whyFa.trim()) continue;
    const english = englishWhy.get(theme);
    if (english === undefined || e.src_hash !== srcHash(english)) continue;
    out[theme] = whyFa;
  }
  return out;
}

/**
 * `state/predictions.fa.jsonl` — Persian `claim` keyed by prediction id.
 *
 * Same per-entry shape as readWatchlistFa, for the same reason: predictions
 * are appended to by `jamasp predictions add`, so the sidecar hashes each
 * `claim` on its own rather than the file as a whole.
 */
export function readPredictionsFa(): Record<string, string> {
  const raw = readText(path.join(STATE_DIR, "predictions.fa.jsonl"));
  if (!raw) return {};
  const englishRaw = readText(path.join(STATE_DIR, "predictions.jsonl"));
  const englishClaim = new Map<string, string>();
  for (const line of (englishRaw ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (typeof row.id === "string") englishClaim.set(row.id, String(row.claim ?? ""));
    } catch {
      // an interrupted append; readPredictions() skips it too
    }
  }

  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = row.id;
    const claimFa = row.claim_fa;
    if (typeof id !== "string" || typeof claimFa !== "string" || !claimFa.trim()) continue;
    const english = englishClaim.get(id);
    if (english === undefined || row.src_hash !== srcHash(english)) continue;
    out[id] = claimFa;
  }
  return out;
}

/**
 * A brief's `.fa.md` sidecar, beside the report itself.
 *
 * `slug` takes the catch-all route's own `string[]` (see
 * app/briefs/[...slug]/page.tsx) rather than the joined string readReport
 * takes, so a caller never has to `.join("/")` before reaching for the
 * Persian one. The traversal guard runs on the English path exactly as in
 * readReport; the Persian path is built from the same already-guarded
 * `joined` value, so it inherits the same guarantee.
 */
export function readReportFa(slug: string[]): string | null {
  const joined = slug.join("/");
  const enPath = path.resolve(REPORTS_DIR, `${joined}.md`);
  if (!enPath.startsWith(path.resolve(REPORTS_DIR) + path.sep)) return null; // traversal guard
  const faPath = path.resolve(REPORTS_DIR, `${joined}.fa.md`);
  return readWholeDocumentFa(enPath, faPath);
}

/**
 * The daily fit's measurements. Null until the first `jamasp weights fit`
 * runs, and null again if the file is unreadable — the maps render every
 * tile neutral and dashed in that window rather than taking the page down.
 *
 * snake_case in, camelCase out: the file is written by Python and read by
 * TypeScript, and letting Python's naming leak into the panel's types is how
 * `fitted_at` ends up half-renamed across a dozen call sites later.
 */
export function readFittedWeights(): FittedWeights | null {
  const raw = readText(path.join(STATE_DIR, "weights.json"));
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw) as Record<string, never>;
    const fits: FittedWeights["fits"] = {};
    for (const [name, f] of Object.entries(
      (doc.fits ?? {}) as Record<string, Record<string, never>>)) {
      fits[name] = {
        n: Number(f.n ?? 0),
        horizonHours: Number(f.horizon_hours ?? 0),
        flags: (f.flags ?? []) as unknown as string[],
        coefficients: (f.coefficients ?? {}) as unknown as
          Record<string, FittedCoefficient>,
      };
    }
    return { fittedAt: String(doc.fitted_at ?? ""), fits };
  } catch {
    return null;
  }
}

export function loadWeightsConfig(): WeightsConfig {
  const raw = readText(path.join(CONFIG_DIR, "weights.yaml"));
  if (!raw) return { themes: [], signals: [] };
  const doc = YAML.parse(raw) as WeightsConfig | null;
  return { themes: doc?.themes ?? [], signals: doc?.signals ?? [] };
}
