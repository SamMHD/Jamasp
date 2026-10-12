# On-demand Farsi Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/brief` in the desk Telegram chat makes codex write an independent gold brief in fluent Persian and post it back to that chat.

**Architecture:** A long-polling listener (`jamasp bot`, always-on systemd unit) filters `/brief` from the desk chat, replies "preparing" or "busy", and spawns `jamasp farsi-brief --reply-to <id>`. The generator takes a lock, builds a data bundle from `state/jamasp.db` that deliberately excludes Jamasp's own views, calls codex through `modelrun.run_json` with a `{"brief": string}` schema, and sends the result (split under Telegram's limit) as a reply.

**Tech Stack:** Python 3, click, httpx, sqlite3, fcntl, pytest; codex CLI via `jamasp/modelrun.py`; systemd.

**Spec:** `docs/superpowers/specs/2026-10-12-telegram-farsi-brief-design.md`

## Global Constraints

- Desk chat id comes from env var named by `settings.telegram.chat_id_env` (`JAMASP_TG_CHAT`); token from `settings.telegram.bot_token_env` (`JAMASP_TG_TOKEN`).
- Only `/brief` and `/brief@<own bot username>` (first whitespace token, username case-insensitive) trigger; only from the desk chat.
- Always a fresh run; one at a time; no cooldown, no cache, no daily cap.
- Lock file: `<db file path>.farsibrief.lock`, always empty, derived from `PRAGMA database_list` like `flash.lock_path`.
- Bundle: items with `published_at` in the last 24 h joined to `item_scores` with `tier >= 2`, newest first, cap 150, lede truncated to 400 chars; `pricesummary.render`; `calendarview.render(conn, days=7)`. Never include `state/stance.md`, `state/watchlist.yaml`, `state/predictions.jsonl`, `reports/`, `item_scores.direction/conviction/theme`, or `flashes`.
- Codex: `modelrun.run_json(cmd, "codex", prompt, SCHEMA, timeout)`; `farsi_brief.cmd` defaults to `translate.cmd`; `farsi_brief.timeout_seconds: 600`.
- Telegram text limit 4096 chars; split at paragraph boundaries, never mid-sentence where avoidable.
- Fixed Persian replies (exact strings):
  - preparing: `در حال آماده‌سازی بریف… (چند دقیقه)`
  - busy: `یک بریف در حال آماده‌سازی است؛ چند دقیقه دیگر می‌رسد.`
  - quota: `سهمیهٔ codex فعلاً تمام شده؛ بعداً دوباره /brief بفرستید.`
  - failure: `ساخت بریف ناموفق بود؛ دوباره امتحان کنید.`
- Never mark inbox items read; never write to `state/` files other than the DB's `meta` / `notify_log` and the lock file.
- No trading instructions in the prompt's output (desk rule 6).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. `/brief` followed by extra words (`/brief now please`) or sent as a reply to another message should still trigger — first token decides. (Task 4 test.)
2. An `edited_message` update or a message with no `text` (sticker, photo) must be ignored without crashing the loop. (Task 4 test.)
3. A quiet window with zero scored news (weekend) must still produce a valid prompt that tells codex the news is thin, not crash or send an empty brief. (Task 2 test.)
4. codex answering with surrounding whitespace or a ```` ``` ```` fence around the text must be cleaned before sending; an answer that is empty after cleaning is a failure, not a blank message. (Task 3 test.)
5. A Telegram send failure for the brief (deleted trigger message, network) must log `notify_log ok=0` and exit non-zero, and replying to a deleted message must not fail at all (`allow_sending_without_reply`). (Task 1 + Task 3 tests.)

---

## File Structure

| File | Responsibility |
|---|---|
| `jamasp/notify.py` (modify) | `send_telegram(..., reply_to=)`, new `split_message()` |
| `jamasp/farsibrief.py` (create) | lock, bundle, prompt, `generate()` orchestration |
| `jamasp/bot.py` (create) | Telegram API wrapper, command parsing, update handling, poll loop |
| `jamasp/cli.py` (modify) | `farsi-brief` and `bot` commands |
| `config/farsi_brief_prompt.md` (create) | Persian style guide + brief shape (tunable) |
| `config/settings.yaml` (modify) | `farsi_brief:` block |
| `ops/systemd/jamasp-bot.service` (create) | always-on listener unit |
| `.claude/skills/deploy/SKILL.md`, `CLAUDE.md` (modify) | document the new unit and command |
| `tests/test_notify.py`, `tests/test_farsibrief.py`, `tests/test_bot.py` | tests |

---

### Task 1: Telegram reply threading and message splitting

**Files:**
- Modify: `jamasp/notify.py` (`send_telegram`, add `split_message`)
- Test: `tests/test_notify.py`

**Interfaces:**
- Produces: `send_telegram(text: str, token: str, chat_id: str, post: Poster | None = None, reply_to: int | None = None) -> int`; `split_message(text: str, limit: int = 4096) -> list[str]`; constant `TELEGRAM_LIMIT = 4096`.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_notify.py`)

```python
def test_send_telegram_threads_a_reply_and_tolerates_a_deleted_target():
    sent = {}

    def fake_post(url, data):
        sent["data"] = data
        return {"ok": True, "result": {"message_id": 9}}

    notify.send_telegram("x", "T", "-100", post=fake_post, reply_to=42)
    assert sent["data"]["reply_to_message_id"] == 42
    # a /brief deleted while codex ran must not make the brief undeliverable
    assert sent["data"]["allow_sending_without_reply"] == "true"


def test_send_telegram_without_reply_to_sends_no_reply_fields():
    sent = {}
    notify.send_telegram("x", "T", "C", post=lambda u, d: sent.update(d) or
                         {"ok": True, "result": {"message_id": 1}})
    assert "reply_to_message_id" not in sent


def test_split_message_keeps_short_text_whole():
    assert notify.split_message("سلام\n\nدنیا") == ["سلام\n\nدنیا"]


def test_split_message_breaks_at_paragraphs_under_the_limit():
    paras = ["ا" * 30, "ب" * 30, "پ" * 30]
    # two paragraphs + separator = 62 chars fit under 70; the third does not
    parts = notify.split_message("\n\n".join(paras), limit=70)
    assert parts == [f"{paras[0]}\n\n{paras[1]}", paras[2]]


def test_split_message_falls_back_to_lines_then_hard_cut():
    text = ("a" * 50 + "\n") * 3 + "b" * 200
    parts = notify.split_message(text, limit=80)
    assert all(len(p) <= 80 for p in parts)
    assert "".join(parts).replace("\n", "") == text.replace("\n", "")
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/test_notify.py -q`
Expected: FAIL — `send_telegram() got an unexpected keyword argument 'reply_to'`, `module has no attribute 'split_message'`.

- [ ] **Step 3: Implement** in `jamasp/notify.py`

Replace `send_telegram` with:

```python
TELEGRAM_LIMIT = 4096


def send_telegram(
    text: str, token: str, chat_id: str, post: Poster | None = None,
    reply_to: int | None = None,
) -> int:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data: dict = {"chat_id": chat_id, "text": text}
    if reply_to is not None:
        data["reply_to_message_id"] = reply_to
        # The trigger may be deleted while the reply is being prepared; send
        # anyway rather than lose minutes of work to a missing anchor.
        data["allow_sending_without_reply"] = "true"
    result = (post or _default_post)(url, data)
    if not result.get("ok"):
        raise RuntimeError(f"telegram send failed: {result.get('description', result)}")
    return int(result["result"]["message_id"])
```

Add after it:

```python
def _pack(pieces: list[str], sep: str, limit: int) -> list[str]:
    parts: list[str] = []
    current = ""
    for piece in pieces:
        candidate = f"{current}{sep}{piece}" if current else piece
        if len(candidate) <= limit:
            current = candidate
            continue
        if current:
            parts.append(current)
        current = piece
    if current:
        parts.append(current)
    return parts


def split_message(text: str, limit: int = TELEGRAM_LIMIT) -> list[str]:
    """Split text into Telegram-sized parts: paragraphs, then lines, then a
    hard cut — the coarsest boundary that fits wins, so a reader never sees a
    sentence torn across two messages unless one line alone is over limit."""
    if len(text) <= limit:
        return [text]
    out: list[str] = []
    for para in _pack(text.split("\n\n"), "\n\n", limit):
        if len(para) <= limit:
            out.append(para)
            continue
        for line in _pack(para.split("\n"), "\n", limit):
            while len(line) > limit:
                out.append(line[:limit])
                line = line[limit:]
            if line:
                out.append(line)
    return out
```

- [ ] **Step 4: Run tests**

Run: `uv run pytest tests/test_notify.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add jamasp/notify.py tests/test_notify.py
git commit -m "feat(notify): reply threading and paragraph-aware message splitting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Data bundle, lock, prompt, config

**Files:**
- Create: `jamasp/farsibrief.py`, `config/farsi_brief_prompt.md`
- Modify: `config/settings.yaml` (add `farsi_brief:` block after `translate:` block)
- Test: `tests/test_farsibrief.py`

**Interfaces:**
- Consumes: `pricesummary.render(conn, now=None) -> str`; `calendarview.render(conn, days=7, now=None) -> str`; `config.load_glossary(path) -> dict[str, str]`.
- Produces:
  - `lock_path(conn) -> str`
  - `run_lock(conn)` context manager yielding `bool` (True = acquired)
  - `lock_is_held(conn) -> bool`
  - `build_bundle(conn, names: dict[str, str], now: str | None = None) -> str`
  - `build_prompt(style: str, glossary: dict[str, str], bundle: str, now: str) -> str`
  - constants `SCHEMA`, `NEWS_WINDOW_HOURS = 24`, `NEWS_TIER_MIN = 2`, `NEWS_CAP = 150`, `LEDE_CHARS = 400`, `NO_NEWS = "(no scored gold news in the last 24 hours)"`

- [ ] **Step 1: Write the failing tests** — create `tests/test_farsibrief.py`

```python
from datetime import datetime, timedelta, timezone

import pytest

from jamasp import db, farsibrief
from jamasp.ingest import prices, rss
from jamasp.models import Item

NOW = "2026-10-12T10:00:00Z"


def ago(hours):
    dt = datetime(2026, 10, 12, 10, tzinfo=timezone.utc) - timedelta(hours=hours)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def seed(conn, specs):
    """specs: (headline, hours_ago, tier or None). Returns ids."""
    items = [Item(id=f"i{n}", source="reuters", published_at=ago(h), headline=head,
                  url=f"https://e/{n}", topic="gold", lede=f"lede {head}")
             for n, (head, h, _) in enumerate(specs)]
    rss.store_items(conn, items)
    for it, (_, _, tier) in zip(items, specs):
        if tier is not None:
            conn.execute(
                "INSERT INTO item_scores (item_id, tier, direction, conviction,"
                " theme, scored_at) VALUES (?, ?, 1, 0.9, 'SECRET_THEME', ?)",
                (it.id, tier, NOW))
    conn.commit()
    return [it.id for it in items]


@pytest.fixture
def conn(tmp_path):
    return db.connect(tmp_path / "t.db")


def test_bundle_selects_recent_scored_items_at_or_above_the_tier_cut(conn):
    seed(conn, [("Fresh tier3", 1, 3), ("Fresh tier1", 2, 1),
                ("Old tier4", 30, 4), ("Unscored", 1, None)])
    bundle = farsibrief.build_bundle(conn, {"reuters": "Reuters"}, now=NOW)
    assert "Fresh tier3" in bundle and "Reuters" in bundle
    assert "Fresh tier1" not in bundle
    assert "Old tier4" not in bundle
    assert "Unscored" not in bundle


def test_bundle_never_carries_judgement_columns(conn):
    seed(conn, [("Fed holds", 1, 4)])
    bundle = farsibrief.build_bundle(conn, {}, now=NOW)
    assert "SECRET_THEME" not in bundle
    assert "conviction" not in bundle.lower()


def test_bundle_caps_news_and_truncates_ledes(conn):
    seed(conn, [(f"H{n}", 0.01 * n, 2) for n in range(farsibrief.NEWS_CAP + 5)])
    conn.execute("UPDATE items SET lede = ? WHERE id = 'i0'", ("x" * 1000,))
    conn.commit()
    bundle = farsibrief.build_bundle(conn, {}, now=NOW)
    assert bundle.count("\n- ") == farsibrief.NEWS_CAP
    assert "x" * (farsibrief.LEDE_CHARS + 1) not in bundle


def test_bundle_with_no_news_says_so(conn):
    bundle = farsibrief.build_bundle(conn, {}, now=NOW)
    assert farsibrief.NO_NEWS in bundle


def test_bundle_includes_prices(conn):
    prices.store_price(conn, "GC", "2026-10-12T09:00:00Z", 4220.3)
    assert "GC 4220.3" in farsibrief.build_bundle(conn, {}, now=NOW)


def test_bundle_does_not_mark_items_read(conn):
    seed(conn, [("Fed holds", 1, 4)])
    farsibrief.build_bundle(conn, {}, now=NOW)
    assert conn.execute("SELECT read_at FROM items").fetchone()[0] is None


def test_prompt_carries_style_glossary_bundle_and_both_clocks():
    p = farsibrief.build_prompt("STYLE", {"Fed": "فدرال رزرو"}, "BUNDLE", NOW)
    assert "STYLE" in p and "BUNDLE" in p
    assert "Fed: فدرال رزرو" in p
    assert "2026-10-12 10:00 UTC" in p and "14:00 Dubai" in p


def test_prompt_never_reads_stance_from_disk(tmp_path, monkeypatch, conn):
    # build_bundle must be self-contained: even with a stance file present in
    # the working directory, nothing from it reaches the prompt.
    (tmp_path / "state").mkdir()
    (tmp_path / "state" / "stance.md").write_text("STANCE_MARKER")
    monkeypatch.chdir(tmp_path)
    p = farsibrief.build_prompt("S", {}, farsibrief.build_bundle(conn, {}, now=NOW), NOW)
    assert "STANCE_MARKER" not in p


def test_lock_is_exclusive_and_released(conn):
    assert not farsibrief.lock_is_held(conn)
    with farsibrief.run_lock(conn) as got:
        assert got
        assert farsibrief.lock_is_held(conn)
        with farsibrief.run_lock(conn) as second:
            assert not second
    assert not farsibrief.lock_is_held(conn)
    assert farsibrief.lock_path(conn).endswith("t.db.farsibrief.lock")
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/test_farsibrief.py -q`
Expected: FAIL — `cannot import name 'farsibrief'`.

- [ ] **Step 3: Implement** — create `jamasp/farsibrief.py`

```python
"""On-demand independent Farsi brief, written by codex for the desk chat.

Independent by construction: the bundle is built from raw news, prices and
the calendar only. Jamasp's stance, reports, predictions and the flash
pass's judgements (direction, conviction, theme, Persian summaries) never
reach the prompt — the desk asked for a second opinion, not an echo.
"""
from __future__ import annotations

import contextlib
import fcntl
import sqlite3
from datetime import datetime, timedelta, timezone

from jamasp import calendarview, pricesummary
from jamasp.db import utcnow

NEWS_WINDOW_HOURS = 24
NEWS_TIER_MIN = 2
NEWS_CAP = 150
LEDE_CHARS = 400
NO_NEWS = "(no scored gold news in the last 24 hours)"
DUBAI = timezone(timedelta(hours=4))

SCHEMA = {
    "type": "object",
    "properties": {"brief": {"type": "string"}},
    "required": ["brief"],
    "additionalProperties": False,
}


def lock_path(conn: sqlite3.Connection) -> str:
    """`<db file>.farsibrief.lock`, derived like flash.lock_path so every
    database (live, or a test's tmp one) has its own. Always empty, so the
    agent runs' `git add state/` never sees it change."""
    row = conn.execute("PRAGMA database_list").fetchone()
    dbfile = (row["file"] if row else "") or ""
    return f"{dbfile}.farsibrief.lock" if dbfile else ""


@contextlib.contextmanager
def run_lock(conn: sqlite3.Connection):
    path = lock_path(conn)
    if not path:
        yield True
        return
    handle = open(path, "a")
    try:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)
    finally:
        handle.close()


def lock_is_held(conn: sqlite3.Connection) -> bool:
    with run_lock(conn) as got:
        return not got


def _parse(ts: str) -> datetime:
    return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _news(conn: sqlite3.Connection, names: dict[str, str], now: str) -> str:
    since = (_parse(now) - timedelta(hours=NEWS_WINDOW_HOURS)).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    rows = conn.execute(
        "SELECT i.published_at, i.source, i.headline, i.lede FROM items i"
        " JOIN item_scores s ON s.item_id = i.id"
        " WHERE i.published_at >= ? AND i.published_at <= ? AND s.tier >= ?"
        " ORDER BY i.published_at DESC LIMIT ?",
        (since, now, NEWS_TIER_MIN, NEWS_CAP),
    ).fetchall()
    if not rows:
        return NO_NEWS
    lines = []
    for r in rows:
        lede = (r["lede"] or "").strip().replace("\n", " ")[:LEDE_CHARS]
        source = names.get(r["source"], r["source"])
        line = f"- {r['published_at'][:16].replace('T', ' ')}Z [{source}] {r['headline']}"
        lines.append(f"{line} — {lede}" if lede else line)
    return "\n".join(lines)


def build_bundle(conn: sqlite3.Connection, names: dict[str, str],
                 now: str | None = None) -> str:
    now = now or utcnow()
    return (
        f"## News (last {NEWS_WINDOW_HOURS}h, newest first)\n"
        f"{_news(conn, names, now)}\n\n"
        f"## Prices (latest, with 24h/7d change)\n"
        f"{pricesummary.render(conn, now=now)}\n\n"
        f"## Calendar (next 7 days, JSONL)\n"
        f"{calendarview.render(conn, days=7, now=now) or '(none)'}\n"
    )


def build_prompt(style: str, glossary: dict[str, str], bundle: str, now: str) -> str:
    dt = _parse(now)
    clock = (f"{dt:%Y-%m-%d %H:%M} UTC ({dt.astimezone(DUBAI):%H:%M} Dubai)")
    terms = "\n".join(f"{en}: {fa}" for en, fa in glossary.items()) or "(none)"
    return (
        f"{style.strip()}\n\n"
        f"# Current time\n{clock}\n\n"
        f"# Pinned Persian terms (use exactly)\n{terms}\n\n"
        f"# Data (your only source; do not invent anything beyond it)\n{bundle}"
    )
```

Note `build_prompt` must render `14:00 Dubai` for `NOW`: `f"{dt.astimezone(DUBAI):%H:%M} Dubai"` yields `(14:00 Dubai)`, which contains `14:00 Dubai`. ✔

Create `config/farsi_brief_prompt.md`:

```markdown
You are an experienced gold-market analyst writing a short market brief for
the trading desk of a physical gold company in Dubai. The readers are
Persian-speaking traders. Read the data below and form YOUR OWN view of what
it means for gold over the next few days.

# Language — this matters more than anything else

- Write in Persian from the very first word. Do not draft in English and
  translate; think and write in Persian.
- Plain, everyday Persian, the way an experienced Persian-speaking trader
  talks to colleagues: short sentences, active voice, common words. Prefer
  "بالا رفت" over "افزایش یافت" where it reads naturally; avoid formal,
  bureaucratic or Arabic-heavy wording.
- No translationese: no long "در حالی که … قرار دارد" chains, no stacked
  passives, no "به منظور"/"در راستای" padding, no English word order.
- The first time a technical term appears (real yield, contango, ATR, RSI,
  pivot …), explain it in a few plain words in parentheses.
- Keep numbers, prices, percentages and tickers in Latin script: GC 4220,
  DXY 102.2, CPI 0.3%, 14:00. Times are Dubai time unless marked UTC.
- Use the pinned Persian terms exactly as given.

# Shape (Telegram plain text — no markdown symbols like ** or #)

1. One opening line: the bottom line — which way gold is leaning and how
   sure you are (e.g. «جمع‌بندی: …»).
2. «چه شد» — the 3 to 5 developments that actually mattered, one or two
   lines each, starting with "•".
3. «برای طلا یعنی چه» — your reasoning: what pushes gold up, what pushes it
   down, and which side is winning now.
4. «چه چیزی را زیر نظر بگیریم» — the next events (with Dubai time) and the
   price levels that would change this view.
5. A last line exactly: «این تحلیل مستقل codex است، نه دیدگاه جاماسپ.»

Length: about 1,500 to 2,500 characters.

# Rules

- Use only the data provided. Never invent numbers, quotes, people or
  events. If the news is thin, say so in one line and keep the brief short.
- Describe conditions and reasoning only. Never tell anyone to buy or sell,
  and never give entry, exit or position advice.
- Return the brief as the "brief" field of the JSON answer.
```

Append to `config/settings.yaml` (after the `translate:` block ends — place it as a new top-level key at the end of the file):

```yaml
farsi_brief:
  # `/brief` in the desk chat (jamasp bot → jamasp farsi-brief). An
  # independent read by codex, in Persian — see
  # docs/superpowers/specs/2026-10-12-telegram-farsi-brief-design.md.
  # cmd omitted = reuse translate.cmd (same codex, same flags). One call
  # writes the whole brief, so it gets a far longer ceiling than a
  # translate batch.
  timeout_seconds: 600
```

- [ ] **Step 4: Run tests**

Run: `uv run pytest tests/test_farsibrief.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add jamasp/farsibrief.py config/farsi_brief_prompt.md config/settings.yaml tests/test_farsibrief.py
git commit -m "feat(farsi-brief): independent data bundle, lock and Persian prompt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Generator orchestration + `jamasp farsi-brief` command

**Files:**
- Modify: `jamasp/farsibrief.py` (add `generate`, `FarsiBriefFailed`, reply constants, `_clean`)
- Modify: `jamasp/cli.py` (add `farsi-brief` command; import `farsibrief as farsibrief_mod`)
- Test: `tests/test_farsibrief.py`

**Interfaces:**
- Consumes: Task 1 `notify.send_telegram(..., reply_to=)`, `notify.split_message`, `notify.resolve_chat(settings, "desk") -> (token, chat_id)`, `notify.log_sent(conn, text, ok)`; Task 2 `run_lock`, `build_bundle`, `build_prompt`, `SCHEMA`; `modelrun.run_json`, `modelrun.ModelError`, `modelrun.QuotaExhausted`; `config.load_glossary`.
- Produces:
  - `MSG_PREPARING`, `MSG_BUSY`, `MSG_QUOTA`, `MSG_FAILED` (exact strings from Global Constraints)
  - `class FarsiBriefFailed(RuntimeError)`
  - `generate(conn, settings: dict, config_dir: Path, names: dict[str, str], reply_to: int | None = None, dry_run: bool = False, run=modelrun.run_json, post=None, now: str | None = None) -> str` — returns `"busy"`, the brief text when `dry_run`, or `"sent N part(s)"`; raises `FarsiBriefFailed` after posting the failure reply.
  - CLI: `jamasp farsi-brief [--reply-to ID] [--dry-run] [--db] [--config-dir]`

- [ ] **Step 1: Write the failing tests** (append to `tests/test_farsibrief.py`)

```python
from pathlib import Path

from jamasp import modelrun

CONFIG = Path(__file__).parent.parent / "config"
SETTINGS = {
    "telegram": {"bot_token_env": "JAMASP_TG_TOKEN", "chat_id_env": "JAMASP_TG_CHAT"},
    "translate": {"cmd": ["codex", "exec"], "protocol": "codex"},
    "farsi_brief": {"timeout_seconds": 600},
}


@pytest.fixture
def tg(monkeypatch):
    monkeypatch.setenv("JAMASP_TG_TOKEN", "T")
    monkeypatch.setenv("JAMASP_TG_CHAT", "-100")
    sent = []

    def post(url, data):
        sent.append(data)
        return {"ok": True, "result": {"message_id": len(sent)}}
    return sent, post


def test_generate_calls_codex_with_schema_and_replies(conn, tg):
    sent, post = tg
    calls = {}

    def run(cmd, protocol, prompt, schema, timeout):
        calls.update(cmd=cmd, protocol=protocol, schema=schema, timeout=timeout,
                     prompt=prompt)
        return {"brief": "  جمع‌بندی: طلا آرام است.  "}

    out = farsibrief.generate(conn, SETTINGS, CONFIG, {}, reply_to=7, run=run,
                              post=post, now=NOW)
    assert calls["cmd"] == ["codex", "exec"] and calls["protocol"] == "codex"
    assert calls["schema"] == farsibrief.SCHEMA and calls["timeout"] == 600
    assert "Plain, everyday Persian" in calls["prompt"]  # the prompt file
    assert sent[0]["text"] == "جمع‌بندی: طلا آرام است."
    assert sent[0]["reply_to_message_id"] == 7
    assert out == "sent 1 part(s)"
    assert conn.execute("SELECT ok FROM notify_log").fetchone()[0] == 1


def test_generate_strips_a_code_fence(conn, tg):
    sent, post = tg
    run = lambda *a, **k: {"brief": "```\nمتن بریف\n```"}
    farsibrief.generate(conn, SETTINGS, CONFIG, {}, run=run, post=post, now=NOW)
    assert sent[0]["text"] == "متن بریف"


def test_generate_splits_a_long_brief(conn, tg):
    sent, post = tg
    long = "\n\n".join(["پاراگراف " * 300] * 3)
    farsibrief.generate(conn, SETTINGS, CONFIG, {}, reply_to=7,
                        run=lambda *a, **k: {"brief": long}, post=post, now=NOW)
    assert len(sent) > 1 and all(len(d["text"]) <= 4096 for d in sent)
    assert sent[0]["reply_to_message_id"] == 7
    assert "reply_to_message_id" not in sent[1]


def test_generate_dry_run_returns_text_without_sending(conn, tg):
    sent, post = tg
    out = farsibrief.generate(conn, SETTINGS, CONFIG, {}, dry_run=True,
                              run=lambda *a, **k: {"brief": "متن"}, post=post, now=NOW)
    assert out == "متن" and sent == []


@pytest.mark.parametrize("exc,msg", [
    (modelrun.QuotaExhausted("usage limit"), farsibrief.MSG_QUOTA),
    (modelrun.ModelError("timed out"), farsibrief.MSG_FAILED),
])
def test_generate_reports_codex_failures_to_the_chat(conn, tg, exc, msg):
    sent, post = tg

    def run(*a, **k):
        raise exc
    with pytest.raises(farsibrief.FarsiBriefFailed):
        farsibrief.generate(conn, SETTINGS, CONFIG, {}, reply_to=3, run=run,
                            post=post, now=NOW)
    assert sent[0]["text"] == msg and sent[0]["reply_to_message_id"] == 3


def test_generate_treats_an_empty_brief_as_failure(conn, tg):
    sent, post = tg
    with pytest.raises(farsibrief.FarsiBriefFailed):
        farsibrief.generate(conn, SETTINGS, CONFIG, {},
                            run=lambda *a, **k: {"brief": " ``` ``` "}, post=post, now=NOW)
    assert sent[0]["text"] == farsibrief.MSG_FAILED


def test_generate_logs_a_failed_send_and_raises(conn, monkeypatch):
    monkeypatch.setenv("JAMASP_TG_TOKEN", "T")
    monkeypatch.setenv("JAMASP_TG_CHAT", "-100")
    bad = lambda u, d: {"ok": False, "description": "chat not found"}
    with pytest.raises(farsibrief.FarsiBriefFailed):
        farsibrief.generate(conn, SETTINGS, CONFIG, {},
                            run=lambda *a, **k: {"brief": "متن"}, post=bad, now=NOW)
    assert conn.execute("SELECT ok FROM notify_log").fetchone()[0] == 0


def test_generate_skips_quietly_when_another_run_holds_the_lock(conn, tg):
    sent, post = tg
    with farsibrief.run_lock(conn):
        out = farsibrief.generate(conn, SETTINGS, CONFIG, {},
                                  run=lambda *a, **k: pytest.fail("ran"), post=post, now=NOW)
    assert out == "busy" and sent == []
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/test_farsibrief.py -q`
Expected: FAIL — `module 'jamasp.farsibrief' has no attribute 'generate'`.

- [ ] **Step 3: Implement** — append to `jamasp/farsibrief.py`

Add imports at the top (merge with existing):

```python
from pathlib import Path

from jamasp import calendarview, modelrun, notify, pricesummary
from jamasp.config import load_glossary
```

Append:

```python
MSG_PREPARING = "در حال آماده‌سازی بریف… (چند دقیقه)"
MSG_BUSY = "یک بریف در حال آماده‌سازی است؛ چند دقیقه دیگر می‌رسد."
MSG_QUOTA = "سهمیهٔ codex فعلاً تمام شده؛ بعداً دوباره /brief بفرستید."
MSG_FAILED = "ساخت بریف ناموفق بود؛ دوباره امتحان کنید."
PROMPT_FILE = "farsi_brief_prompt.md"


class FarsiBriefFailed(RuntimeError):
    """The brief could not be produced or delivered; the chat has been told."""


def _clean(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
    if text.rstrip().endswith("```"):
        text = text.rstrip()[:-3]
    return text.strip().strip("`").strip()


def _send(conn, token, chat_id, text, post, reply_to) -> None:
    try:
        notify.send_telegram(text, token, chat_id, post=post, reply_to=reply_to)
    except Exception:
        notify.log_sent(conn, text, ok=False)
        raise
    notify.log_sent(conn, text, ok=True)


def generate(conn, settings: dict, config_dir: Path, names: dict[str, str],
             reply_to: int | None = None, dry_run: bool = False,
             run=modelrun.run_json, post=None, now: str | None = None) -> str:
    with run_lock(conn) as got:
        if not got:
            return "busy"
        now = now or utcnow()
        cfg = settings.get("farsi_brief", {})
        tcfg = settings["translate"]
        cmd = cfg.get("cmd") or tcfg["cmd"]
        style = (Path(config_dir) / PROMPT_FILE).read_text(encoding="utf-8")
        try:
            glossary = load_glossary(Path(config_dir) / "glossary.fa.yaml")
        except OSError:
            glossary = {}
        prompt = build_prompt(style, glossary, build_bundle(conn, names, now), now)
        token = chat_id = None
        if not dry_run:
            token, chat_id = notify.resolve_chat(settings, "desk")

        def fail(message: str, why: str):
            if not dry_run:
                with contextlib.suppress(Exception):
                    _send(conn, token, chat_id, message, post, reply_to)
            raise FarsiBriefFailed(why)

        try:
            answer = run(cmd, "codex", prompt, SCHEMA,
                         int(cfg.get("timeout_seconds", 600)))
        except modelrun.QuotaExhausted as exc:
            fail(MSG_QUOTA, f"codex quota: {exc}")
        except modelrun.ModelError as exc:
            fail(MSG_FAILED, f"codex failed: {exc}")
        brief = _clean(str(answer.get("brief", "")))
        if not brief:
            fail(MSG_FAILED, "codex returned an empty brief")
        if dry_run:
            return brief
        parts = notify.split_message(brief)
        try:
            for n, part in enumerate(parts):
                _send(conn, token, chat_id, part, post, reply_to if n == 0 else None)
        except Exception as exc:
            raise FarsiBriefFailed(f"telegram send failed: {exc}") from exc
        return f"sent {len(parts)} part(s)"
```

In `jamasp/cli.py`, add `from jamasp import farsibrief as farsibrief_mod` to the import block (alphabetical, after `extract`), and `display_names` to the `jamasp.config` import line. Add the command after `calendar`:

```python
@main.command("farsi-brief")
@click.option("--reply-to", type=int, default=None, help="desk message id to reply to")
@click.option("--dry-run", is_flag=True, help="print the brief; don't send")
@db_opt
@cfg_opt
def farsi_brief(reply_to, dry_run, db_path, config_dir):
    """Write an independent Persian brief with codex and send it to the desk."""
    conn, sources, settings = _common(db_path, config_dir)
    try:
        out = farsibrief_mod.generate(
            conn, settings, Path(config_dir), display_names(sources),
            reply_to=reply_to, dry_run=dry_run,
        )
    except farsibrief_mod.FarsiBriefFailed as exc:
        click.echo(f"farsi-brief: failed — {exc}", err=True)
        raise SystemExit(1)
    click.echo(out)
```

- [ ] **Step 4: Run tests**

Run: `uv run pytest tests/test_farsibrief.py tests/test_notify.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add jamasp/farsibrief.py jamasp/cli.py tests/test_farsibrief.py
git commit -m "feat(farsi-brief): codex call, delivery, failure replies and CLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Listener — `jamasp bot`

**Files:**
- Create: `jamasp/bot.py`
- Modify: `jamasp/cli.py` (add `bot` command; import `bot as bot_mod`)
- Test: `tests/test_bot.py`

**Interfaces:**
- Consumes: Task 2 `farsibrief.lock_is_held(conn)`; Task 3 `MSG_PREPARING`, `MSG_BUSY`; `notify.send_telegram(..., reply_to=)`; `db.get_meta/set_meta`.
- Produces:
  - `class TelegramAPI(token: str, post=None)` with `.call(method: str, params: dict, timeout: float = 30) -> object` (raises `TelegramError` on `ok: false`)
  - `parse_command(text: str | None, username: str) -> str | None` → `"brief"` or `None`
  - `initial_offset(conn, api) -> int`
  - `handle_update(update: dict, conn, api, desk_chat_id: str, username: str, spawn) -> None`
  - `poll_once(conn, api, desk_chat_id, username, spawn, offset: int, timeout: int = 50) -> int`
  - `run_forever(conn, api, desk_chat_id, spawn, sleep=time.sleep, stop=lambda: False) -> None`
  - `OFFSET_KEY = "bot_update_offset"`

- [ ] **Step 1: Write the failing tests** — create `tests/test_bot.py`

```python
import pytest

from jamasp import bot, db, farsibrief

DESK = "-100"


class FakeAPI:
    def __init__(self, updates=None):
        self.updates = list(updates or [])
        self.calls = []

    def call(self, method, params, timeout=30):
        self.calls.append((method, params))
        if method == "getMe":
            return {"username": "JamaspBot"}
        if method == "getUpdates":
            off = params.get("offset", 0)
            if off == -1:
                return self.updates[-1:]
            return [u for u in self.updates if u["update_id"] >= off]
        if method == "sendMessage":
            return {"message_id": 1}
        raise AssertionError(method)

    def sent(self):
        return [p for m, p in self.calls if m == "sendMessage"]


def msg(uid, text, chat=DESK, mid=50):
    return {"update_id": uid, "message": {"message_id": mid, "chat": {"id": int(chat)},
                                          "text": text}}


@pytest.fixture
def conn(tmp_path):
    return db.connect(tmp_path / "t.db")


@pytest.mark.parametrize("text,expected", [
    ("/brief", "brief"),
    ("/brief now please", "brief"),
    ("/brief@JamaspBot", "brief"),
    ("/brief@jamaspbot", "brief"),
    ("/brief@OtherBot", None),
    ("/briefing", None),
    ("brief", None),
    ("", None),
    (None, None),
])
def test_parse_command(text, expected):
    assert bot.parse_command(text, "JamaspBot") == expected


def test_brief_from_desk_replies_preparing_and_spawns(conn):
    api, spawned = FakeAPI(), []
    bot.handle_update(msg(1, "/brief", mid=77), conn, api, DESK, "JamaspBot", spawned.append)
    assert spawned == [77]
    assert api.sent()[0]["text"] == farsibrief.MSG_PREPARING
    assert api.sent()[0]["reply_to_message_id"] == 77


def test_brief_from_another_chat_is_ignored(conn):
    api, spawned = FakeAPI(), []
    bot.handle_update(msg(1, "/brief", chat="-999"), conn, api, DESK, "JamaspBot", spawned.append)
    assert spawned == [] and api.sent() == []


@pytest.mark.parametrize("update", [
    {"update_id": 1, "edited_message": {"chat": {"id": -100}, "text": "/brief"}},
    {"update_id": 1, "message": {"message_id": 5, "chat": {"id": -100}, "sticker": {}}},
])
def test_non_text_and_edited_updates_are_ignored(conn, update):
    api, spawned = FakeAPI(), []
    bot.handle_update(update, conn, api, DESK, "JamaspBot", spawned.append)
    assert spawned == [] and api.sent() == []


def test_busy_reply_when_a_brief_is_running(conn):
    api, spawned = FakeAPI(), []
    with farsibrief.run_lock(conn):
        bot.handle_update(msg(1, "/brief"), conn, api, DESK, "JamaspBot", spawned.append)
    assert spawned == []
    assert api.sent()[0]["text"] == farsibrief.MSG_BUSY


def test_first_start_skips_the_backlog_and_persists_the_offset(conn):
    api = FakeAPI([msg(10, "/brief"), msg(11, "/brief")])
    assert bot.initial_offset(conn, api) == 12
    assert db.get_meta(conn, bot.OFFSET_KEY) == "12"


def test_restart_resumes_from_the_stored_offset(conn):
    db.set_meta(conn, bot.OFFSET_KEY, "11")
    api = FakeAPI([msg(10, "/brief"), msg(11, "/brief")])
    assert bot.initial_offset(conn, api) == 11
    spawned = []
    new = bot.poll_once(conn, api, DESK, "JamaspBot", spawned.append, 11)
    assert new == 12 and len(spawned) == 1
    assert db.get_meta(conn, bot.OFFSET_KEY) == "12"


def test_first_start_with_no_updates_starts_at_zero(conn):
    assert bot.initial_offset(conn, FakeAPI()) == 0


def test_a_failing_update_does_not_stall_the_offset(conn):
    api = FakeAPI([msg(1, "/brief"), msg(2, "/brief")])

    def spawn(mid):
        raise OSError("fork failed")
    assert bot.poll_once(conn, api, DESK, "JamaspBot", spawn, 0) == 3


def test_run_forever_backs_off_on_errors(conn):
    class Flaky(FakeAPI):
        n = 0

        def call(self, method, params, timeout=30):
            if method == "getUpdates" and params.get("offset") != -1:
                Flaky.n += 1
                raise bot.TelegramError("502")
            return super().call(method, params, timeout)
    sleeps = []
    bot.run_forever(conn, Flaky(), DESK, lambda m: None, sleep=sleeps.append,
                    stop=lambda: len(sleeps) >= 7)
    assert sleeps == [2, 4, 8, 16, 32, 60, 60]
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/test_bot.py -q`
Expected: FAIL — `cannot import name 'bot'`.

- [ ] **Step 3: Implement** — create `jamasp/bot.py`

```python
"""Desk Telegram listener: long-polls getUpdates and serves `/brief`.

Polling, not a webhook: the panel's host sits behind Cloudflare Access, and
polling needs no inbound exposure at all. The two are mutually exclusive per
bot, so this commits the bot to polling.

The listener decides WHETHER to run; `jamasp farsi-brief` decides WHAT to
say. It returns to polling at once after spawning, so a slow codex run never
delays the next update.
"""
from __future__ import annotations

import logging
import time

import httpx

from jamasp import db, farsibrief

log = logging.getLogger("jamasp.bot")
OFFSET_KEY = "bot_update_offset"
POLL_TIMEOUT = 50
BACKOFF_MAX = 60


class TelegramError(RuntimeError):
    pass


class TelegramAPI:
    def __init__(self, token: str, post=None):
        self._base = f"https://api.telegram.org/bot{token}"
        self._post = post

    def call(self, method: str, params: dict, timeout: float = 30):
        if self._post:
            body = self._post(f"{self._base}/{method}", params)
        else:
            body = httpx.post(f"{self._base}/{method}", json=params,
                              timeout=timeout).json()
        if not body.get("ok"):
            raise TelegramError(f"{method}: {body.get('description', body)}")
        return body["result"]


def parse_command(text: str | None, username: str) -> str | None:
    if not text:
        return None
    first = text.split(maxsplit=1)[0] if text.split() else ""
    name, _, target = first.partition("@")
    if name != "/brief":
        return None
    if target and target.lower() != username.lower():
        return None
    return "brief"


def _reply(api, chat_id, text: str, reply_to: int) -> None:
    api.call("sendMessage", {"chat_id": chat_id, "text": text,
                             "reply_to_message_id": reply_to,
                             "allow_sending_without_reply": True})


def handle_update(update: dict, conn, api, desk_chat_id: str, username: str,
                  spawn) -> None:
    message = update.get("message")
    if not message or str(message.get("chat", {}).get("id")) != str(desk_chat_id):
        return
    if parse_command(message.get("text"), username) != "brief":
        return
    mid = message["message_id"]
    if farsibrief.lock_is_held(conn):
        _reply(api, desk_chat_id, farsibrief.MSG_BUSY, mid)
        return
    _reply(api, desk_chat_id, farsibrief.MSG_PREPARING, mid)
    spawn(mid)


def initial_offset(conn, api) -> int:
    stored = db.get_meta(conn, OFFSET_KEY)
    if stored is not None:
        return int(stored)
    # First start: commands sent before the listener existed are stale.
    latest = api.call("getUpdates", {"offset": -1, "timeout": 0})
    offset = latest[-1]["update_id"] + 1 if latest else 0
    db.set_meta(conn, OFFSET_KEY, str(offset))
    return offset


def poll_once(conn, api, desk_chat_id: str, username: str, spawn,
              offset: int, timeout: int = POLL_TIMEOUT) -> int:
    updates = api.call(
        "getUpdates",
        {"offset": offset, "timeout": timeout, "allowed_updates": ["message"]},
        timeout=timeout + 10,
    )
    for update in updates:
        try:
            handle_update(update, conn, api, desk_chat_id, username, spawn)
        except Exception:  # one bad update must not stall the queue
            log.exception("update %s failed", update.get("update_id"))
        offset = update["update_id"] + 1
        db.set_meta(conn, OFFSET_KEY, str(offset))
    return offset


def run_forever(conn, api, desk_chat_id: str, spawn, sleep=time.sleep,
                stop=lambda: False) -> None:
    username = api.call("getMe", {})["username"]
    offset = initial_offset(conn, api)
    log.info("listening as @%s for the desk chat, offset %s", username, offset)
    delay = 2
    while not stop():
        try:
            offset = poll_once(conn, api, desk_chat_id, username, spawn, offset)
            delay = 2
        except Exception as exc:
            log.warning("poll failed (%s); retrying in %ss", exc, delay)
            sleep(delay)
            delay = min(delay * 2, BACKOFF_MAX)
```

In `jamasp/cli.py`, add `from jamasp import bot as bot_mod` (alphabetical, after `authd`) and the command after `authd`:

```python
@main.command()
@db_opt
@cfg_opt
def bot(db_path, config_dir):
    """Listen on the desk Telegram chat and serve /brief (long-polling)."""
    import logging
    import subprocess

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    conn, _, settings = _common(db_path, config_dir)
    try:
        token, chat_id = notify_mod.resolve_chat(settings, "desk")
    except RuntimeError as exc:
        raise click.ClickException(str(exc))

    def spawn(message_id: int) -> None:
        # Detached so the listener returns to polling at once; output goes to
        # the listener's journal. `jamasp` resolves to this venv's entry point
        # because the unit runs under `uv run`.
        subprocess.Popen(
            ["jamasp", "farsi-brief", "--reply-to", str(message_id),
             "--db", db_path, "--config-dir", config_dir],
            start_new_session=True,
        )

    bot_mod.run_forever(conn, bot_mod.TelegramAPI(token), chat_id, spawn)
```

- [ ] **Step 4: Run tests**

Run: `uv run pytest tests/test_bot.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add jamasp/bot.py jamasp/cli.py tests/test_bot.py
git commit -m "feat(bot): desk Telegram listener serving /brief

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: systemd unit, docs, full suite

**Files:**
- Create: `ops/systemd/jamasp-bot.service`
- Modify: `.claude/skills/deploy/SKILL.md` (unit table + install snippet), `CLAUDE.md` (Toolbox row + Deployment paragraph)

**Interfaces:**
- Consumes: CLI `jamasp bot` (Task 4).

- [ ] **Step 1: Create `ops/systemd/jamasp-bot.service`**

```ini
[Unit]
Description=Jamasp desk Telegram listener — serves /brief (codex Farsi brief)
After=network-online.target
Wants=network-online.target
OnFailure=jamasp-alert@%n.service

[Service]
WorkingDirectory=%h/Jamasp
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
# Required (no `-`): without the token and desk chat id the listener can
# only fail, and failing at start is what reaches OnFailure.
EnvironmentFile=%h/.config/jamasp/env
ExecStart=/usr/bin/env uv run jamasp bot
Restart=always
RestartSec=5

# Same hardening as jamasp-authd. Memory is higher: the spawned
# `jamasp farsi-brief` and its codex child live in this unit's cgroup. A
# restart (deploy) kills an in-flight brief with the cgroup; the desk just
# sends /brief again.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=1G

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Document it**

In `.claude/skills/deploy/SKILL.md`, next to the `jamasp-authd` unit-table row, add a row for `ops/systemd/jamasp-bot.service` → `/etc/systemd/system/` via the same `sed` + `User=jamasp` step, and add this install snippet after the authd one:

```bash
ssh jamasp 'sed -e "s|%h|/home/jamasp|g" -e "/^\[Service\]/a User=jamasp" \
  /home/jamasp/Jamasp/ops/systemd/jamasp-bot.service \
  > /etc/systemd/system/jamasp-bot.service'
ssh jamasp 'systemctl daemon-reload && systemctl enable --now jamasp-bot'
# verify: send /brief in the desk chat; expect "در حال آماده‌سازی بریف…" at once
ssh jamasp 'journalctl -u jamasp-bot -n 20 --no-pager'
```

In `CLAUDE.md`, add a Toolbox row:
`| \`uv run jamasp farsi-brief [--dry-run]\` | independent codex Persian brief to the desk (normally triggered by /brief via \`jamasp-bot\`) |`
and in the Deployment section change "the host runs two always-on services: `jamasp-panel` … and `jamasp-authd` …" to name three, adding: "and `jamasp-bot` (the desk-chat listener that answers `/brief` with an independent codex Farsi brief — never an analysis run, and no analysis run reads it)".

- [ ] **Step 3: Run the full suite**

Run: `uv run pytest -q`
Expected: all pass (baseline 736 passed, 4 skipped, plus the new tests).

- [ ] **Step 4: Commit**

```bash
git add ops/systemd/jamasp-bot.service .claude/skills/deploy/SKILL.md CLAUDE.md
git commit -m "ops(bot): jamasp-bot unit and runbook

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Deploy and end-to-end check (human-visible, run by the controller)

- [ ] **Step 1:** Push branch, open PR, merge (repo convention: merge commit).
- [ ] **Step 2:** On host: `su - jamasp -c "cd ~/Jamasp && git fetch -q origin && git merge --no-edit origin/main"`.
- [ ] **Step 3:** Dry run on host: `su - jamasp -c "cd ~/Jamasp && set -a && . ~/.config/jamasp/env && set +a && uv run jamasp farsi-brief --dry-run"` — read the Persian for fluency against the prompt's rules; tune `config/farsi_brief_prompt.md` if it reads as translation.
- [ ] **Step 4:** Install and start the unit with the Task 5 snippet; `systemctl is-active jamasp-bot`.
- [ ] **Step 5:** Ask the user to send `/brief` in the desk chat; confirm the "preparing" reply, then the brief, and `journalctl -u jamasp-bot` clean.
