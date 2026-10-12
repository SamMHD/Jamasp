# On-demand Farsi brief from the desk Telegram — design

*2026-10-12. Status: approved in conversation; spec under review.*

## Goal

When anyone in the desk Telegram chat sends `/brief`, a codex session writes
a fresh, **independent** gold-market brief in **fluent, plain Persian** and
posts it back to that chat within a few minutes.

"Independent" means codex forms its own read from raw news and prices; it is
deliberately not shown Jamasp's stance, reports, predictions or flash
judgements. It is a second opinion, and it may disagree with Jamasp.

**Fluency is the primary quality bar.** The text must read as if a Persian-
speaking gold trader wrote it — not as a translation.

## Decisions (from the conversation)

| Question | Decision |
|---|---|
| Content source | Independent codex read from raw news + prices |
| Who / where | Any member of the desk chat (`JAMASP_TG_CHAT`); reply goes to that chat. Other chats and DMs are ignored. |
| Repeats | Always a fresh run; one at a time. A `/brief` while one is running gets a "busy" reply. No cooldown, no cache. |
| Listener | Long-polling `getUpdates` service (no webhook, no inbound exposure) |
| Language | Written natively in Persian, never English-then-translate |

## Non-goals

- No other bot commands. The listener is shaped so more can be added, but
  only `/brief` exists.
- No change to the morning brief, scans, flash, or the news channel.
- The farsi brief is not stored as a report, does not touch `state/`, does
  not consume the agent-run budget (`max_agent_runs_per_day`), and is never
  read back by any analysis run.
- It never marks inbox items read: the inbox delta belongs to the analyst.

## Architecture

Two units with one interface between them: the listener decides *whether*
to run; the generator decides *what* to say.

### 1. Listener — `jamasp bot` (`jamasp/bot.py`), unit `jamasp-bot.service`

- Long-polls `https://api.telegram.org/bot<token>/getUpdates` with
  `timeout=50` and `allowed_updates=["message"]`, in a loop.
- **Offset persistence.** After handling a batch it stores
  `last_update_id + 1` in `meta.bot_update_offset`, so a restart neither
  replays old commands nor loses new ones. On first start (no offset) it
  skips the backlog: it fetches once, records the newest offset, and handles
  nothing from before it started.
- **Filter.** Acts only on a message whose `chat.id` equals the desk chat id
  and whose text's first token is `/brief` or `/brief@<this bot's username>`
  (username from `getMe` at startup; a `/brief@other_bot` is ignored).
  Everything else is dropped silently.
- **Concurrency.** Spawns the generator as a detached subprocess
  (`jamasp farsi-brief --reply-to <message_id>`) and returns to polling
  immediately. A non-blocking `fcntl.flock` on `<db file>.farsibrief.lock`
  (`state/jamasp.db.farsibrief.lock` live; derived from the database path
  exactly as `flash.lock_path` derives `.passlock`, so each test database
  gets its own, and the file stays empty so agent commits of `state/`
  never see it change) is held by the **generator** for
  its whole run. The listener tests the lock before spawning: if it is
  held, it replies `یک بریف در حال آماده‌سازی است؛ چند دقیقه دیگر می‌رسد.`
  and does not spawn. Otherwise it replies `در حال آماده‌سازی بریف… (چند دقیقه)`
  and spawns.
- **Errors.** A network error or non-OK `getUpdates` response is logged and
  retried with backoff (2 s → 60 s cap); it never exits on a transient
  error. A missing token or chat env var exits non-zero at startup (as
  `jamasp authd` does), which reaches `OnFailure`.
- **Unit.** Modelled on `ops/systemd/jamasp-authd.service`: `Restart=always`,
  required `EnvironmentFile`, `OnFailure=jamasp-alert@%n.service`, the same
  hardening block, `MemoryMax=256M`. Installed per the `deploy` skill.

### 2. Generator — `jamasp farsi-brief` (`jamasp/farsibrief.py`)

Also usable by hand: `jamasp farsi-brief --dry-run` prints the brief instead
of sending it.

1. **Take the lock** (non-blocking). If held, exit 0 quietly — the listener
   already told the chat.
2. **Build the data bundle** from `state/jamasp.db` (read-only queries):
   - **News:** items published in the last 24 h that carry an `item_scores`
     row with `tier >= 2` (the flash pass's gold-relevance cut; ~170/day on
     the live host), newest first, capped at 150. Per item: UTC time,
     source display name, headline, lede (truncated to 400 chars).
     `tier` is used only to *select*; `direction`, `conviction`, `theme`
     and anything from `flashes` are never included.
   - **Prices:** the `pricesummary.render` block (latest values with 24 h /
     7 d changes and the GC technicals line).
   - **Calendar:** high/medium-impact events in the next 7 days (UTC and
     Dubai time), as `jamasp calendar` prints them.
   - **Excluded by construction:** `state/stance.md`, `state/watchlist.yaml`,
     `state/predictions.jsonl`, `reports/`, `item_scores` judgement columns,
     `flashes`. A test asserts no stance text reaches the prompt.
3. **Prompt** = `config/farsi_brief_prompt.md` (the style guide and shape,
   below) + the glossary from `config/glossary.fa.yaml` (so terminology
   matches the news channel and panel) + the bundle + the current UTC and
   Dubai time.
4. **Call codex** via `jamasp/modelrun.py`'s `codex` protocol with an output
   schema `{"brief": string}`. Command and timeout come from a new
   `farsi_brief:` settings block: `cmd` defaults to the translate block's
   codex command; `timeout_seconds: 600`.
5. **Send** to the desk chat via `notify.send_telegram`, as a reply to the
   triggering message when `--reply-to` is given. Text over Telegram's
   4096-char limit is split at paragraph boundaries (never mid-sentence);
   each part is logged to `notify_log`.
6. **Failure replies** (in Persian, to the chat, never silent):
   - `QuotaExhausted` → `سهمیهٔ codex فعلاً تمام شده؛ بعداً دوباره /brief بفرستید.`
   - timeout / `ModelError` / empty answer → `ساخت بریف ناموفق بود؛ دوباره امتحان کنید.`
   - Exit non-zero after replying, so the journal shows it. The generator
     runs as a child of the listener, not as its own unit, so it does not
     trigger `OnFailure` — the chat reply *is* the failure notice.

### 3. The Persian — `config/farsi_brief_prompt.md`

The prompt file is tunable without code changes. Its content requirements:

- **Write in Persian from the first word.** Do not draft in English.
- **Plain, everyday Persian** as a gold trader in Dubai speaks it: short
  sentences, active voice, common words over formal or Arabic-heavy ones,
  no calques of English structures ("در حالی که… قرار دارد" chains, passive
  stacks, "به منظور" padding).
- **Explain jargon once.** A technical term (e.g. real yield, contango,
  ATR) gets a few plain words of explanation the first time it appears.
- **Numbers and tickers stay Latin** (`GC 4220`, `DXY`, `CPI 0.3%`), per the
  desk rule; glossary terms are used exactly as pinned.
- **Shape**, with short headed sections:
  1. one-line bottom line (direction and how sure)
  2. **چه شد** — the 3–5 developments that mattered, each one or two lines
  3. **برای طلا یعنی چه** — the reasoning, the bull and bear case
  4. **چه چیزی را زیر نظر بگیریم** — the next events and the price levels
     that would change the read
  5. a closing italic line: this is an independent codex read, not Jamasp's
     view.
- **No trading instructions** (desk rule 6): conditions and reasoning, never
  "buy"/"sell".
- **Grounded only in the bundle.** No invented numbers, quotes or events; if
  the bundle is thin, say so briefly.
- Target length: 1,500–2,500 characters (one or two Telegram messages).

## Data flow

```
desk chat ──/brief──▶ jamasp-bot (getUpdates loop)
                         │ lock held? ──yes──▶ reply "busy"
                         │ no
                         ├─▶ reply "preparing…"
                         └─▶ spawn: jamasp farsi-brief --reply-to <id>
                                   │ lock
                                   │ bundle ◀── state/jamasp.db (read-only)
                                   │ codex exec (schema {"brief"})
                                   └─▶ sendMessage (reply) ─▶ desk chat
```

## Operational notes

- `getUpdates` and webhooks are mutually exclusive per bot. No webhook is
  set today; this design commits the bot to polling.
- In a group, a bot with privacy mode on still receives `/commands`, so no
  BotFather change is needed.
- codex quota is shared with the 10-minute translate pass. A `/brief` is one
  large call; heavy use can starve translation, which then backs off on its
  own `QuotaExhausted` handling. Accepted: no cap was wanted.

## Testing

Unit tests, with Telegram and codex mocked:

- listener: chat filter (desk chat only), command parsing (`/brief`,
  `/brief@me`, ignoring `/brief@other`, ignoring plain text), offset
  persistence and first-start backlog skip, busy reply when the lock is
  held, spawn when free, backoff on transient errors.
- generator: bundle selection (24 h window, tier cut, cap, no judgement
  columns), **no stance/report text in the prompt**, schema'd codex call,
  message splitting at paragraph boundaries, reply-to threading, each
  failure reply, lock skip.

After deploy: one real `/brief` in the desk chat, end to end, and the
output read for fluency before calling it done.
