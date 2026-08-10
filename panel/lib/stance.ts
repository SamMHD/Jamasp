/**
 * Parsing for `state/stance.md` — the agent's current market view.
 *
 * The agent rewrites this file freehand every run, so only what has proven
 * stable across real history is parsed: the `##` section headings (stable
 * across every run inspected, though they take varying parenthetical
 * suffixes) and the `Weights a/b/c (…)` line inside `## View`. The preamble
 * between the H1 and the first `##` uses improvised bold labels every run
 * (`EVENT-PENDING`, `Kpler`, `Crowding`, `Mecca pact`) and is therefore
 * rendered verbatim, never parsed.
 */

/**
 * Lines that begin a new block and must never be folded into the previous
 * one. `>` only starts a blockquote when followed by whitespace or nothing
 * (a bare `>`) — `>40%`, as in a wrapped comparison, is prose, not a quote.
 */
const BLOCK_START = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>(\s|$)|\|)/;
const HEADING = /^\s*#{1,6}\s/;

/**
 * Join hard-wrapped continuation lines into their paragraph.
 *
 * Stance prose is wrapped at ~72 characters, which breaks any line-based
 * regex. On the six committed fixtures: the bolded weights sentence
 * (`**Weights ... **`) matches a whole-text search in 1 of 6 raw versions
 * and 6 of 6 unwrapped versions; the narrower `Weights a/b/c (...)` triplet
 * currently happens to fit on one line in all six raw versions, which is
 * luck about where the ~72-char wrap lands, not a property of the format.
 * Run this before any other matching. Blank lines, headings, list-item
 * starts, block quotes, table rows and fenced code are all preserved.
 */
export function unwrapParagraphs(text: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      out.push(line);
      continue;
    }
    const prev = out[out.length - 1];
    const continues =
      !fenced &&
      prev !== undefined &&
      prev.trim() !== "" &&
      line.trim() !== "" &&
      !BLOCK_START.test(line) &&
      !HEADING.test(prev);
    if (continues) out[out.length - 1] = `${prev.replace(/\s+$/, "")} ${line.trim()}`;
    else out.push(line);
  }
  return out.join("\n");
}

export type StanceKey =
  | "view" | "whatFlipsMe" | "openPredictions"
  | "wakeups" | "deskLocal" | "sourcingHealth";

export type StanceSection = { heading: string; body: string };

export type ParsedStance = {
  asOf: string | null;
  updatedNote: string | null;
  preamble: string;
  sections: Partial<Record<StanceKey, StanceSection>>;
  extra: StanceSection[];
  weights: StanceWeight[] | null;
  raw: string;
  degraded: boolean;
};

/**
 * Canonical key -> heading prefix, matched case-insensitively. Prefix
 * matching is required: real headings carry run-specific suffixes such as
 * "## Open predictions (Friday cohort scores Sat 00:15Z, wakeup #19)".
 * Order matters only for readability; keys are disjoint.
 */
const SECTION_PREFIXES: readonly (readonly [StanceKey, string])[] = [
  ["view", "view"],
  ["whatFlipsMe", "what flips me"],
  ["openPredictions", "open predictions"],
  ["wakeups", "wakeups"],
  ["deskLocal", "desk-local"],
  ["sourcingHealth", "sourcing health"],
] as const;

function classify(heading: string): StanceKey | null {
  const h = heading.trim().toLowerCase();
  for (const [key, prefix] of SECTION_PREFIXES) if (h.startsWith(prefix)) return key;
  return null;
}

export type StanceWeight = { label: string; pct: number };

/**
 * "Weights 70/5/25 (base/event-bearish/kinetic), conviction medium-high."
 * The triplet changes between runs; the shape has held across every real
 * version inspected. Input must already be unwrapped (parseStance bodies
 * are), or the line will be missed when it spans a wrap.
 *
 * `[^)\n]` rather than `[^)]` is deliberate: a negated class matches `\n`
 * in JS, so `[^)]` would quietly match across a wrap and disguise a missing
 * unwrap step. Keep the newline exclusion.
 */
const WEIGHTS_RE = /Weights\s+(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\(([^)\n]+)\)/i;

export function parseWeights(viewBody: string): StanceWeight[] | null {
  const m = WEIGHTS_RE.exec(viewBody);
  if (!m) return null;
  const pcts = [Number(m[1]), Number(m[2]), Number(m[3])];
  const labels = m[4].split("/").map(s => s.trim()).filter(Boolean);
  // A mismatch means the format drifted; render nothing rather than
  // mislabelled chips.
  if (labels.length !== pcts.length) return null;
  return pcts.map((pct, i) => ({ label: labels[i], pct }));
}

export function parseStance(text: string): ParsedStance {
  const empty: ParsedStance = {
    asOf: null, updatedNote: null, preamble: "",
    sections: {}, extra: [], weights: null, raw: text, degraded: true,
  };
  if (!text.trim()) return empty;

  const lines = unwrapParagraphs(text).split("\n");

  // H1 — "# Stance — 2026-08-10 (updated 07:50 Dubai, Monday brief)"
  const h1 = lines.find(l => /^#\s/.test(l)) ?? "";
  const asOf = /(\d{4}-\d{2}-\d{2})/.exec(h1)?.[1] ?? null;
  const updatedNote = /\(([^)]*)\)/.exec(h1)?.[1] ?? null;

  const preambleLines: string[] = [];
  const sections: Partial<Record<StanceKey, StanceSection>> = {};
  const extra: StanceSection[] = [];
  let current: StanceSection | null = null;
  let seenH1 = false;

  for (const line of lines) {
    if (!seenH1 && /^#\s/.test(line)) { seenH1 = true; continue; }
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) {
      const heading = h2[1].trim();
      current = { heading, body: "" };
      const key = classify(heading);
      // First occurrence wins; a repeated heading lands in extra rather than
      // silently overwriting the earlier one.
      if (key && !sections[key]) sections[key] = current;
      else extra.push(current);
      continue;
    }
    if (current) current.body += (current.body ? "\n" : "") + line;
    else if (seenH1) preambleLines.push(line);
  }

  for (const s of Object.values(sections)) s.body = s.body.trim();
  for (const s of extra) s.body = s.body.trim();

  return {
    asOf, updatedNote,
    preamble: preambleLines.join("\n").trim(),
    sections, extra,
    weights: sections.view ? parseWeights(sections.view.body) : null,
    raw: text,
    degraded: sections.view === undefined,
  };
}
