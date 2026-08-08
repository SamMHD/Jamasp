# Jamasp News Flash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish every gold-touching news item to a dedicated Telegram channel as a Persian summary plus impact read, deduped against the last 24 hours, editing the existing message in place when a second source carries the same story.

**Architecture:** A new `jamasp/flash.py` runs as the last stage of every 15-minute `jamasp ingest` tick. It makes two model calls — one "decide" call classifying candidates as gold-relevant and matching them against already-posted stories, then one "write" call per new story grounded in extracted article text. Pure prompt-building, response-parsing, and message-rendering live in `jamasp/flashtext.py` so they are testable without any IO. Telegram gains `message_id` capture and an edit path.

**Tech Stack:** Python ≥3.12, sqlite3, click, httpx, trafilatura, pytest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-08-jamasp-newsflash-design.md`

## Global Constraints

- No new third-party dependencies. Everything needed is already in `pyproject.toml`.
- Every model call and every HTTP call is injectable, so tests touch no network and invoke no real model. Follow the existing pattern: `digest.run_digest` takes `claude_cmd` from settings; `notify.send_telegram` takes a `post` callable.
- Telegram bodies use **Latin numerals and Latin tickers** (`3,420`, not `۳٬۴۲۰`) per CLAUDE.md rule 3.
- No trading instructions in any generated text, per CLAUDE.md rule 6.
- Flash **never** marks items read. `items.read_at` is owned by `inbox.mark_read` and the brief/scan runs alone.
- Flash never raises out of `jamasp ingest`. Every failure path logs to `source_errors` with `source = 'flash'` and returns.
- Flash does **not** go through `runner.run_agent` and never consumes the daily agent-run cap.
- Flashes are **not** written to `notify_log`. That table backs the panel's Alerts page and is for desk alerts; 40 flashes/day would bury them. Flashes have their own `flashes` table.
- Dubai time is the fixed offset `timezone(timedelta(hours=4))`, matching `runner.DUBAI`. Dubai observes no DST, so this is exact and avoids a `tzdata` dependency.
- Run the suite with `uv run pytest` from the repo root.
- Commit after every task with a conventional-commit subject.

---

### Task 1: Telegram message ids, edits, and news-channel routing

`notify.py` currently fire-and-forgets. Flash needs the `message_id` back so it can edit later, an edit call, and a way to address a second chat.

**Files:**
- Modify: `jamasp/notify.py`
- Modify: `config/settings.yaml` (add `news_chat_id_env`)
- Test: `tests/test_notify.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `notify.resolve_chat(settings: dict, chat: str = "desk") -> tuple[str, str]` returning `(token, chat_id)`; `chat` is `"desk"` or `"news"`.
  - `notify.send_telegram(text, token, chat_id, post=None) -> int` returning the Telegram `message_id`.
  - `notify.edit_telegram(text, token, chat_id, message_id, post=None) -> None`.
  - `notify.MessageGone(RuntimeError)` raised when Telegram reports the target message no longer exists.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_notify.py`:

```python
def test_send_telegram_returns_message_id():
    def fake_post(url, data):
        return {"ok": True, "result": {"message_id": 4242}}

    assert notify.send_telegram("hi", "TOK", "-100", post=fake_post) == 4242


def test_edit_telegram_posts_message_id():
    sent = {}

    def fake_post(url, data):
        sent["url"], sent["data"] = url, data
        return {"ok": True, "result": {"message_id": 7}}

    notify.edit_telegram("new text", "TOK", "-100", 7, post=fake_post)
    assert sent["url"].endswith("/editMessageText")
    assert sent["data"] == {"chat_id": "-100", "text": "new text", "message_id": 7}


def test_edit_telegram_raises_message_gone():
    def fake_post(url, data):
        return {"ok": False, "description": "Bad Request: message to edit not found"}

    with pytest.raises(notify.MessageGone):
        notify.edit_telegram("t", "TOK", "-100", 7, post=fake_post)


def test_edit_telegram_raises_runtime_error_on_other_failure():
    def fake_post(url, data):
        return {"ok": False, "description": "Bad Request: chat not found"}

    with pytest.raises(RuntimeError) as exc:
        notify.edit_telegram("t", "TOK", "-100", 7, post=fake_post)
    assert not isinstance(exc.value, notify.MessageGone)


def test_resolve_chat_picks_news_env(monkeypatch):
    monkeypatch.setenv("JAMASP_TG_TOKEN", "TOK")
    monkeypatch.setenv("JAMASP_TG_CHAT", "-100desk")
    monkeypatch.setenv("JAMASP_TG_NEWS_CHAT", "-100news")
    settings = {
        "telegram": {
            "bot_token_env": "JAMASP_TG_TOKEN",
            "chat_id_env": "JAMASP_TG_CHAT",
            "news_chat_id_env": "JAMASP_TG_NEWS_CHAT",
        }
    }
    assert notify.resolve_chat(settings, "desk") == ("TOK", "-100desk")
    assert notify.resolve_chat(settings, "news") == ("TOK", "-100news")


def test_resolve_chat_news_missing_env_raises(monkeypatch):
    monkeypatch.setenv("JAMASP_TG_TOKEN", "TOK")
    monkeypatch.delenv("JAMASP_TG_NEWS_CHAT", raising=False)
    settings = {
        "telegram": {
            "bot_token_env": "JAMASP_TG_TOKEN",
            "chat_id_env": "JAMASP_TG_CHAT",
            "news_chat_id_env": "JAMASP_TG_NEWS_CHAT",
        }
    }
    with pytest.raises(RuntimeError, match="JAMASP_TG_NEWS_CHAT"):
        notify.resolve_chat(settings, "news")
```

Also **fix the existing test** `test_send_telegram_posts_to_bot_api`, whose fake returns `{"ok": True}` with no `result` key — that now raises `KeyError`. Change its fake to:

```python
    def fake_post(url, data):
        sent["url"], sent["data"] = url, data
        return {"ok": True, "result": {"message_id": 1}}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_notify.py -v`
Expected: FAIL — `AttributeError: module 'jamasp.notify' has no attribute 'edit_telegram'`, plus `KeyError: 'result'`.

- [ ] **Step 3: Implement**

Replace the body of `jamasp/notify.py` between the `_default_post` helper and `notify()` with:

```python
class MessageGone(RuntimeError):
    """Telegram refused an edit because the target message no longer exists."""


def send_telegram(text: str, token: str, chat_id: str, post: Poster | None = None) -> int:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    result = (post or _default_post)(url, {"chat_id": chat_id, "text": text})
    if not result.get("ok"):
        raise RuntimeError(f"telegram send failed: {result.get('description', result)}")
    return int(result["result"]["message_id"])


def edit_telegram(
    text: str,
    token: str,
    chat_id: str,
    message_id: int,
    post: Poster | None = None,
) -> None:
    url = f"https://api.telegram.org/bot{token}/editMessageText"
    result = (post or _default_post)(
        url, {"chat_id": chat_id, "text": text, "message_id": message_id}
    )
    if result.get("ok"):
        return
    description = str(result.get("description", result))
    # the message was deleted from the channel; retrying can never succeed
    if "message to edit not found" in description.lower():
        raise MessageGone(description)
    raise RuntimeError(f"telegram edit failed: {description}")


def resolve_chat(settings: dict, chat: str = "desk") -> tuple[str, str]:
    """Return (token, chat_id) for the named chat: 'desk' or 'news'."""
    cfg = settings["telegram"]
    token = os.environ.get(cfg["bot_token_env"])
    if not token:
        raise RuntimeError(f"missing env var {cfg['bot_token_env']}")
    key = "chat_id_env" if chat == "desk" else "news_chat_id_env"
    env_name = cfg.get(key)
    if not env_name:
        raise RuntimeError(f"telegram.{key} is not configured in settings.yaml")
    chat_id = os.environ.get(env_name)
    if not chat_id:
        raise RuntimeError(f"missing env var {env_name}")
    return token, chat_id
```

Then rewrite `notify()` to use it, keeping its existing signature and adding `chat`:

```python
def notify(
    text: str,
    settings: dict,
    dry_run: bool = False,
    post: Poster | None = None,
    chat: str = "desk",
) -> str:
    token, chat_id = resolve_chat(settings, chat)
    if dry_run:
        return f"[dry-run] would send {len(text)} chars to chat {chat_id}"
    send_telegram(text, token, chat_id, post=post)
    return f"sent {len(text)} chars to chat {chat_id}"
```

- [ ] **Step 4: Add the config key**

In `config/settings.yaml`, extend the `telegram` block:

```yaml
telegram:
  bot_token_env: JAMASP_TG_TOKEN
  chat_id_env: JAMASP_TG_CHAT
  news_chat_id_env: JAMASP_TG_NEWS_CHAT
```

- [ ] **Step 5: Run the full suite**

Run: `uv run pytest -q`
Expected: PASS. `test_runner.py` and `test_cli.py` also exercise `notify()`; if any fail, it is because a fake `post` there returns no `result` key — fix those fakes the same way.

- [ ] **Step 6: Commit**

```bash
git add jamasp/notify.py config/settings.yaml tests/test_notify.py
git commit -m "feat(notify): return message ids, add edit path and news-chat routing"
```

---

### Task 2: Flash tables and source display names

**Files:**
- Modify: `jamasp/db.py` (append to `SCHEMA`)
- Modify: `jamasp/config.py`
- Modify: `config/sources.yaml`
- Test: `tests/test_db.py`, `tests/test_config.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Tables `flashes` and `flash_items` created by `db.connect`.
  - `Source.display: str | None` attribute.
  - `config.display_names(sources: list[Source]) -> dict[str, str]` mapping source name to its label.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_db.py`:

```python
def test_connect_creates_flash_tables(tmp_path):
    from jamasp import db as db_mod

    conn = db_mod.connect(tmp_path / "t.db")
    names = {
        r["name"]
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {"flashes", "flash_items"} <= names


def test_flashes_requires_message_id(tmp_path):
    import sqlite3

    import pytest

    from jamasp import db as db_mod

    conn = db_mod.connect(tmp_path / "t.db")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO flashes (id, created_at, updated_at, title_en, title_fa,"
            " summary_fa, impact_fa, url, message_id, status)"
            " VALUES ('a','t','t','en','fa','s','i','https://e/1', NULL, 'sent')"
        )
```

Add to `tests/test_config.py`:

```python
def test_display_names_uses_display_then_falls_back():
    from jamasp.config import Source, display_names

    sources = [
        Source(name="cnbc_finance", type="rss", url="u", interval_minutes=15,
               topic="markets", display="CNBC"),
        Source(name="mining_com", type="rss", url="u", interval_minutes=15,
               topic="gold"),
    ]
    assert display_names(sources) == {
        "cnbc_finance": "CNBC",
        "mining_com": "Mining Com",
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_db.py tests/test_config.py -v`
Expected: FAIL — `flashes` table missing; `Source() got an unexpected keyword argument 'display'`.

- [ ] **Step 3: Add the tables**

Append to the `SCHEMA` string in `jamasp/db.py`, before the closing `"""`:

```sql
CREATE TABLE IF NOT EXISTS flashes (
    id          TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    title_en    TEXT NOT NULL,
    title_fa    TEXT NOT NULL,
    summary_fa  TEXT NOT NULL,
    impact_fa   TEXT NOT NULL,
    url         TEXT NOT NULL,
    message_id  INTEGER NOT NULL,
    status      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flashes_created ON flashes(created_at);
CREATE TABLE IF NOT EXISTS flash_items (
    item_id  TEXT PRIMARY KEY,
    flash_id TEXT,
    state    TEXT NOT NULL,
    ts       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flash_items_flash ON flash_items(flash_id);
```

`flashes.id` is the item id of the story's first item. A row exists only for a story that was actually delivered, so `message_id` is `NOT NULL`. `status` is `sent` or `orphaned`.

- [ ] **Step 4: Add display names**

In `jamasp/config.py`, add the field to `Source` (after `symbol`, keeping all fields with defaults last):

```python
    # human-readable label for Telegram flash "منابع:" lines
    display: str | None = None
```

Add `display=e.get("display"),` to the `Source(...)` construction in `load_sources`, and append this function:

```python
def display_names(sources: list[Source]) -> dict[str, str]:
    """Map source name to the label shown to humans."""
    return {
        s.name: s.display or s.name.replace("_", " ").title() for s in sources
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_db.py tests/test_config.py -v`
Expected: PASS

- [ ] **Step 6: Add display labels to sources.yaml**

Add a `display:` line to each entry in `config/sources.yaml`. Use the outlet's own name as a reader would recognize it. For the RSS sources present today:

```
investing_commodities → Investing.com     marketwatch_top    → MarketWatch
cnbc_finance          → CNBC              cnbc_economy       → CNBC
mining_com            → Mining.com        gnews_gold         → Google News
wgc                   → World Gold Council
mining_weekly         → Mining Weekly     northern_miner     → Northern Miner
gulf_news             → Gulf News         national_business  → The National
saxo_research         → Saxo              actionforex        → ActionForex
fxempire_forecasts    → FXEmpire          forexlive          → ForexLive
gold_eagle            → Gold-Eagle        fed_press          → Federal Reserve
ecb_press             → ECB               boe_news           → Bank of England
bis_press             → BIS
```

For any source in the file not listed above, and for non-RSS sources (`price_api`, `technicals_api`, `calendar`), leave `display` off — the title-cased fallback covers them and they never produce flash items.

Note that `cnbc_finance` and `cnbc_economy` share the label `CNBC`. That is intended: the sources line deduplicates labels, so one story picked up by both CNBC feeds shows `CNBC` once.

- [ ] **Step 7: Verify config still loads**

Run: `uv run pytest -q && uv run jamasp sources check 2>&1 | head -5`
Expected: tests PASS; `sources check` runs (network results do not matter — it must not raise a config error).

- [ ] **Step 8: Commit**

```bash
git add jamasp/db.py jamasp/config.py config/sources.yaml tests/test_db.py tests/test_config.py
git commit -m "feat(db): flash tables and source display names"
```

---

### Task 3: Pure text layer — prompts, parsing, rendering

Everything in this task is a pure function: no database, no network, no subprocess.

**Files:**
- Create: `jamasp/flashtext.py`
- Test: `tests/test_flashtext.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `flashtext.build_decide_prompt(posted: list, candidates: list) -> str` — each argument is a list of mappings (`sqlite3.Row` works); `posted` needs `id` and `title_en`, `candidates` need `id`, `source`, `headline`, `lede`.
  - `flashtext.parse_decide_response(text: str) -> dict[str, dict]` returning `{item_id: {"gold": bool, "dup_of": str | None}}`.
  - `flashtext.build_write_prompt(headline: str, source_label: str, published_at: str, body: str, lede: str | None = None) -> str`.
  - `flashtext.parse_write_response(text: str) -> dict[str, str]` returning keys `title_fa`, `summary_fa`, `impact_fa`.
  - `flashtext.render_message(title_fa, summary_fa, impact_fa, url, published_at, source_labels: list[str]) -> str`.
  - `flashtext.MAX_CHARS = 4000`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_flashtext.py`:

```python
import pytest

from jamasp import flashtext


def test_build_decide_prompt_lists_posted_and_new():
    posted = [{"id": "aaa", "title_en": "Gold hits record"}]
    candidates = [
        {"id": "bbb", "source": "cnbc_finance", "headline": "Bullion surges",
         "lede": "Spot gold rose."},
        {"id": "ccc", "source": "wgc", "headline": "ETF inflows", "lede": None},
    ]
    prompt = flashtext.build_decide_prompt(posted, candidates)
    assert "aaa\tGold hits record" in prompt
    assert "bbb\tcnbc_finance\tBullion surges\tSpot gold rose." in prompt
    assert "ccc\twgc\tETF inflows\t" in prompt
    assert "POSTED" in prompt and "NEW" in prompt


def test_build_decide_prompt_handles_empty_posted():
    prompt = flashtext.build_decide_prompt(
        [], [{"id": "bbb", "source": "s", "headline": "h", "lede": None}]
    )
    assert "(none)" in prompt


def test_parse_decide_response_normalizes():
    text = 'ok:\n```json\n{"bbb": {"gold": true, "dup_of": "aaa"},' \
           ' "ccc": {"gold": false, "dup_of": null}}\n```'
    assert flashtext.parse_decide_response(text) == {
        "bbb": {"gold": True, "dup_of": "aaa"},
        "ccc": {"gold": False, "dup_of": None},
    }


def test_parse_decide_response_tolerates_missing_keys():
    assert flashtext.parse_decide_response('{"bbb": {"gold": true}}') == {
        "bbb": {"gold": True, "dup_of": None}
    }


def test_parse_decide_response_raises_without_json():
    with pytest.raises(ValueError, match="no JSON object"):
        flashtext.parse_decide_response("I could not comply.")


def test_build_write_prompt_includes_article_text():
    prompt = flashtext.build_write_prompt(
        "Gold hits record", "Reuters", "2026-08-08T10:32:00Z", "Full article body."
    )
    assert "Full article body." in prompt
    assert "HEADLINE: Gold hits record" in prompt
    assert "SOURCE: Reuters" in prompt


def test_build_write_prompt_falls_back_to_lede():
    prompt = flashtext.build_write_prompt(
        "Gold hits record", "Reuters", "2026-08-08T10:32:00Z", "", lede="Spot rose."
    )
    assert "UNAVAILABLE" in prompt
    assert "Spot rose." in prompt


def test_parse_write_response_returns_three_fields():
    text = '{"title_fa": "t", "summary_fa": "s", "impact_fa": "i"}'
    assert flashtext.parse_write_response(text) == {
        "title_fa": "t", "summary_fa": "s", "impact_fa": "i"
    }


def test_parse_write_response_raises_on_missing_field():
    with pytest.raises(ValueError, match="impact_fa"):
        flashtext.parse_write_response('{"title_fa": "t", "summary_fa": "s"}')


def test_render_message_golden():
    text = flashtext.render_message(
        title_fa="طلا رکورد زد",
        summary_fa="خلاصه فارسی.",
        impact_fa="تحلیل فارسی.",
        url="https://e/1",
        published_at="2026-08-08T10:32:00Z",
        source_labels=["Reuters", "CNBC"],
    )
    assert text == (
        "🟡 طلا رکورد زد\n"
        "\n"
        "خلاصه فارسی.\n"
        "\n"
        "اثر احتمالی: تحلیل فارسی.\n"
        "\n"
        "منابع: Reuters • CNBC\n"
        "https://e/1\n"
        "⏱ 14:32 دبی"
    )


def test_render_message_truncates():
    text = flashtext.render_message(
        "t", "x" * 6000, "i", "https://e/1", "2026-08-08T10:32:00Z", ["Reuters"]
    )
    assert len(text) <= flashtext.MAX_CHARS
    assert text.endswith("…")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_flashtext.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'jamasp.flashtext'`.

- [ ] **Step 3: Implement `jamasp/flashtext.py`**

```python
"""Pure text layer for news flashes: prompts, response parsing, message render.

Nothing here touches the database, the network, or a subprocess, so every
function is testable in isolation.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Sequence

# Dubai observes no DST, so a fixed offset is exact — same choice as runner.DUBAI,
# and it keeps us off a tzdata dependency.
DUBAI = timezone(timedelta(hours=4))

# Telegram's hard limit is 4096; leave headroom for the truncation marker.
MAX_CHARS = 4000

DECIDE_HEADER = """You are the news triage desk for a physical gold trading company.

POSTED lists stories already published in the last 24 hours, as id<TAB>headline.
NEW lists candidate items, as id<TAB>source<TAB>headline<TAB>lede.

For every NEW id decide two things:

1. "gold": true if the item plausibly bears on the gold market at all — gold
   prices, mining, central-bank reserves or purchases, interest rates, the
   dollar, inflation data, geopolitical risk, ETF or physical flows. false for
   single-name equity news unrelated to gold, crypto-only stories, and general
   corporate news.
2. "dup_of": the id of the story this item repeats, or null.
   - It may name a POSTED id, or the id of an EARLIER-LISTED NEW item.
   - When several NEW items cover the same story, point every one of them at
     the id of the first of those items in the NEW list.
   - A duplicate is the same underlying event, not merely the same subject.
     "Gold hits record" and "Gold pulls back from record" are two stories.
   - When unsure, use null. A duplicate message is a smaller failure than a
     suppressed story.

Respond with ONLY a JSON object mapping each NEW id to
{"gold": bool, "dup_of": id or null}. No other text.

"""

WRITE_HEADER = """You are a market analyst at a physical gold trading company in Dubai,
writing a wire flash in Persian for the trading desk.

Return ONLY a JSON object with exactly these keys:
  "title_fa"   - Persian headline, at most 10 words, no trailing punctuation.
  "summary_fa" - ONE Persian paragraph, 3-5 sentences, stating only facts
                 present in the source text below.
  "impact_fa"  - ONE Persian paragraph naming the transmission channel to the
                 gold market and the conditions that would confirm or
                 invalidate it.

Rules:
- Numbers, tickers, currencies and instrument names stay in Latin script:
  write 3,420 and CPI, never Persian-Indic digits.
- Never state a number, date, or name that does not appear in the source text.
- Do not begin impact_fa with "اثر احتمالی" — that label is added afterwards.
- No trading instructions. Describe mechanisms and conditions; never tell the
  desk to buy or sell.

"""


def _json_object(text: str) -> dict[str, Any]:
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object in response")
    parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("no JSON object in response")
    return parsed


def build_decide_prompt(
    posted: Sequence[Mapping], candidates: Sequence[Mapping]
) -> str:
    posted_block = (
        "\n".join(f"{p['id']}\t{p['title_en']}" for p in posted) or "(none)"
    )
    new_block = "\n".join(
        f"{c['id']}\t{c['source']}\t{c['headline']}\t{c['lede'] or ''}"
        for c in candidates
    )
    return f"{DECIDE_HEADER}POSTED:\n{posted_block}\n\nNEW:\n{new_block}\n"


def parse_decide_response(text: str) -> dict[str, dict]:
    verdicts = {}
    for item_id, raw in _json_object(text).items():
        if not isinstance(raw, dict):
            continue
        dup = raw.get("dup_of")
        verdicts[str(item_id)] = {
            "gold": bool(raw.get("gold")),
            "dup_of": str(dup) if dup else None,
        }
    return verdicts


def build_write_prompt(
    headline: str,
    source_label: str,
    published_at: str,
    body: str,
    lede: str | None = None,
) -> str:
    if body:
        source_block = f"ARTICLE TEXT:\n{body}"
    else:
        source_block = (
            "ARTICLE TEXT UNAVAILABLE — write from the headline and lede alone.\n"
            "Keep summary_fa to two hedged sentences and introduce no specifics.\n"
            f"LEDE: {lede or '(none)'}"
        )
    return (
        f"{WRITE_HEADER}HEADLINE: {headline}\n"
        f"SOURCE: {source_label}\n"
        f"PUBLISHED: {published_at}\n\n{source_block}\n"
    )


def parse_write_response(text: str) -> dict[str, str]:
    parsed = _json_object(text)
    fields = {}
    for key in ("title_fa", "summary_fa", "impact_fa"):
        value = parsed.get(key)
        if not value or not str(value).strip():
            raise ValueError(f"write response missing {key}")
        fields[key] = str(value).strip()
    return fields


def _dubai_hhmm(published_at: str) -> str:
    dt = datetime.strptime(published_at, "%Y-%m-%dT%H:%M:%SZ")
    return dt.replace(tzinfo=timezone.utc).astimezone(DUBAI).strftime("%H:%M")


def render_message(
    title_fa: str,
    summary_fa: str,
    impact_fa: str,
    url: str,
    published_at: str,
    source_labels: Sequence[str],
) -> str:
    text = "\n".join(
        [
            f"🟡 {title_fa}",
            "",
            summary_fa,
            "",
            f"اثر احتمالی: {impact_fa}",
            "",
            f"منابع: {' • '.join(source_labels)}",
            url,
            f"⏱ {_dubai_hhmm(published_at)} دبی",
        ]
    )
    if len(text) > MAX_CHARS:
        text = text[: MAX_CHARS - 1] + "…"
    return text
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_flashtext.py -v`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add jamasp/flashtext.py tests/test_flashtext.py
git commit -m "feat(flash): prompt builders, response parsers, message renderer"
```

---

### Task 4: Candidate selection and stale retirement

The read side of the tick: which items are eligible, and which are too old to ever post.

**Files:**
- Create: `jamasp/flash.py`
- Test: `tests/test_flash.py`

**Interfaces:**
- Consumes: `db.connect` tables from Task 2.
- Produces:
  - `flash.candidates(conn, max_age_hours: int, limit: int) -> list[sqlite3.Row]` — unprocessed items inside the age window, newest first.
  - `flash.retire_stale(conn, max_age_hours: int) -> int` — marks unprocessed items outside the window `skipped_stale`, returns the count.
  - `flash.posted_flashes(conn, hours: int = 24) -> list[sqlite3.Row]` — rows from `flashes` created inside the window, each carrying the origin item's `published_at`.
  - `flash.record(conn, item_id: str, flash_id: str | None, state: str) -> None`.
  - `flash.log_error(conn, exc: object) -> None`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_flash.py`:

```python
from datetime import datetime, timedelta, timezone

from jamasp import db, flash
from jamasp.ingest import rss
from jamasp.models import Item


def ago(hours):
    dt = datetime.now(timezone.utc) - timedelta(hours=hours)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def seed(conn, specs):
    """specs: list of (source, headline, hours_ago). Returns item ids."""
    items = [
        Item(
            id=rss.item_id(src, f"https://e/{i}", head),
            source=src,
            published_at=ago(hrs),
            headline=head,
            url=f"https://e/{i}",
            topic="gold",
        )
        for i, (src, head, hrs) in enumerate(specs)
    ]
    rss.store_items(conn, items)
    return [it.id for it in items]


def test_candidates_respects_age_window_and_order(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    fresh, old = seed(conn, [("a", "Fresh story", 1), ("b", "Old story", 9)])
    rows = flash.candidates(conn, max_age_hours=6, limit=30)
    assert [r["id"] for r in rows] == [fresh]
    assert old not in [r["id"] for r in rows]


def test_candidates_excludes_already_processed(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    one, two = seed(conn, [("a", "One", 1), ("b", "Two", 2)])
    flash.record(conn, one, None, "not_gold")
    assert [r["id"] for r in flash.candidates(conn, 6, 30)] == [two]


def test_candidates_honours_limit(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("a", "One", 1), ("b", "Two", 2), ("c", "Three", 3)])
    assert len(flash.candidates(conn, 6, 2)) == 2


def test_retire_stale_marks_only_old_unprocessed(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    fresh, old = seed(conn, [("a", "Fresh", 1), ("b", "Old", 9)])
    assert flash.retire_stale(conn, 6) == 1
    row = conn.execute(
        "SELECT state FROM flash_items WHERE item_id = ?", (old,)
    ).fetchone()
    assert row["state"] == "skipped_stale"
    assert conn.execute(
        "SELECT COUNT(*) c FROM flash_items WHERE item_id = ?", (fresh,)
    ).fetchone()["c"] == 0
    # idempotent: a second pass finds nothing new
    assert flash.retire_stale(conn, 6) == 0


def test_posted_flashes_window_and_published_at(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    (origin,) = seed(conn, [("a", "Gold hits record", 2)])
    conn.execute(
        "INSERT INTO flashes (id, created_at, updated_at, title_en, title_fa,"
        " summary_fa, impact_fa, url, message_id, status)"
        " VALUES (?, ?, ?, 'Gold hits record', 'fa', 's', 'i', 'https://e/0', 5, 'sent')",
        (origin, ago(2), ago(2)),
    )
    conn.commit()
    rows = flash.posted_flashes(conn, hours=24)
    assert [r["id"] for r in rows] == [origin]
    assert rows[0]["published_at"] == ago(2)
    assert flash.posted_flashes(conn, hours=1) == []


def test_log_error_writes_source_errors(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    flash.log_error(conn, ValueError("boom"))
    row = conn.execute(
        "SELECT source, error FROM source_errors WHERE source = 'flash'"
    ).fetchone()
    assert row is not None and "boom" in row["error"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_flash.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'jamasp.flash'`.

- [ ] **Step 3: Implement the read side of `jamasp/flash.py`**

```python
"""Per-story gold news flashes: classify, dedupe, publish to the news channel.

Runs as the last stage of `jamasp ingest`. Never raises into the ingest run,
never marks items read, and never consumes the daily agent-run cap.
"""
from __future__ import annotations

import sqlite3
import subprocess
from datetime import datetime, timedelta, timezone

from jamasp.db import utcnow

MODEL_TIMEOUT_SECONDS = 120


def _since(hours: int) -> str:
    dt = datetime.now(timezone.utc) - timedelta(hours=hours)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def log_error(conn: sqlite3.Connection, exc: object) -> None:
    conn.execute(
        "INSERT INTO source_errors (source, ts, error) VALUES ('flash', ?, ?)",
        (utcnow(), str(exc)[:500]),
    )
    conn.commit()


def record(
    conn: sqlite3.Connection, item_id: str, flash_id: str | None, state: str
) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO flash_items (item_id, flash_id, state, ts)"
        " VALUES (?, ?, ?, ?)",
        (item_id, flash_id, state, utcnow()),
    )
    conn.commit()


def candidates(
    conn: sqlite3.Connection, max_age_hours: int, limit: int
) -> list[sqlite3.Row]:
    """Unprocessed items inside the age window, newest first."""
    return conn.execute(
        "SELECT i.* FROM items i"
        " LEFT JOIN flash_items f ON f.item_id = i.id"
        " WHERE f.item_id IS NULL AND i.published_at >= ?"
        " ORDER BY i.published_at DESC LIMIT ?",
        (_since(max_age_hours), limit),
    ).fetchall()


def retire_stale(conn: sqlite3.Connection, max_age_hours: int) -> int:
    """Mark unprocessed items past the window as skipped_stale. They never post."""
    cur = conn.execute(
        "INSERT INTO flash_items (item_id, flash_id, state, ts)"
        " SELECT i.id, NULL, 'skipped_stale', ? FROM items i"
        " LEFT JOIN flash_items f ON f.item_id = i.id"
        " WHERE f.item_id IS NULL AND i.published_at < ?",
        (utcnow(), _since(max_age_hours)),
    )
    conn.commit()
    return cur.rowcount


def posted_flashes(conn: sqlite3.Connection, hours: int = 24) -> list[sqlite3.Row]:
    """Delivered flashes inside the window, carrying the origin item's publish time."""
    return conn.execute(
        "SELECT f.*, i.published_at AS published_at FROM flashes f"
        " JOIN items i ON i.id = f.id"
        " WHERE f.created_at >= ? ORDER BY f.created_at",
        (_since(hours),),
    ).fetchall()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_flash.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add jamasp/flash.py tests/test_flash.py
git commit -m "feat(flash): candidate selection, stale retirement, flash lookups"
```

---

### Task 5: The tick — decide, publish, deduplicate

**Files:**
- Modify: `jamasp/flash.py`
- Test: `tests/test_flash.py`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces:
  - `flash.source_labels(conn, flash_id: str, display: dict[str, str]) -> list[str]` — labels for a flash's sources, arrival order, deduplicated.
  - `flash.run_flash(conn, settings: dict, sources: list, post=None, run_model=None, emit=None, dry_run: bool = False) -> dict[str, int]` returning counters keyed `posted`, `dup`, `not_gold`, `stale`, `burst`, `errors`.
  - `run_model` has signature `Callable[[list[str], str], str]` — `(cmd, prompt) -> stdout`.
  - `post` is `notify.Poster`: `Callable[[str, dict], dict]`.
  - `emit` is `Callable[[str], None]`, used only in `dry_run` to surface rendered messages.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_flash.py`:

```python
import json

import pytest

from jamasp.config import Source

SOURCES = [
    Source(name="reuters", type="rss", url="u", interval_minutes=15,
           topic="gold", display="Reuters"),
    Source(name="cnbc", type="rss", url="u", interval_minutes=15,
           topic="gold", display="CNBC"),
]

SETTINGS = {
    "telegram": {
        "bot_token_env": "JAMASP_TG_TOKEN",
        "chat_id_env": "JAMASP_TG_CHAT",
        "news_chat_id_env": "JAMASP_TG_NEWS_CHAT",
    },
    "flash": {
        "enabled": True,
        "max_age_hours": 6,
        "max_posts_per_tick": 10,
        "classify_batch_max": 30,
        "extract_chars": 4000,
        "decide_cmd": ["fake-decide"],
        "write_cmd": ["fake-write"],
    },
}


@pytest.fixture(autouse=True)
def tg_env(monkeypatch):
    monkeypatch.setenv("JAMASP_TG_TOKEN", "TOK")
    monkeypatch.setenv("JAMASP_TG_CHAT", "-100desk")
    monkeypatch.setenv("JAMASP_TG_NEWS_CHAT", "-100news")


class FakePoster:
    """Records Telegram calls; returns incrementing message ids."""

    def __init__(self, fail_on=None, edit_error=None):
        self.calls = []
        self.next_id = 100
        self.fail_on = fail_on or set()
        self.edit_error = edit_error

    def __call__(self, url, data):
        kind = "edit" if url.endswith("editMessageText") else "send"
        self.calls.append((kind, data))
        if kind in self.fail_on:
            return {"ok": False, "description": "Bad Request: chat not found"}
        if kind == "edit" and self.edit_error:
            return {"ok": False, "description": self.edit_error}
        self.next_id += 1
        return {"ok": True, "result": {"message_id": self.next_id}}


def model(verdicts, write=None):
    """Build a run_model fake: decide returns verdicts, write returns fixed fields."""
    written = write or {"title_fa": "عنوان", "summary_fa": "خلاصه", "impact_fa": "اثر"}

    def run(cmd, prompt):
        if cmd == ["fake-decide"]:
            return json.dumps(verdicts)
        return json.dumps(written)

    return run


def no_extract(monkeypatch):
    """Force the extraction fallback so tests never hit the network."""
    from jamasp import extract as extract_mod

    monkeypatch.setattr(
        extract_mod, "extract_url",
        lambda *a, **k: (_ for _ in ()).throw(ValueError("no network")),
    )


def test_run_flash_posts_new_story(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 1)])
    poster = FakePoster()
    stats = flash.run_flash(
        conn, SETTINGS, SOURCES, post=poster,
        run_model=model({one: {"gold": True, "dup_of": None}}),
    )
    assert stats["posted"] == 1
    assert [c[0] for c in poster.calls] == ["send"]
    assert poster.calls[0][1]["chat_id"] == "-100news"
    assert "منابع: Reuters" in poster.calls[0][1]["text"]
    row = conn.execute("SELECT * FROM flashes WHERE id = ?", (one,)).fetchone()
    assert row["message_id"] == 101 and row["status"] == "sent"
    assert conn.execute(
        "SELECT state FROM flash_items WHERE item_id = ?", (one,)
    ).fetchone()["state"] == "posted"
    # flashes stay out of the desk alert log
    assert conn.execute("SELECT COUNT(*) c FROM notify_log").fetchone()["c"] == 0
    # and never mark items read
    assert conn.execute(
        "SELECT read_at FROM items WHERE id = ?", (one,)
    ).fetchone()["read_at"] is None


def test_run_flash_skips_non_gold(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Widget maker earnings", 1)])
    poster = FakePoster()
    stats = flash.run_flash(
        conn, SETTINGS, SOURCES, post=poster,
        run_model=model({one: {"gold": False, "dup_of": None}}),
    )
    assert stats["not_gold"] == 1 and poster.calls == []
    assert conn.execute(
        "SELECT state FROM flash_items WHERE item_id = ?", (one,)
    ).fetchone()["state"] == "not_gold"


def test_run_flash_edits_message_on_duplicate(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 2)])
    poster = FakePoster()
    flash.run_flash(conn, SETTINGS, SOURCES, post=poster,
                    run_model=model({one: {"gold": True, "dup_of": None}}))
    (two,) = seed(conn, [("cnbc", "Bullion surges to all-time high", 1)])
    stats = flash.run_flash(
        conn, SETTINGS, SOURCES, post=poster,
        run_model=model({two: {"gold": True, "dup_of": one}}),
    )
    assert stats["dup"] == 1 and stats["posted"] == 0
    kinds = [c[0] for c in poster.calls]
    assert kinds == ["send", "edit"]
    edit = poster.calls[1][1]
    assert edit["message_id"] == 101
    assert "منابع: Reuters • CNBC" in edit["text"]
    assert "عنوان" in edit["text"]          # paragraphs unchanged
    assert conn.execute(
        "SELECT flash_id, state FROM flash_items WHERE item_id = ?", (two,)
    ).fetchone()["flash_id"] == one


def test_run_flash_skips_edit_when_label_already_present(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 2)])
    poster = FakePoster()
    flash.run_flash(conn, SETTINGS, SOURCES, post=poster,
                    run_model=model({one: {"gold": True, "dup_of": None}}))
    (two,) = seed(conn, [("reuters", "Gold hits a record high", 1)])
    flash.run_flash(conn, SETTINGS, SOURCES, post=poster,
                    run_model=model({two: {"gold": True, "dup_of": one}}))
    assert [c[0] for c in poster.calls] == ["send"]   # no edit attempted


def test_run_flash_dedupes_within_one_tick(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    first, second = seed(
        conn, [("reuters", "Gold hits record", 1), ("cnbc", "Bullion surges", 2)]
    )
    poster = FakePoster()
    stats = flash.run_flash(
        conn, SETTINGS, SOURCES, post=poster,
        run_model=model({
            first: {"gold": True, "dup_of": None},
            second: {"gold": True, "dup_of": first},
        }),
    )
    assert (stats["posted"], stats["dup"]) == (1, 1)
    assert [c[0] for c in poster.calls] == ["send", "edit"]


def test_run_flash_treats_unknown_dup_target_as_new(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 1)])
    poster = FakePoster()
    stats = flash.run_flash(
        conn, SETTINGS, SOURCES, post=poster,
        run_model=model({one: {"gold": True, "dup_of": "hallucinated"}}),
    )
    assert stats["posted"] == 1 and [c[0] for c in poster.calls] == ["send"]


def test_run_flash_orphans_flash_when_message_gone(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 2)])
    poster = FakePoster()
    flash.run_flash(conn, SETTINGS, SOURCES, post=poster,
                    run_model=model({one: {"gold": True, "dup_of": None}}))
    poster.edit_error = "Bad Request: message to edit not found"
    (two,) = seed(conn, [("cnbc", "Bullion surges", 1)])
    stats = flash.run_flash(conn, SETTINGS, SOURCES, post=poster,
                            run_model=model({two: {"gold": True, "dup_of": one}}))
    assert stats["dup"] == 1 and stats["errors"] == 0
    assert conn.execute(
        "SELECT status FROM flashes WHERE id = ?", (one,)
    ).fetchone()["status"] == "orphaned"
    # a third source is absorbed without another edit attempt
    edits_before = len([c for c in poster.calls if c[0] == "edit"])
    (three,) = seed(conn, [("reuters", "Gold record confirmed", 1)])
    flash.run_flash(conn, SETTINGS, SOURCES, post=poster,
                    run_model=model({three: {"gold": True, "dup_of": one}}))
    assert len([c for c in poster.calls if c[0] == "edit"]) == edits_before


def test_run_flash_burst_cap_drops_overflow(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    ids = seed(conn, [("reuters", f"Story {i}", 1) for i in range(4)])
    settings = {**SETTINGS, "flash": {**SETTINGS["flash"], "max_posts_per_tick": 2}}
    poster = FakePoster()
    stats = flash.run_flash(
        conn, settings, SOURCES, post=poster,
        run_model=model({i: {"gold": True, "dup_of": None} for i in ids}),
    )
    assert (stats["posted"], stats["burst"]) == (2, 2)
    assert len([c for c in poster.calls if c[0] == "send"]) == 2
    assert conn.execute("SELECT COUNT(*) c FROM flashes").fetchone()["c"] == 2
    dropped = conn.execute(
        "SELECT COUNT(*) c FROM flash_items WHERE state = 'skipped_burst'"
    ).fetchone()["c"]
    assert dropped == 2
    # dropped items are not dedupe targets later — they left no flashes row
    assert conn.execute(
        "SELECT COUNT(*) c FROM flashes WHERE status = 'skipped_burst'"
    ).fetchone()["c"] == 0


def test_run_flash_send_failure_leaves_item_unprocessed(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 1)])
    poster = FakePoster(fail_on={"send"})
    stats = flash.run_flash(
        conn, SETTINGS, SOURCES, post=poster,
        run_model=model({one: {"gold": True, "dup_of": None}}),
    )
    assert stats["errors"] == 1 and stats["posted"] == 0
    assert conn.execute(
        "SELECT COUNT(*) c FROM flash_items WHERE item_id = ?", (one,)
    ).fetchone()["c"] == 0
    assert conn.execute("SELECT COUNT(*) c FROM flashes").fetchone()["c"] == 0
    assert conn.execute(
        "SELECT COUNT(*) c FROM source_errors WHERE source = 'flash'"
    ).fetchone()["c"] == 1


def test_run_flash_decide_failure_touches_nothing(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 1)])
    poster = FakePoster()

    def broken(cmd, prompt):
        return "I refuse."

    stats = flash.run_flash(conn, SETTINGS, SOURCES, post=poster, run_model=broken)
    assert stats["errors"] == 1 and poster.calls == []
    assert conn.execute(
        "SELECT COUNT(*) c FROM flash_items WHERE item_id = ?", (one,)
    ).fetchone()["c"] == 0


def test_run_flash_write_failure_isolates_one_story(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    good, bad = seed(
        conn, [("reuters", "Gold hits record", 1), ("cnbc", "Miners rally", 2)]
    )

    def run(cmd, prompt):
        if cmd == ["fake-decide"]:
            return json.dumps({
                good: {"gold": True, "dup_of": None},
                bad: {"gold": True, "dup_of": None},
            })
        if "Miners rally" in prompt:
            return "I could not write this."
        return json.dumps({"title_fa": "عنوان", "summary_fa": "خلاصه",
                           "impact_fa": "اثر"})

    poster = FakePoster()
    stats = flash.run_flash(conn, SETTINGS, SOURCES, post=poster, run_model=run)
    assert (stats["posted"], stats["errors"]) == (1, 1)
    assert [c[0] for c in poster.calls] == ["send"]
    # the failed story is left unprocessed and retried next tick
    assert conn.execute(
        "SELECT COUNT(*) c FROM flash_items WHERE item_id = ?", (bad,)
    ).fetchone()["c"] == 0


def test_run_flash_edit_failure_leaves_item_unprocessed(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 2)])
    poster = FakePoster()
    flash.run_flash(conn, SETTINGS, SOURCES, post=poster,
                    run_model=model({one: {"gold": True, "dup_of": None}}))
    poster.fail_on = {"edit"}
    (two,) = seed(conn, [("cnbc", "Bullion surges", 1)])
    stats = flash.run_flash(conn, SETTINGS, SOURCES, post=poster,
                            run_model=model({two: {"gold": True, "dup_of": one}}))
    assert stats["errors"] == 1 and stats["dup"] == 0
    assert conn.execute(
        "SELECT COUNT(*) c FROM flash_items WHERE item_id = ?", (two,)
    ).fetchone()["c"] == 0
    # the flash is untouched — not orphaned, still editable next tick
    assert conn.execute(
        "SELECT status FROM flashes WHERE id = ?", (one,)
    ).fetchone()["status"] == "sent"


def test_run_flash_disabled_without_news_chat(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    monkeypatch.delenv("JAMASP_TG_NEWS_CHAT", raising=False)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 1)])
    poster = FakePoster()
    stats = flash.run_flash(
        conn, SETTINGS, SOURCES, post=poster,
        run_model=model({one: {"gold": True, "dup_of": None}}),
    )
    assert stats["errors"] == 1 and poster.calls == []
    assert conn.execute(
        "SELECT COUNT(*) c FROM source_errors WHERE source = 'flash'"
    ).fetchone()["c"] == 1


def test_run_flash_disabled_by_settings(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("reuters", "Gold hits record", 1)])
    settings = {**SETTINGS, "flash": {**SETTINGS["flash"], "enabled": False}}
    poster = FakePoster()
    stats = flash.run_flash(conn, settings, SOURCES, post=poster,
                            run_model=model({}))
    assert stats == {"posted": 0, "dup": 0, "not_gold": 0, "stale": 0,
                     "burst": 0, "errors": 0}
    assert poster.calls == []


def test_run_flash_dry_run_emits_without_sending(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    (one,) = seed(conn, [("reuters", "Gold hits record", 1)])
    poster = FakePoster()
    seen = []
    stats = flash.run_flash(
        conn, SETTINGS, SOURCES, post=poster,
        run_model=model({one: {"gold": True, "dup_of": None}}),
        emit=seen.append, dry_run=True,
    )
    assert poster.calls == []
    assert stats["posted"] == 1
    assert len(seen) == 1 and "منابع: Reuters" in seen[0]
    assert conn.execute("SELECT COUNT(*) c FROM flashes").fetchone()["c"] == 0
    assert conn.execute("SELECT COUNT(*) c FROM flash_items").fetchone()["c"] == 0


def test_run_flash_dry_run_does_not_retire_stale(tmp_path, monkeypatch):
    no_extract(monkeypatch)
    conn = db.connect(tmp_path / "t.db")
    seed(conn, [("reuters", "Ancient news", 40)])
    stats = flash.run_flash(
        conn, SETTINGS, SOURCES, post=FakePoster(), run_model=model({}),
        emit=lambda t: None, dry_run=True,
    )
    assert stats["stale"] == 0
    assert conn.execute("SELECT COUNT(*) c FROM flash_items").fetchone()["c"] == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_flash.py -v`
Expected: FAIL — `AttributeError: module 'jamasp.flash' has no attribute 'run_flash'`.

- [ ] **Step 3: Implement the tick**

Add these imports at the top of `jamasp/flash.py`:

```python
from typing import Callable

from jamasp import config as config_mod
from jamasp import extract as extract_mod
from jamasp import flashtext
from jamasp import notify as notify_mod
```

Append to `jamasp/flash.py`:

```python
def _run_model(cmd: list[str], prompt: str) -> str:
    result = subprocess.run(
        list(cmd) + [prompt],
        capture_output=True,
        text=True,
        timeout=MODEL_TIMEOUT_SECONDS,
        check=True,
    )
    return result.stdout


def source_labels(
    conn: sqlite3.Connection, flash_id: str, display: dict[str, str]
) -> list[str]:
    """Labels for a flash's sources, in arrival order, without repeats."""
    rows = conn.execute(
        "SELECT i.source FROM flash_items f JOIN items i ON i.id = f.item_id"
        " WHERE f.flash_id = ? ORDER BY f.ts, i.published_at",
        (flash_id,),
    ).fetchall()
    labels: list[str] = []
    for r in rows:
        label = display.get(r["source"], r["source"])
        if label not in labels:
            labels.append(label)
    return labels


def _render_flash(
    conn: sqlite3.Connection, row, display: dict[str, str], extra: str | None = None
) -> str:
    labels = source_labels(conn, row["id"], display)
    if extra and extra not in labels:
        labels.append(extra)
    return flashtext.render_message(
        row["title_fa"],
        row["summary_fa"],
        row["impact_fa"],
        row["url"],
        row["published_at"],
        labels,
    )


def _publish(conn, item, cfg, display, chat, post, run_model, emit, dry_run):
    """Post one new story. Returns its flash id, or None on failure."""
    label = display.get(item["source"], item["source"])
    try:
        body = extract_mod.extract_url(conn, item["url"], cfg["extract_chars"])
    except Exception:
        body = ""  # not a failure: the write prompt falls back to headline + lede
    prompt = flashtext.build_write_prompt(
        item["headline"], label, item["published_at"], body, item["lede"]
    )
    try:
        fields = flashtext.parse_write_response(run_model(cfg["write_cmd"], prompt))
    except Exception as exc:
        log_error(conn, exc)
        return None
    text = flashtext.render_message(
        fields["title_fa"],
        fields["summary_fa"],
        fields["impact_fa"],
        item["url"],
        item["published_at"],
        [label],
    )
    if dry_run:
        if emit:
            emit(text)
        return item["id"]
    token, chat_id = chat
    try:
        message_id = notify_mod.send_telegram(text, token, chat_id, post=post)
    except Exception as exc:
        log_error(conn, exc)
        return None
    now = utcnow()
    conn.execute(
        "INSERT INTO flashes (id, created_at, updated_at, title_en, title_fa,"
        " summary_fa, impact_fa, url, message_id, status)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent')",
        (item["id"], now, now, item["headline"], fields["title_fa"],
         fields["summary_fa"], fields["impact_fa"], item["url"], message_id),
    )
    conn.commit()
    record(conn, item["id"], item["id"], "posted")
    return item["id"]


def _apply_dup(conn, item, row, display, chat, post, emit, dry_run) -> bool:
    """Fold one repeat into an existing flash. Returns False only on a retryable error."""
    label = display.get(item["source"], item["source"])
    known = source_labels(conn, row["id"], display)
    if label in known or row["status"] == "orphaned":
        # nothing to change, or nothing left to edit
        if not dry_run:
            record(conn, item["id"], row["id"], "dup")
        return True
    text = _render_flash(conn, row, display, extra=label)
    if dry_run:
        if emit:
            emit(text)
        return True
    token, chat_id = chat
    try:
        notify_mod.edit_telegram(text, token, chat_id, row["message_id"], post=post)
    except notify_mod.MessageGone:
        conn.execute(
            "UPDATE flashes SET status = 'orphaned', updated_at = ? WHERE id = ?",
            (utcnow(), row["id"]),
        )
        conn.commit()
        record(conn, item["id"], row["id"], "dup")
        return True
    except Exception as exc:
        log_error(conn, exc)
        return False
    conn.execute(
        "UPDATE flashes SET updated_at = ? WHERE id = ?", (utcnow(), row["id"])
    )
    conn.commit()
    record(conn, item["id"], row["id"], "dup")
    return True


def run_flash(
    conn: sqlite3.Connection,
    settings: dict,
    sources: list,
    post: Callable | None = None,
    run_model: Callable[[list[str], str], str] | None = None,
    emit: Callable[[str], None] | None = None,
    dry_run: bool = False,
) -> dict[str, int]:
    """One flash pass. Never raises; every failure is counted and logged."""
    stats = {"posted": 0, "dup": 0, "not_gold": 0, "stale": 0, "burst": 0, "errors": 0}
    cfg = settings.get("flash") or {}
    if not cfg.get("enabled"):
        return stats
    run_model = run_model or _run_model
    try:
        chat = notify_mod.resolve_chat(settings, "news")
    except RuntimeError as exc:
        log_error(conn, exc)
        stats["errors"] += 1
        return stats

    if not dry_run:
        stats["stale"] = retire_stale(conn, cfg["max_age_hours"])
    pending = candidates(conn, cfg["max_age_hours"], cfg["classify_batch_max"])
    if not pending:
        return stats

    known = {row["id"]: row for row in posted_flashes(conn)}
    try:
        verdicts = flashtext.parse_decide_response(
            run_model(cfg["decide_cmd"], flashtext.build_decide_prompt(
                list(known.values()), pending
            ))
        )
    except Exception as exc:
        log_error(conn, exc)
        stats["errors"] += 1
        return stats

    display = config_mod.display_names(sources)
    # item id -> flash id, for stories first published during this very tick
    fresh: dict[str, str] = {}
    budget = cfg["max_posts_per_tick"]
    for item in pending:
        verdict = verdicts.get(item["id"])
        if verdict is None:
            continue  # unclassified: left unprocessed, retried next tick
        if not verdict["gold"]:
            if not dry_run:
                record(conn, item["id"], None, "not_gold")
            stats["not_gold"] += 1
            continue
        target_id = verdict["dup_of"]
        target_id = fresh.get(target_id, target_id)
        row = known.get(target_id) if target_id else None
        if row is not None:
            if _apply_dup(conn, item, row, display, chat, post, emit, dry_run):
                stats["dup"] += 1
            else:
                stats["errors"] += 1
            continue
        if budget <= 0:
            if not dry_run:
                record(conn, item["id"], None, "skipped_burst")
            stats["burst"] += 1
            continue
        flash_id = _publish(
            conn, item, cfg, display, chat, post, run_model, emit, dry_run
        )
        if flash_id is None:
            stats["errors"] += 1
            continue
        budget -= 1
        stats["posted"] += 1
        if not dry_run:
            # later items in this same tick can now be folded into it
            known = {row["id"]: row for row in posted_flashes(conn)}
            fresh[item["id"]] = flash_id
    return stats
```

A note on `fresh`: the decide prompt tells the model that `dup_of` may name an earlier-listed NEW item, which is how two outlets carrying the same story inside a single tick collapse into one message. `fresh` maps that candidate id onto the flash id it produced. When the referenced candidate was never published — it was `not_gold`, it failed, or it lost to the burst cap — the lookup misses and the item is treated as a new story, which is the safe direction.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_flash.py -v`
Expected: PASS (22 tests)

- [ ] **Step 5: Run the whole suite**

Run: `uv run pytest -q`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add jamasp/flash.py tests/test_flash.py
git commit -m "feat(flash): classify, publish, and deduplicate one tick of news"
```

---

### Task 6: CLI wiring and ingest integration

**Files:**
- Modify: `jamasp/cli.py`
- Modify: `config/settings.yaml`
- Test: `tests/test_cli.py`

**Interfaces:**
- Consumes: `flash.run_flash` from Task 5.
- Produces: `jamasp flash [--dry-run]`, and `jamasp ingest [--no-flash]`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_cli.py`, following the file's existing `CliRunner` conventions:

```python
def test_flash_command_reports_stats(tmp_path, monkeypatch):
    from click.testing import CliRunner

    from jamasp import cli, flash as flash_mod

    called = {}

    def fake_run_flash(conn, settings, sources, **kwargs):
        called["dry_run"] = kwargs.get("dry_run")
        return {"posted": 2, "dup": 1, "not_gold": 3, "stale": 4,
                "burst": 0, "errors": 0}

    monkeypatch.setattr(flash_mod, "run_flash", fake_run_flash)
    result = CliRunner().invoke(
        cli.main, ["flash", "--db", str(tmp_path / "t.db")]
    )
    assert result.exit_code == 0
    assert "2 posted" in result.output and "1 updated" in result.output
    assert called["dry_run"] is False


def test_flash_dry_run_passes_flag(tmp_path, monkeypatch):
    from click.testing import CliRunner

    from jamasp import cli, flash as flash_mod

    called = {}

    def fake_run_flash(conn, settings, sources, **kwargs):
        called["dry_run"] = kwargs.get("dry_run")
        return {"posted": 0, "dup": 0, "not_gold": 0, "stale": 0,
                "burst": 0, "errors": 0}

    monkeypatch.setattr(flash_mod, "run_flash", fake_run_flash)
    result = CliRunner().invoke(
        cli.main, ["flash", "--dry-run", "--db", str(tmp_path / "t.db")]
    )
    assert result.exit_code == 0
    assert called["dry_run"] is True


def test_ingest_no_flash_skips_the_pass(tmp_path, monkeypatch):
    from click.testing import CliRunner

    from jamasp import cli, flash as flash_mod

    calls = []
    monkeypatch.setattr(
        flash_mod, "run_flash", lambda *a, **k: calls.append(1) or {}
    )
    CliRunner().invoke(
        cli.main,
        ["ingest", "--no-digest", "--no-flash", "--db", str(tmp_path / "t.db")],
    )
    assert calls == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_cli.py -v -k flash`
Expected: FAIL — `no such command 'flash'`, and `no such option: --no-flash`.

- [ ] **Step 3: Add the settings block**

Append to `config/settings.yaml`:

```yaml
flash:
  enabled: true
  max_age_hours: 6
  max_posts_per_tick: 10
  classify_batch_max: 30
  extract_chars: 4000
  decide_cmd: ["claude", "-p", "--model", "sonnet"]
  write_cmd: ["claude", "-p", "--model", "sonnet"]
```

- [ ] **Step 4: Wire the CLI**

In `jamasp/cli.py`, add `from jamasp import flash as flash_mod` to the import block (alphabetical, after `extract_mod`).

Add a `--no-flash` option to `ingest` alongside `--no-digest`:

```python
@click.option("--no-flash", is_flag=True, help="skip the telegram news flash pass")
```

and add `no_flash` to the `ingest` signature after `no_digest`. Then, after the `ledes = ...` line and before `db_mod.set_meta(conn, "last_ingest_at", ...)`:

```python
    flashes = {}
    if not no_flash:
        flashes = flash_mod.run_flash(conn, settings, sources)
```

Extend the closing `click.echo` to report it:

```python
    click.echo(
        f"ingest: {new_items} new items ({joined} clustered), "
        f"{prices_n} price snapshots, {events_n} events, {ledes} ledes, "
        f"{errors} source errors, {skipped} within interval"
    )
    if flashes:
        click.echo(
            f"flash: {flashes['posted']} posted, {flashes['dup']} updated, "
            f"{flashes['not_gold']} not gold, {flashes['burst']} over cap, "
            f"{flashes['stale']} stale, {flashes['errors']} errors"
        )
```

Add the standalone command after the `extract` command:

```python
@main.command()
@click.option("--dry-run", is_flag=True, help="render messages; send and store nothing")
@db_opt
@cfg_opt
def flash(dry_run, db_path, config_dir):
    """Publish new gold items to the Telegram news channel (one pass)."""
    conn, sources, settings = _common(db_path, config_dir)
    stats = flash_mod.run_flash(
        conn, settings, sources, emit=click.echo, dry_run=dry_run
    )
    click.echo(
        f"flash: {stats['posted']} posted, {stats['dup']} updated, "
        f"{stats['not_gold']} not gold, {stats['burst']} over cap, "
        f"{stats['stale']} stale, {stats['errors']} errors"
    )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest -q`
Expected: PASS

- [ ] **Step 6: Smoke-test the wiring**

Run: `uv run jamasp flash --dry-run --db /tmp/flash-smoke.db`
Expected: exits 0 and prints a `flash:` summary line with all zeros — the database is empty, so no model call is made.

- [ ] **Step 7: Commit**

```bash
git add jamasp/cli.py config/settings.yaml tests/test_cli.py
git commit -m "feat(cli): jamasp flash command and ingest --no-flash"
```

---

### Task 7: Documentation and deployment notes

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.claude/skills/deploy/SKILL.md`

**Interfaces:**
- Consumes: the CLI surface from Task 6.
- Produces: nothing code depends on.

- [ ] **Step 1: Update the toolbox table in CLAUDE.md**

Add a row after the `uv run jamasp ingest` row:

```markdown
| `uv run jamasp flash [--dry-run]` | publish new gold items to the Telegram news channel (runs automatically inside `ingest`) |
```

- [ ] **Step 2: Add a note to the Deployment section of CLAUDE.md**

Append this paragraph to the Deployment section:

```markdown
Between agent runs, the ingest timer also publishes each gold-touching item to
a **separate Telegram news channel** (`JAMASP_TG_NEWS_CHAT`) as a Persian
summary plus impact read, deduped against the last 24 hours and edited in place
when a second source carries the same story. This is a deterministic pipeline
stage, not an agent run: it consumes no agent-run budget and needs no
supervision. The desk chat stays reserved for briefs, scan alerts, and failure
notices.
```

- [ ] **Step 3: Update the deploy skill**

In `.claude/skills/deploy/SKILL.md`, find the step that writes `~/.config/jamasp/env` and add `JAMASP_TG_NEWS_CHAT` alongside `JAMASP_TG_TOKEN` and `JAMASP_TG_CHAT`, with this note:

```markdown
`JAMASP_TG_NEWS_CHAT` is the channel that receives per-story gold news
flashes. Create a second Telegram channel, add the same bot to it as an
administrator with "Post Messages" and "Edit Messages of Others" both
enabled — the flash pipeline edits its own messages when a second source
picks up a story — and put its chat id here. If the variable is missing, the
flash pass disables itself and logs to `source_errors`; ingestion, briefs, and
scans are unaffected.
```

- [ ] **Step 4: Verify the docs match reality**

Run: `uv run jamasp --help`
Expected: `flash` is listed among the commands, with the docstring from Task 6.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md .claude/skills/deploy/SKILL.md
git commit -m "docs: news flash toolbox entry and news-channel deployment step"
```

---

## Verification

After all seven tasks:

- [ ] `uv run pytest -q` — full suite passes.
- [ ] `uv run jamasp flash --dry-run` on the real database renders messages and sends nothing.
- [ ] `uv run jamasp ingest --no-flash` behaves exactly as before this change.
- [ ] With `JAMASP_TG_NEWS_CHAT` unset, `uv run jamasp flash` exits 0, sends nothing, and writes one `source_errors` row with `source = 'flash'`.

First live run on the host is best done as `uv run jamasp flash --dry-run` to read the Persian output before any message reaches the channel, then a single real `uv run jamasp flash` with `max_posts_per_tick` temporarily set to `1`.
