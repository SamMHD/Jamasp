# Flash tiering — design

**Date:** 2026-08-17
**Status:** approved design; implementation plan follows
**Brief:** `2026-08-17-flash-tiering-brief.md` (problem, measurement, chosen direction)

The brief measured the problem and picked the direction. This doc fixes the
mechanism: what the model returns, how an item is routed, what a rollup is, and
what happens when any of it fails.

## Scope

In: a materiality tier on every classified item, tier-based routing, a periodic
Persian rollup for the middle tier, the schema and timer to support both.

Out: per-source caps and a daily volume budget (brief decisions 5 and 6 — the
tier score is the single filtering mechanism, deliberately). Also out: the
narrative-dedup gap, which tiering reduces without addressing.

## Tiers

Assigned by the existing decide call, 1–5, as defined in the brief. Only two
boundaries matter to the code:

| Tier | Route | Delivery |
|---|---|---|
| 5, 4 | `posted` | immediately to the news channel, exactly as today |
| 3 | `held` → `rolled_up` | one line in the next rollup |
| 2, 1 | `skipped_low_tier` | never posted; stays in the DB |

A dropped item is not lost information: it stays in `items`, and `inbox`, the
brief and the scan all read `items` directly, never `flashes`. The channel is
the only thing being filtered.

## Where the tier comes from

`flashtext.build_decide_prompt` already sends every candidate's headline and
lede in one batched call and asks for `gold` and `dup_of`. It gains `tier`, with
the brief's five definitions inline. No second model pass — the tier is free.

`parse_decide_response` gains a `tier` field per verdict.

**Missing or unparseable tier → treated as tier 4 (post immediately).** The
failure has to land somewhere, and today's behaviour is "post it". Silently
dropping or delaying a material item because the model omitted a field is the
worse error, and a visible over-post is self-correcting where a silent
suppression is not. Each occurrence increments a `no_tier` stat so the rate is
observable rather than assumed.

## Routing, and its interaction with dedup

Dedup runs first and is unchanged: a verdict carrying `dup_of` edits the
existing message in place. Two cases the current code does not have to consider:

1. **`dup_of` points at a `held` item.** There is no message to edit. Record
   the newcomer as `dup` and leave the held item held. The rollup line is
   written from the held item, so the story still goes out.
2. **A dup would have scored a higher tier than the item it duplicates.** The
   first verdict wins; tiers are not recomputed. Re-ranking a story because a
   second outlet wrote it up is the "coverage volume equals importance" error
   the 9 Aug retro named as a calibration bias — the same reasoning applies to
   the channel.

## The rollup

A separate pass, not part of the 15-minute flash tick.

- **Cadence:** four fixed Dubai times — 08:00, 12:00, 16:00, 20:00 — each
  covering the window since the previous rollup. Fixed local times are
  predictable for the desk in a way a rolling offset is not.
- **Floor:** fewer than 3 held items in the window → skip the send entirely and
  leave them held; they roll into the next window rather than being dropped.
  A near-empty rollup costs more attention than it returns.
- **Content:** one Persian line per story — the fact and its transmission
  channel — grouped under theme headers. One batched model call per rollup, no
  article extraction for held items. That is the cost win: ~80 extract-plus-
  write pairs a day become ~10 plus 4 rollup calls.
- **Themes** are chosen by the model from a fixed list, so rendering stays
  deterministic: `rates_dollar`, `geopolitics`, `metals_mining`, `other`.

Model contract (`build_rollup_prompt` / `parse_rollup_response`):

```json
{"groups": [{"theme": "rates_dollar", "lines": ["…", "…"]}]}
```

Rendered as a theme header per group with its lines beneath. A group with no
lines is dropped. An unknown theme is folded into `other` rather than rejected —
a mislabelled group should not lose the desk its news.

**Failure:** if the rollup call fails or returns nothing parseable, the items
stay `held` and the pass records an error. The next rollup retries them. Nothing
is marked `rolled_up` unless Telegram accepted the message.

## Schema

`connect()` only runs `CREATE TABLE IF NOT EXISTS`, so existing tables never
gain columns — a live 9MB database is already deployed. Two additions:

```sql
CREATE TABLE IF NOT EXISTS rollups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    text_fa    TEXT NOT NULL,
    message_id INTEGER,
    status     TEXT NOT NULL
);
```

and, on `flash_items`, `tier INTEGER` plus `rollup_id INTEGER`, added by an
idempotent migration step in `connect()`:

```python
def _add_missing_columns(conn):
    for table, column, decl in MIGRATIONS:
        if column not in {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
```

SQLite's `ADD COLUMN` does not rewrite the table, so this is instant on the
live DB. Recording the tier per item is what makes brief decision 5 revisitable
— "let the score handle the TA mills, then look at a week of tier data".

## Config

Under the existing `flash:` block, so one section owns the pipeline:

```yaml
flash:
  rollup_times_dubai: ["08:00", "12:00", "16:00", "20:00"]
  rollup_min_items: 3
  rollup_cmd: ["claude", "-p", "--model", "sonnet"]
  post_tier_min: 4        # at or above → immediate; 3 → rollup; below → drop
  rollup_tier_min: 3
```

Thresholds are config, not constants, because the tier definitions are a
judgement that will need tuning once a week of tier data exists.

## Delivery

A new `jamasp flash-rollup` command and a `jamasp-flash-rollup` timer at the
four Dubai times, carrying `OnFailure=jamasp-alert@%n.service` like every other
unit. The rollup is a deterministic pipeline stage, not an agent run: it
consumes no agent-run budget, exactly as the flash pass doesn't.

## Testing

Per behaviour, all with a fake model and fake poster as `test_flash.py` already
does: tier routing at each boundary (5/4 post, 3 held, 2/1 dropped); a missing
tier posting and counting `no_tier`; a dup pointing at a held item recording
`dup` without an edit attempt; the rollup floor holding items rather than
dropping them; a failed rollup call leaving items held for retry; theme folding
for an unknown label; and the migration being idempotent across two `connect()`
calls on the same file.

## Expected outcome

~10 immediate flashes plus 4 rollups ≈ **14 messages/day**, against ~90 today,
and roughly an eighth of the per-item model cost.
