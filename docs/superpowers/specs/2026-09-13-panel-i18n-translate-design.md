# Panel i18n and `jamasp translate` — Design Spec

**Date:** 2026-09-13
**Status:** approved design; implementation plan follows

## Purpose

The desk reads Persian. The panel is English. This adds a language selector to
the panel and the machinery behind it: a `jamasp translate` job that fills
Persian renderings of everything the panel shows, and a Persian presentation
layer that uses them.

Farsi is the only added language, but nothing here is allowed to assume it is
the only one there will ever be — except where assuming it buys a materially
simpler design, which is called out each time it happens.

Translation is a **presentation concern only**. Jamasp's analysis runs continue
to read and write English; reports stay English (CLAUDE.md rule 3); Telegram
output is untouched. Nothing in this document changes what the agent sees.

## Decisions made

Settled during brainstorming, recorded so the plan does not relitigate them.

| # | Decision | Chosen |
|---|---|---|
| 1 | RTL extent | Hybrid — chrome RTL, instruments stay LTR |
| 2 | Surfaces | Chrome, news items, agent prose, calendar + predictions |
| 3 | Row storage | `_fa` columns on the existing tables |
| 4 | Translator | Configurable command, `codex` the default |
| 5 | Document prose | Sidecar `.fa` files, committed to git |
| 6 | Flash Persian | Reused, not re-translated |
| 7 | Cadence | Own systemd timer, ~10 minutes |
| 8 | Selection | Only what the panel renders, inside a window |
| 9 | Numerals and dates | Latin digits, Gregorian dates, everywhere |
| 10 | Locale transport | Cookie, read server-side in the root layout |
| 11 | Missing translation | English text with a quiet `EN` marker |
| 12 | Failures | Attempt counter + status, backoff, alert on backlog |
| 13 | Terminology | Pinned glossary file; tickers and acronyms stay Latin |
| 14 | Default language | Persian — but see decision 19 |
| 15 | Batching | ~20 rows per call, JSON in, JSON out |
| 16 | Chrome strings | Hand-translated dictionary, reviewed in the PR |
| 17 | Stance | Parse English for structure, swap Persian bodies in |
| 18 | Reports | New reports only, from ship day |
| 19 | Rollout | Ship English-default, backfill, flip in a follow-up |

## Scope

**In:** a language selector; a Persian chrome dictionary; `_fa` columns on
`items` and `events`; `.fa` sidecars for stance, playbook, watchlist,
predictions and new reports; the `jamasp translate` CLI command and its
systemd timer; a glossary file shared with the flash pipeline; the panel-side
rendering, direction handling and fallback treatment; backlog alerting; and the
CLAUDE.md and `deploy`-skill updates the new timer and the codex credentials
require.

**Out:** Telegram output of any kind (flash, rollup, brief, scan — all
unchanged); report *authoring*, which stays English; the agent's own reading
path; `state/lessons-inbox.md`, which the panel does not render; TradingView
widget chrome, which is theirs; any language other than Persian; retranslation
triggered from the panel UI.

## Architecture — three tracks

"Translation" covers three populations with different economics. Treating them
as one job is the main way this design could go wrong, so they are three
tracks with one entry point.

| Track | Content | Store | Filled by | Runtime cost |
|---|---|---|---|---|
| A — Chrome | ~200 fixed UI strings | `panel/messages/{en,fa}.json` | Hand, reviewed in PR | None |
| B — Rows | `items.headline`, `items.lede`, `events.title` | `_fa` columns | `jamasp translate`, or copied free from `flashes` | The bulk |
| C — Docs | stance, playbook, watchlist, predictions, reports | `.fa` sidecar files | `jamasp translate` | Low volume, long units |

Track A never touches a model. Chrome is read hundreds of times a day and is a
closed set; a model that renders "Real yield" three different ways across three
deploys is worse than no translation at all. Tracks B and C share the job, the
glossary and the runner, but not their storage.

## Track A — the chrome dictionary

Two files, `panel/messages/en.json` and `panel/messages/fa.json`, flat
dot-namespaced keys:

```json
{
  "nav.overview": "Overview",
  "map.unscored": "unscored",
  "map.empty": "No items in window",
  "stance.whatFlipsMe": "What flips me",
  "driver.realYield": "Real yield"
}
```

Resolved by a small server helper, `panel/lib/i18n.ts`:

```ts
export type Locale = "en" | "fa";
export function resolveLocale(cookie: string | undefined): Locale;
export function getMessages(locale: Locale): Record<string, string>;
export function t(messages: Record<string, string>, key: string): string;
```

`t()` falls back to the English string when a Persian key is missing, and to
the key itself when neither exists — a missing label must never render as
blank space on a dense dashboard.

**`next-intl` is deliberately not used.** Its ergonomic path is a `[locale]`
URL segment, which decision 10 rejected; adopting it would mean moving every
route under a locale segment and rewriting every `href` in `lib/nav.ts` and the
components. A two-language flat dictionary does not justify fighting a library.
If a third language ever arrives this decision is worth revisiting; the `t()`
call sites are the same either way.

A vitest asserts every key in `en.json` exists non-empty in `fa.json`. It is a
test rather than a build failure so that adding an English label does not block
on its translation, but the suite goes red until it is supplied.

**Fixed enums are chrome, not content.** Theme names (`rates_dollar`,
`risk_sentiment`), driver labels, signal names, stance section headings,
`run_type` values and impact levels are all closed sets defined in the code or
in `config/weights.yaml`. They live in the dictionary and never reach codex.

## Track B — row content

### Schema

Added through the existing `ADDED_COLUMNS` mechanism in `jamasp/db.py`, which
is `ALTER TABLE ... ADD COLUMN` — instant, no table rewrite, safe against the
live database that months of history cannot be recreated from.

```
items:   headline_fa   TEXT
         lede_fa       TEXT
         fa_source     TEXT                          -- 'flash' | 'model'
         fa_at         TEXT
         fa_attempts   INTEGER NOT NULL DEFAULT 0
         fa_error      TEXT

events:  title_fa      TEXT
         fa_at         TEXT
         fa_attempts   INTEGER NOT NULL DEFAULT 0
         fa_error      TEXT
```

`fa_source` exists because two mechanisms write `headline_fa` and they have
different voices: flash Persian is editorial, written to carry a story on a
Telegram channel; codex Persian is a faithful translation of a headline. An
audit that cannot tell them apart cannot act on a complaint that the two
surfaces read differently.

There is no `src_hash` on rows. `items` and `events` rows are written once at
ingest and never edited — the hash would be dead weight on the largest table in
the database. Documents, which *are* rewritten, carry hashes; see Track C.

### The four passes

```
uv run jamasp translate [--dry-run] [--force] [--only rows|events|docs]
                        [--limit N] [--check]
```

Passes run in this order, and the order is load-bearing:

1. **Reuse (free, no model).** Items with a delivered flash inherit its Persian:

   ```sql
   UPDATE items SET headline_fa = (SELECT title_fa   FROM flashes f WHERE f.id = items.id),
                    lede_fa     = (SELECT summary_fa FROM flashes f WHERE f.id = items.id),
                    fa_source   = 'flash',
                    fa_at       = :now
   WHERE headline_fa IS NULL
     AND EXISTS (SELECT 1 FROM flashes f
                 WHERE f.id = items.id AND f.status = 'delivered');
   ```

   Every top- and middle-tier story is already Persian before codex is asked
   anything. This pass must run first or the rows pass pays for work already
   done.

2. **Rows.** Remaining untranslated items inside the selection window, in
   batches, one model call per batch.
3. **Events.** The same machinery against `events.title`, smaller batches. Event
   titles are near-boilerplate (`"US CPI (MoM)"`, `"FOMC Statement"`) and the
   glossary does most of the work.
4. **Docs.** Track C.

`--only rows` selects passes 1 and 2 together — the reuse pass is part of the
row track, never a separately selectable stage, because running the rows pass
without it means paying for translations that already exist.

`--force` re-translates rows that already have Persian, and is the escape hatch
for a glossary change or a bad model run. It does not override the abandonment
cap: a row at 3 attempts is reset by `--force` and retried once more, so an
operator clearing a known-bad state does not have to edit the database. `--dry-run`
reports what each pass would do and calls no model, mirroring
`jamasp flash --dry-run`.

### Selection rule

The cost knob, and therefore config rather than code:

```yaml
translate:
  window_days: 7           # matches the map's widest window
  max_batches_per_run: 6   # ceiling per tick; ~120 items at batch_size 20
  batch_size: 20
```

Everything with `published_at >= now - window_days` is translated, newest
first; everything older renders with the English marker.

A flat window was chosen over "scored items only" because `/inbox` renders
*unscored* items too, and a cleverer rule leaves gaps that read as bugs. If
volume proves uncomfortable, the knob to add is a tier floor —
`translate.tier_min`, filtering on `flash_items.tier` — not a narrower window.
See Risks.

`max_batches_per_run` bounds a tick. A backlog larger than the ceiling drains
over subsequent ticks, newest first, which is the correct priority order: the
freshest headline is the one somebody is looking at.

## Track C — document sidecars

One rule governs this track: **never write into a file the agent owns.** The
brief run rewrites `state/stance.md` and `state/watchlist.yaml` wholesale, and
`jamasp predictions add` appends to `state/predictions.jsonl`. A Persian field
written inside any of those is one agent run away from being silently dropped.
So every document translation is a sidecar, keyed to the source and carrying a
hash of it.

```
state/stance.fa.md             sections in source order, src_hash front matter
state/playbook.fa.md           whole document, src_hash front matter
state/watchlist.fa.yaml        theme -> why_fa, per-entry src_hash
state/predictions.fa.jsonl     id -> claim_fa, per-line src_hash
reports/YYYY/MM/<slug>.fa.md   whole document, src_hash front matter;
                               new reports only, from ship day
```

Front matter shape:

```markdown
---
src_hash: 3f9a1c7e…            # sha256 of the English source, hex
translated_at: 2026-09-13T06:14:00Z
translator: codex
---
```

Formats, stated exactly so the reader and the writer cannot disagree.

`state/stance.fa.md` keeps the **English heading text verbatim** as a section
anchor, with the Persian body beneath it, and a per-section hash line:

```markdown
---
src_hash: 3f9a1c7e…
translated_at: 2026-09-13T06:14:00Z
translator: codex
---
## View
<!-- src_hash: 9b2e44a1… -->
نمای فعلی بازار …

## What flips me
<!-- src_hash: c70d18f5… -->
…
```

The English headings are anchors, never rendered — the panel takes headings
from `messages/fa.json`. Keeping them verbatim means the sidecar splits with
the same `SECTION_PREFIXES` logic as the source, so section matching cannot
drift, and the per-section hash is what lets one rewritten section translate
alone.

`state/watchlist.fa.yaml`, keyed by theme:

```yaml
watchlist:
  - theme: real_yields
    why_fa: بازدهی واقعی …
    src_hash: 4a1c9e77…
```

`state/predictions.fa.jsonl`, one object per line, keyed by prediction id:

```json
{"id": "p-2026-09-11-a", "claim_fa": "…", "src_hash": "b81f…"}
```

`playbook.fa.md` and the report sidecars are whole-document: front matter, then
the translated markdown, headings included — nothing parses them structurally,
so nothing constrains them.

The hash is what makes this track correct where an empty-column check would be
wrong. `stance.md` is rewritten at the end of every run; "fill it if it is
empty" would translate it once and then serve a stale Persian stance for
months. The docs pass hashes the source, compares, and re-translates only what
changed. Sidecars are committed with everything else under CLAUDE.md rule 4.

Sidecars are written atomically — temp file in the same directory, then
`os.replace` — because the panel reads these files on every render and must
never see a half-written document.

`state/lessons-inbox.md` is excluded: the panel does not render it.

### Stance, specifically

`panel/lib/stance.ts` parses `stance.md` structurally **in English**:
`SECTION_PREFIXES` matches headings by English prefix (`"what flips me"`,
`"sourcing health"`), `WEIGHTS_RE` extracts `Weights 70/5/25
(base/event-bearish/kinetic)` out of the View body, and `splitFalsifier` and
`scenarioSlot` do likewise. A naively translated `stance.fa.md` parses to
`degraded: true` and the Stance panel collapses.

So structure is never translated:

```
state/stance.md   → parseStance()  → sections, weights, falsifiers, slots
                                         │
state/stance.fa.md → bodies[] ───────────┤→ render
                                         │
panel/messages/fa.json → headings ───────┘
```

The panel always parses the English file for structure and always reads weights
and scenario slots from it. Persian supplies **section bodies only**, matched
by source order. Headings come from the dictionary, because `StanceKey` is a
closed six-value enum and therefore chrome.

Consequence for the job: the docs pass translates stance **per section**,
hashing each section body separately, so a run that rewrites only the View
section does not pay to re-translate five unchanged ones. The sidecar preserves
section count and order; a mismatch between the two files is a degraded state
that falls back to English bodies, never a crash.

## The model runner

### Command and protocol

`codex exec` offers `--output-schema <file>` and `-o/--output-last-message
<file>`. That is materially better than the flash pipeline's approach of
scraping JSON out of `claude -p` stdout: the response shape is enforced by the
model runtime, and the session preamble never contaminates the parse. The
translate runner is therefore its own function rather than a reuse of
`flash._run_model`, though the config shape matches so the two read alike.

```yaml
translate:
  cmd: ["codex", "exec", "--ephemeral", "--skip-git-repo-check",
        "--ignore-user-config", "-s", "read-only", "-m", "gpt-5-codex"]
  protocol: codex          # 'codex' = --output-schema + -o file
                           # 'stdout' = parse JSON from stdout (claude -p)
  timeout_seconds: 180
```

codex is the default because translation volume must not compete with the
Claude budget: `runs.max_agent_runs_per_day` caps the analysis runs, and the
flash pipeline already spends Claude calls on every ingest tick. Translation is
the highest-volume model consumer in the system and belongs on a separate
subscription.

Two protocols, both tested, so `protocol: stdout` with a `claude -p` command is
a config edit rather than a code change. `--ephemeral` keeps session files off
the host; `--ignore-user-config` keeps a stray `~/.codex/config.toml` from
changing behaviour under a systemd timer; `-s read-only` because a translator
has no business writing anything.

### Prompt and response

One call per batch. The prompt carries the glossary, the rules, and a numbered
list; the schema fixes the response shape:

```json
{
  "type": "object",
  "additionalProperties": {
    "type": "object",
    "properties": { "headline": {"type": "string"},
                    "lede":     {"type": "string"} },
    "required": ["headline"]
  }
}
```

Keyed by the batch index, not by item id — ids are long, and a model that
mangles one costs a row. Indices are mapped back to ids by the caller.

Standing rules in every prompt: translate faithfully and do not editorialize;
keep Latin digits, tickers, symbols and percentages exactly as they appear;
apply the glossary; return the source text unchanged if it is already Persian.

### Glossary

`config/glossary.fa.yaml`, pinned and hand-maintained:

```yaml
Fed:            فدرال رزرو
FOMC:           FOMC              # acronyms stay Latin
CPI:            شاخص قیمت مصرف‌کننده (CPI)
DXY:            DXY
XAU:            XAU
real yield:     بازده واقعی
safe haven:     دارایی امن
hawkish:        انقباضی
dovish:         انبساطی
```

Injected into every translate prompt. It is also wired into
`flashtext.build_write_prompt` and `build_rollup_prompt`, so the panel and the
news channel stop drifting apart — that shared use is the main argument for a
file over a prompt paragraph. Changing the glossary does not retranslate
anything by itself; `jamasp translate --force` does.

## Panel

### Locale transport

A `lang` cookie, read server-side in `panel/app/layout.tsx`, which sets
`<html lang dir>`. No route changes, no `href` rewrites, and no database write
— so the panel's read-only rule is never touched and the selector needs no CLI
call.

The absent-cookie case resolves to a single exported constant,
`DEFAULT_LOCALE` in `lib/i18n.ts`. It is `"en"` in PR 2 and `"fa"` in PR 3;
that constant is the entirety of the flip in decision 19, and nothing else in
the panel may hard-code a default.

Per-browser rather than per-identity is the right granularity for a shared desk
screen. The cost is that a pasted link opens in the recipient's own language,
which is acceptable for an internal panel.

The selector is an `EN / فا` control beside `ThemeToggle` in
`components/shell/top-bar.tsx` (mobile) and `components/shell/side-nav.tsx`
(desktop), submitting to a server action that sets the cookie and revalidates.

### Direction

`dir="rtl"` on `<html>` when the locale is `fa`. Chrome, prose, tables and
headlines flow right-to-left.

Instruments are pinned `dir="ltr"` explicitly: `market-map`, `map-tiles`,
`technical-map`, `live-chart`, `spot-chart`, `price-chart`, `ticker-tape`,
`driver-tape`, `level-ladder`, `horizon-strip`, `sparkline`, `arc-gauge`,
`weight-bar` and every TradingView embed. Time runs left-to-right on a chart in
Tehran as everywhere else, and these components position directionally; letting
`rtl` inherit into them mirrors axes and breaks layout for no reader's benefit.

The typeface is already handled. `app/layout.tsx` loads Vazirmatn as
`--font-fa`, and `app/globals.css` already carries
`:where([dir="rtl"], [lang="fa"]) { font-family: var(--font-fa) }`. Setting the
direction is sufficient; `e2e/mobile.spec.ts` already proves the face binds.

### The fallback marker

One shared component — `components/source-lang.tsx` — renders the English text
with a small dimmed `EN` chip. Every content surface uses it: market map tiles,
news flow, inbox rows, calendar, stance sections, briefs.

A marker rather than a silent fallback because a translate job that dies
quietly would otherwise look exactly like an English panel. This makes the
job's health visible on the surface where it matters. It is also why the
skeleton option was rejected: withholding a breaking headline for ten minutes
to protect a language rule is a bad trade on a trading panel.

The marker is for **content only**. Chrome is hand-translated and complete by
construction, so a chrome string that falls back to English is a bug in the
dictionary, not a pending translation, and must never wear a marker that
suggests the job will fix it later. The key-parity test is what catches that
case instead.

### Reading translations

`panel/lib/db.ts` gains `headline_fa`, `lede_fa`, `fa_source` on `ItemRow` and
`title_fa` on `EventRow`, plus one helper used by every call site:

```ts
export function localized(
  row: { [k: string]: unknown }, field: string, locale: Locale
): { text: string; fallback: boolean };
```

Returning the fallback flag alongside the text is what keeps the marker honest
— a component cannot render Persian and forget to say when it did not.

`panel/lib/files.ts` gains `readStanceFa`, `readPlaybookFa`, `readWatchlistFa`,
`readPredictionsFa` and `readReportFa(slug)`, each returning `null` when the
sidecar is absent or its hash does not match the English source it sits beside.
A stale sidecar is treated as no sidecar: better English than confidently wrong
Persian.

## Error handling

- **Per-row.** `fa_attempts` increments and `fa_error` records the reason. At 3
  attempts the row is abandoned, so a row codex will never accept does not burn
  a call every ten minutes forever.
- **Per-batch.** A malformed or refused response retries once as a batch, then
  falls back to individual calls, so one bad headline cannot poison nineteen
  good ones. Rows that fail individually take the per-row path above.
- **Per-document.** A failed document leaves the existing sidecar in place
  untouched and records the failure; a stale Persian document is better than
  none, and the hash mismatch keeps the panel honest about it by falling back
  to English.
- **Unit failure.** `jamasp-translate.service` carries
  `OnFailure=jamasp-alert@%n.service` like every other unit, so a crashed run
  reaches the desk chat rather than the journal.
- **Backlog.** `jamasp watchdog` gains a probe: untranslated in-window rows
  older than 45 minutes, or any row at maximum attempts, alerts the desk. A
  timer that runs successfully while translating nothing is the failure mode a
  unit-level alert cannot see.
- **Preflight.** `jamasp translate --check` verifies the binary resolves and is
  authenticated, and exits non-zero with a readable message otherwise. This is
  the codex analogue of the credentials trap already recorded in CLAUDE.md for
  Claude, and the deploy skill gains a step for `CODEX_HOME` alongside it.

## Ops

A ninth timer, following the flash-rollup pattern exactly:

```ini
# jamasp-translate.timer
[Timer]
OnBootSec=5min
OnUnitActiveSec=10min

# jamasp-translate.service
[Unit]
OnFailure=jamasp-alert@%n.service
[Service]
Type=oneshot
WorkingDirectory=%h/Jamasp
EnvironmentFile=-%h/.config/jamasp/env
# Deterministic pipeline stage, not an agent run: no `jamasp run` wrapper, so
# it consumes none of the daily agent-run cap — same as flash and rollup.
ExecStart=%h/.local/bin/uv run jamasp translate
```

`OnUnitActiveSec` rather than `OnCalendar` so a slow run cannot stack against
the next tick, and systemd's default `RefuseManualStart=no` plus oneshot
semantics mean a manual `jamasp translate` never overlaps a timed one.

The timer is **not** folded into ingest. Ingest already runs the network fetch
and the flash model calls inside a 15-minute cycle; a second unbounded model
stage there would let a codex stall delay news ingestion itself, which is the
one thing in the system that must not be late.

Two documentation updates ship with PR 1: `CLAUDE.md`'s Deployment section
("eight systemd timers" becomes nine, with a sentence on what translate does
and that it costs no agent-run budget), and the `deploy` skill, which gains the
`CODEX_HOME` / `~/.codex/auth.json` step next to the existing Claude
credentials step — the same trap, the same fix, and it will bite the same way
if it is not written down.

## Testing

TDD throughout. No test calls a live model: `translate.cmd` points at a fake
executable that reads the prompt and emits schema-valid JSON, which also makes
the failure paths (malformed output, non-zero exit, timeout, refusal)
deterministic.

Python:

- batch assembly — window filter, ordering, `max_batches_per_run` ceiling
- response parsing — index mapping, missing keys, extra keys, non-JSON
- the reuse pass — only delivered flashes, only null `headline_fa`, correct
  `fa_source`
- pass ordering — reuse before rows, proven by the model never being called for
  a flashed item
- **document staleness** — a rewritten `stance.md` re-translates; this is the
  test that pins the failure mode "fill if empty" cannot see
- per-section stance hashing — one changed section translates one section
- attempt and backoff transitions, including abandonment at 3
- atomic sidecar writes
- `--dry-run` calls no model and `--force` overwrites

TypeScript:

- `en.json` / `fa.json` key parity
- `t()` fallback chain: Persian → English → key
- `localized()` flag correctness
- sidecar hash mismatch falls back to English
- stance renders Persian bodies inside English-derived structure, and weights
  still parse when the locale is `fa`

Playwright:

- flipping the cookie sets `dir="rtl"` on `<html>` while a chart container
  remains `ltr`
- the `EN` marker appears on an untranslated row and not on a translated one

## Sequencing

Three pull requests, in order.

1. **Job and storage.** Schema columns, sidecars, glossary, the runner, the CLI
   command, the systemd unit and timer, the watchdog probe, deploy-skill step.
   The panel is untouched, so this ships with no user-visible change and the
   backlog fills quietly.
2. **Panel.** Chrome dictionary, `lib/i18n.ts`, selector, direction handling,
   the `EN` marker, and the content wiring on every surface. English stays the
   default, so the Persian path is opt-in while it proves itself.
3. **Flip.** One line: the default locale becomes `fa`.

The split is what makes decision 19 mean anything. Shipping 1 and 2 together
would make a half-translated panel the default experience for everyone on the
deploy that introduced it.

## Risks

**Volume is unmeasured.** `window_days: 7` translates every in-window item, not
only scored ones, and the real ingest rate is known only on the host — the
local database is a seed. *Action, before enabling the timer:* count items per
day on the host and how many already carry flash Persian, then set
`max_batches_per_run` against the measured remainder. If the number is
uncomfortable the fix is a `translate.tier_min` floor, not a shorter window.

**codex auth expiring silently.** A non-interactive `codex exec` whose auth has
lapsed fails every batch identically. `--check` plus the watchdog backlog probe
are the mitigation; the unit-level alert alone would not catch it, because a run
that fails every batch can still exit zero.

**Glossary drift between panel and channel.** Wiring the glossary into
`flashtext` is what prevents it, and is the reason it is a file. If the flash
prompts are changed later without it, the two surfaces will diverge again.

**Chrome review fatigue.** ~200 strings reviewed in one diff is exactly the
situation where plausible-but-wrong labels survive. Mitigation: the dictionary
lands in PR 2 grouped by surface, not alphabetically, so each group can be read
against the page it belongs to.

**Stance structure coupling.** The panel now depends on `stance.md` staying
parseable *and* on the sidecar's section count matching. Both degrade to
English rather than throwing, but a silent English stance panel in Persian mode
is a real failure. The backlog probe does not cover it; the hash-mismatch path
is tested instead.

## Out of scope

Telegram output of any kind. Report authoring, which stays English. The agent's
reading path — no analysis run ever sees Persian. `state/lessons-inbox.md`.
TradingView's own widget chrome. Any language beyond Persian. Retranslation
triggered from the panel UI, and the `/alerts` surface for translate failures —
both deliberately deferred so a job spec does not grow panel features.
