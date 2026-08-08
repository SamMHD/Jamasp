# Jamasp News Flash — design

**Date:** 2026-08-08
**Status:** approved, ready for planning

## Problem

Gold news reaches the desk only through scheduled agent runs: the daily brief
and the 2-hourly scan, which stays silent by design unless something is urgent.
Routine but useful items — a mine strike, a central-bank purchase, an ETF flow
print — surface hours late or not at all. The desk wants every gold-touching
story pushed to Telegram as it arrives, summarized and interpreted, with each
story appearing exactly once no matter how many outlets carry it.

## Goal

For every gold-related item entering the system, publish one Telegram message
to a dedicated news channel containing a Persian title, a one-paragraph
summary, and a one-paragraph read on the likely gold impact. When a second
source reports the same story within 24 hours, edit the existing message to add
that source rather than posting again.

## Non-goals

- No panel UI for flashes. The tables are shaped so a page can be added later.
- No stance awareness in flash text. Flashes are wire-grounded, not positional;
  the brief and scan remain the stance-bearing outputs.
- No change to brief, scan, retro, or deepdive behavior.
- No trading instructions, per CLAUDE.md rule 6.

## Decisions taken

| Question | Decision |
|---|---|
| Relevance bar | Everything gold-touching (~30–45 items/day), not just market-moving |
| Who writes | A model pass inside `jamasp ingest`, not an agent run |
| Cadence | Last stage of every 15-minute ingest tick, immediately after retrieval |
| Channel | Separate Telegram channel, new env var |
| Dedupe | Model matches candidates against the last 24h of posted flashes |
| Repeat handling | Append to the sources line and edit the message; paragraphs unchanged |
| Burst control | 6h age cutoff plus a per-tick post cap; overflow is dropped, not queued |
| Message shape | Persian title, Persian body, Latin numerals, sources + link + Dubai time |
| Impact depth | Transmission mechanism plus confirming/invalidating conditions |

Note on numerals: the approved mockup showed Persian-Indic digits, but
CLAUDE.md rule 3 requires Latin numbers and tickers in Telegram messages. This
spec follows the rule — `3,420`, not `۳٬۴۲۰`.

## Architecture

New module `jamasp/flash.py`, invoked as the final stage of `jamasp ingest`,
after fetch → dedupe → cluster → digest. Ingest fires every 15 minutes, so a
story reaches Telegram within one tick of arriving on the wire.

Flash does **not** go through `runner.run_agent`. It never consumes the 20/day
agent-run cap and never spawns an interactive Claude session — the same posture
as the existing `digest` pass.

Flash **never marks items read**. The brief and scan continue to see the full
unread delta exactly as today.

### Two model calls per tick

| | Stage A — decide | Stage B — write |
|---|---|---|
| Input | Candidate items (`id`, `source`, `headline`, `lede`) plus the last 24h of posted flashes (`flash_id`, `title_en`) | One story: headline, source, published time, extracted article text |
| Output | Per item: `gold: bool`, `dup_of: flash_id \| null` | `{title_fa, summary_fa, impact_fa}` |
| Frequency | One call per tick with candidates | One call per new story (~1–3/tick) |

The split exists so that article text is fetched only for stories that will
actually be posted, each prompt has a single job, and one failed write does not
sink the whole batch.

Stage B is grounded in extracted article text rather than the headline. A
paragraph-length summary derived from a headline alone is the headline padded
out, and invites invented figures.

## Data model

Two new tables, both plain `CREATE TABLE IF NOT EXISTS` appended to `SCHEMA` in
`jamasp/db.py`. No `ALTER TABLE`, no migration helper, no change to `items`.

```sql
CREATE TABLE IF NOT EXISTS flashes (
    id          TEXT PRIMARY KEY,   -- item id of the story's first item
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    title_en    TEXT NOT NULL,      -- first item's headline; Stage A matches on this
    title_fa    TEXT NOT NULL,
    summary_fa  TEXT NOT NULL,
    impact_fa   TEXT NOT NULL,
    url         TEXT NOT NULL,      -- first source's article link
    message_id  INTEGER NOT NULL,   -- Telegram message id
    status      TEXT NOT NULL       -- sent | orphaned
);
CREATE TABLE IF NOT EXISTS flash_items (
    item_id  TEXT PRIMARY KEY,
    flash_id TEXT,                  -- NULL when the item produced no message
    state    TEXT NOT NULL,         -- posted | dup | not_gold | skipped_stale | skipped_burst
    ts       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flash_items_flash ON flash_items(flash_id);
```

`flash_items` is the per-item processing ledger. An item with no row is
unprocessed and eligible on the next tick. The sources for a message are
obtained by joining `items` through `flash_items` on `flash_id`.

A row exists in `flashes` only for a story that was actually delivered — the
`message_id` is known at insert time and never null. Stories dropped by the
burst cap are recorded solely in `flash_items`, so they can never become dedupe
targets for later items. `status = 'orphaned'` marks a flash whose Telegram
message has since been deleted; it still absorbs duplicates but is never edited
again.

`title_en` lets Stage A compare English headlines against English headlines
instead of matching across languages.

## Tick logic

1. **Select candidates.** Items with no `flash_items` row and
   `published_at >= now - max_age_hours`, newest first, limited to
   `classify_batch_max`.
2. **Retire stale items.** Items with no `flash_items` row older than
   `max_age_hours` get `state = 'skipped_stale'`. They are never posted.
3. **Stage A.** Classify the candidates. `gold = false` → `state = 'not_gold'`,
   done.
4. **Repeats.** For each item whose `dup_of` resolves to a row in `flashes`:
   record `state = 'dup'` with that `flash_id`, re-render the message with the
   grown sources line, and `editMessageText` against the stored `message_id`.
   A `dup_of` that names no known flash — a hallucinated or expired id — is
   treated as a new story.
5. **New stories.** For each remaining relevant item, up to
   `max_posts_per_tick`: extract the article, run Stage B, render, `sendMessage`
   to the news channel, insert the `flashes` row with the returned `message_id`,
   record `state = 'posted'`.
6. **Overflow.** New stories beyond `max_posts_per_tick` get
   `state = 'skipped_burst'` in `flash_items` and nothing else — no model call,
   no `flashes` row, no message. They remain inspectable by joining against
   `items`. This is what protects the channel after an outage.

Ordering within a tick is newest-first, so when the cap bites, the freshest news
wins.

## Message format

No `parse_mode` is set. The body carries no markup, so there is no escaping
surface, and Telegram auto-links the bare `https://` URL on its own line.

```
🟡 طلا به رکورد تاریخی 3,420 دلار رسید

قیمت طلا در معاملات آسیایی با 1.8% رشد به 3,420 دلار در هر اونس
رسید و رکورد پیشین را شکست. محرک اصلی، انتظار بازار برای کاهش نرخ
بهره فدرال‌رزرو در نشست سپتامبر و افت شاخص دلار بود.

اثر احتمالی: ادامه ضعف دلار می‌تواند سقف تازه‌ای بسازد؛ اما اگر
CPI هفته آینده داغ دربیاید، اصلاح تا محدوده 3,350 محتمل است.

منابع: Reuters • CNBC
https://www.reuters.com/markets/gold-record
⏱ 14:32 دبی
```

Rules:

- Title line is prefixed with a fixed `🟡` as the channel's marker.
- Numbers, tickers, and instrument names stay Latin (CLAUDE.md rule 3).
- The `منابع:` line lists display names in the order the sources arrived.
- The link is the first source's article URL and does not change on edits.
- The timestamp is the first item's `published_at` rendered in `Asia/Dubai`
  (`settings.timezone`) as `HH:MM دبی`.
- The rendered message is truncated defensively below Telegram's 4096-character
  limit.

A repeat re-renders this entire message from the stored `flashes` row with a
longer `منابع:` line, so rendering stays a pure function of stored state.

### Source display names

`sources.yaml` entries gain an optional `display:` field (`Reuters`,
`CNBC`, …) and `config.Source` gains a matching optional attribute. When absent,
the slug is title-cased with underscores replaced by spaces. This is the only
change outside the new module and its wiring.

## Prompts

### Stage A — decide

Role: triage desk for a physical gold trading operation.

Input, as two labelled blocks:

```
POSTED (last 24h):
<flash_id>\t<title_en>

NEW:
<item_id>\t<source>\t<headline>\t<lede>
```

Output: a single JSON object, `{item_id: {"gold": bool, "dup_of": id|null}}`,
and nothing else.

Guidance carried in the prompt:

- `gold` is deliberately permissive: gold price action, miners, central-bank
  reserves and purchases, interest rates, the dollar, inflation prints,
  geopolitical risk, ETF and physical flows all count. Single-name equity news
  unrelated to gold, crypto-only stories, and general corporate news do not.
- `dup_of` means the **same underlying event**, not the same topic. "Gold hits
  record" and "Gold pulls back from record" are two stories.
- `dup_of` may name a POSTED flash id **or the id of an earlier-listed NEW
  item**. Without the second form, two outlets carrying the same story inside a
  single tick would both look new and produce two messages. When several NEW
  items cover one story, all but the first point at that first item's id; the
  first is published and the rest fold into it. A `dup_of` naming a candidate
  that was never published — it was `not_gold`, its write call failed, or it
  lost to the burst cap — falls through to "new story", which is the safe
  direction.
- When uncertain whether something is a repeat, treat it as new. A duplicate
  message is a smaller failure than a suppressed story.

### Stage B — write

Input: headline, source display name, published time, and article text
truncated to `extract_chars`.

Output: `{"title_fa": ..., "summary_fa": ..., "impact_fa": ...}`.

- `title_fa`: at most ten words, Persian, no trailing punctuation.
- `summary_fa`: one paragraph, three to five sentences, stating only facts
  present in the article.
- `impact_fa`: one paragraph naming the transmission channel to gold and the
  conditions that would confirm or invalidate it. No trade instructions, no
  buy/sell posture (CLAUDE.md rule 6).
- Hard instruction: never state a number, date, or name that does not appear in
  the source text.

When extraction fails, Stage B falls back to headline plus lede and is
instructed to write a shorter, explicitly hedged summary rather than skipping
the story.

## Configuration

```yaml
flash:
  enabled: true
  max_age_hours: 6
  max_posts_per_tick: 10
  classify_batch_max: 30
  extract_chars: 4000
  decide_cmd: ["claude", "-p", "--model", "sonnet"]
  write_cmd:  ["claude", "-p", "--model", "sonnet"]

telegram:
  bot_token_env: JAMASP_TG_TOKEN
  chat_id_env: JAMASP_TG_CHAT
  news_chat_id_env: JAMASP_TG_NEWS_CHAT     # new
```

Both stages default to Sonnet so real output can be judged before tuning.
Either can be demoted to Haiku by editing one line. The recommendation, if only
one is demoted, is to demote **decide**: it is short, structured, and
mechanical, whereas write produces the Persian analytical prose the desk reads.

## CLI

- `uv run jamasp flash` — run one flash pass standalone.
- `uv run jamasp flash --dry-run` — render and print messages. Makes no
  Telegram calls and records no flash state. It does run both model calls, since
  seeing the Persian output is the point, and may populate `extract_cache`.
- `uv run jamasp ingest --no-flash` — skip the flash stage, mirroring
  `--no-digest`.

## Error handling

The governing invariant: **any failure leaves the item unprocessed**, so the
next tick retries it, and the `max_age_hours` cutoff is the backstop that stops
a permanently broken item from retrying forever. No retry counters, no
dead-letter queue.

| Failure | Behavior |
|---|---|
| Missing `JAMASP_TG_NEWS_CHAT` | Flash disabled for the run, `WARN` on stderr, one `source_errors` row. Never falls back to the desk chat — 40 messages/day into the brief channel is the worse outcome. |
| Stage A call fails or returns unparseable JSON | `source_errors` row (`source = 'flash'`), no items touched, ingest continues normally. |
| Article extraction fails | Not a failure: Stage B runs on headline plus lede. |
| Stage B call fails for one story | That item is left unprocessed; the rest of the batch proceeds. |
| `sendMessage` fails | `source_errors` row, item left unprocessed, retried next tick. |
| `editMessageText` fails with *message to edit not found* | Item marked `dup` regardless and the flash set to `status = 'orphaned'`. The message is gone; retrying cannot succeed, and later duplicates skip the edit. |
| `editMessageText` fails otherwise | Item left unprocessed, retried next tick. |
| Sources line unchanged | Edit skipped entirely — Telegram errors on identical text. |

Every model call runs under a subprocess timeout (120s per call), matching the
`digest` pass. Flash failures never fail the ingest run.

## Testing

`flash.py` takes injected `run_model` and `post` callables, following the
existing `digest` and `notify` test patterns. Tests touch no network and invoke
no real model.

Unit coverage:

- Candidate selection: age cutoff, batch cap, exclusion of already-processed
  items, newest-first ordering.
- Stale retirement writes `skipped_stale` and posts nothing.
- Stage A response parsing, including malformed and partial JSON.
- `not_gold` items are recorded and never sent.
- New story: send path stores `message_id`, `flashes` row, and `posted` state.
- Repeat: edit path fires against the stored `message_id`, the sources line
  grows, and the paragraphs are unchanged.
- Repeat with an unchanged sources line: no edit call.
- `dup_of` naming an unknown flash id is treated as a new story.
- An `orphaned` flash absorbs duplicates without attempting an edit.
- Burst overflow: `skipped_burst` rows written, zero sends, no Stage B calls,
  and the dropped items never become dedupe targets on a later tick.
- Telegram send failure leaves the item unprocessed and eligible next tick.
- Missing news-chat env disables flash with no sends.
- Golden render test: Latin numerals, Dubai time, source ordering, link line.

Integration:

- `jamasp flash --dry-run` prints rendered messages and performs no writes.
- `jamasp ingest --no-flash` runs the existing pipeline unchanged.

## Documentation and deployment

- CLAUDE.md: add `uv run jamasp flash` to the toolbox table and a sentence
  stating that gold news is auto-published to the news channel between runs.
- `.claude/skills/deploy/SKILL.md`: add `JAMASP_TG_NEWS_CHAT` to the environment
  file setup and the step of adding the bot to the second channel.
- No new systemd unit. Flash rides the existing ingest timer.

## Open risks

- **Volume.** 30–45 messages/day is a real firehose. If the channel proves
  noisy, the lever already exists: tighten Stage A's `gold` criterion in the
  prompt without touching any code.
- **Dedupe quality.** Stage A is instructed to favor a duplicate over a
  suppression. Expect some double-posting early; the fix is prompt tuning
  informed by the `flashes` table.
- **Ingest duration.** A full tick can now run up to `max_posts_per_tick`
  sequential Stage B calls. At 10 posts and 120s worst case that approaches the
  15-minute timer interval. Steady state is 1–3 calls, and systemd's `oneshot`
  ingest will not overlap itself, but if ticks start colliding the cap is the
  knob to turn down.
