# Jamasp Phase 1 (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Mac-runnable pipeline that ingests gold-relevant news and prices into SQLite, and a `/brief` Claude Code skill that turns the delta into a daily English report + Persian Telegram summary.

**Architecture:** Deterministic Python CLI (`jamasp`) does all fetching/deduping/compacting; Claude Code headless reads only compact tool output. One SQLite DB in `state/`, declarative sources in `config/sources.yaml`, dated markdown reports in `reports/`. A batched Haiku call (via `claude -p`) writes uniform one-line ledes at ingest time.

**Tech Stack:** Python ≥3.12, uv, click, httpx, feedparser, trafilatura, rapidfuzz, PyYAML, pytest. Telegram via raw Bot API (httpx). Prices via Stooq CSV + FRED CSV (free, no keys).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-31-jamasp-design.md` — phase 1 scope only (no wakeup queue, no /scan, no /deepdive, no predictions, no dispatcher, no watchdog).
- Raw HTML/web content must never be printed by any CLI command except `jamasp extract` (which prints readability-extracted text truncated to `extract_max_chars`).
- Inbox output is compact JSONL, hard-capped at `inbox_cap` (default 120), with overflow degrading to a count-by-topic summary line.
- All timestamps stored in UTC ISO-8601 (`YYYY-MM-DDTHH:MM:SSZ`); display timezone is Asia/Dubai.
- `state/jamasp.db` is committed to git per spec (audit trail); do NOT gitignore it.
- Secrets (Telegram token/chat id) come from env vars `JAMASP_TG_TOKEN` / `JAMASP_TG_CHAT`, never from files in the repo.
- Every network fetcher must fail per-source: one dead feed never aborts the ingest run; failures are recorded in the `source_errors` table.
- Python code style: stdlib `sqlite3`, dataclasses, type hints, no ORM, no async (httpx sync client).

---

### Task 1: Repo scaffold & test harness

**Files:**
- Create: `pyproject.toml`, `.gitignore`, `jamasp/__init__.py`, `tests/__init__.py`, `tests/test_scaffold.py`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: installable package `jamasp` with console script `jamasp = "jamasp.cli:main"`; `uv run pytest` works. Later tasks add modules under `jamasp/` and tests under `tests/`.

- [ ] **Step 1: Write pyproject.toml**

```toml
[project]
name = "jamasp"
version = "0.1.0"
description = "Jamasp — autonomous gold-market analyst agent toolbox"
requires-python = ">=3.12"
dependencies = [
    "click>=8.1",
    "httpx>=0.27",
    "feedparser>=6.0",
    "trafilatura>=1.9",
    "rapidfuzz>=3.9",
    "pyyaml>=6.0",
]

[project.scripts]
jamasp = "jamasp.cli:main"

[dependency-groups]
dev = ["pytest>=8.0"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["jamasp"]
```

- [ ] **Step 2: Write .gitignore**

```gitignore
__pycache__/
*.pyc
.venv/
dist/
.pytest_cache/
```

Note: `state/jamasp.db` is intentionally NOT ignored (spec: state is committed).

- [ ] **Step 3: Create package + failing smoke test**

`jamasp/__init__.py`:
```python
__version__ = "0.1.0"
```

`tests/__init__.py`: empty file.

`tests/test_scaffold.py`:
```python
import jamasp


def test_package_importable():
    assert jamasp.__version__ == "0.1.0"
```

- [ ] **Step 4: Sync env and run tests**

Run: `uv sync && uv run pytest -v`
Expected: `test_package_importable PASSED`

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml .gitignore jamasp/ tests/ uv.lock
git commit -m "feat: scaffold jamasp python package with uv + pytest"
```

---

### Task 2: Config loading & starting configs

**Files:**
- Create: `jamasp/config.py`, `config/sources.yaml`, `config/settings.yaml`, `tests/test_config.py`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `@dataclass Source(name: str, type: str, url: str, interval_minutes: int, topic: str, parser: str | None)`
  - `load_sources(path: Path = Path("config/sources.yaml")) -> list[Source]`
  - `load_settings(path: Path = Path("config/settings.yaml")) -> dict` (plain dict, callers index keys)

- [ ] **Step 1: Write failing tests**

`tests/test_config.py`:
```python
from pathlib import Path

from jamasp.config import Source, load_settings, load_sources

FIXTURES = Path(__file__).parent / "fixtures"


def test_load_sources_parses_entries(tmp_path):
    p = tmp_path / "sources.yaml"
    p.write_text(
        """
sources:
  - name: fxstreet
    type: rss
    url: https://www.fxstreet.com/rss/news
    interval_minutes: 15
    topic: markets
  - name: gold_spot
    type: price_api
    url: "https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv"
    interval_minutes: 15
    topic: prices
    parser: stooq_csv
"""
    )
    sources = load_sources(p)
    assert len(sources) == 2
    assert sources[0] == Source("fxstreet", "rss", "https://www.fxstreet.com/rss/news", 15, "markets", None)
    assert sources[1].parser == "stooq_csv"


def test_load_settings(tmp_path):
    p = tmp_path / "settings.yaml"
    p.write_text("inbox_cap: 120\ntimezone: Asia/Dubai\n")
    s = load_settings(p)
    assert s["inbox_cap"] == 120


def test_repo_configs_load():
    sources = load_sources()
    assert any(s.type == "rss" for s in sources)
    assert any(s.type == "price_api" for s in sources)
    settings = load_settings()
    assert settings["inbox_cap"] == 120
    assert settings["timezone"] == "Asia/Dubai"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'jamasp.config'`

- [ ] **Step 3: Implement config.py**

```python
"""Load declarative source and settings config."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass(frozen=True)
class Source:
    name: str
    type: str  # rss | price_api  (calendar arrives in phase 2)
    url: str
    interval_minutes: int
    topic: str
    parser: str | None = None


def load_sources(path: Path = Path("config/sources.yaml")) -> list[Source]:
    raw = yaml.safe_load(path.read_text())
    return [
        Source(
            name=e["name"],
            type=e["type"],
            url=e["url"],
            interval_minutes=e["interval_minutes"],
            topic=e["topic"],
            parser=e.get("parser"),
        )
        for e in raw["sources"]
    ]


def load_settings(path: Path = Path("config/settings.yaml")) -> dict:
    return yaml.safe_load(path.read_text())
```

- [ ] **Step 4: Write the starting configs**

`config/sources.yaml` (feed URLs get live-verified in Task 11; expect to prune/replace some):
```yaml
sources:
  # --- news wires (rss) ---
  - name: fxstreet
    type: rss
    url: https://www.fxstreet.com/rss/news
    interval_minutes: 15
    topic: markets
  - name: investing_commodities
    type: rss
    url: https://www.investing.com/rss/news_11.rss
    interval_minutes: 15
    topic: gold
  - name: marketwatch_top
    type: rss
    url: https://feeds.content.dowjones.io/public/rss/mw_topstories
    interval_minutes: 15
    topic: markets
  - name: kitco
    type: rss
    url: https://www.kitco.com/rss/
    interval_minutes: 15
    topic: gold
  - name: fed_press
    type: rss
    url: https://www.federalreserve.gov/feeds/press_all.xml
    interval_minutes: 60
    topic: fed
  - name: treasury_press
    type: rss
    url: https://home.treasury.gov/rss/press.xml
    interval_minutes: 60
    topic: fiscal
  # --- prices (price_api) ---
  - name: gold_spot
    type: price_api
    url: "https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv"
    interval_minutes: 15
    topic: prices
    parser: stooq_csv
  - name: dollar_index
    type: price_api
    url: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTWEXBGS"
    interval_minutes: 60
    topic: prices
    parser: fred_csv
  - name: real_yield_10y
    type: price_api
    url: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10"
    interval_minutes: 60
    topic: prices
    parser: fred_csv
```

`config/settings.yaml`:
```yaml
timezone: Asia/Dubai
inbox_cap: 120
extract_max_chars: 16000
digest:
  claude_cmd: ["claude", "-p", "--model", "haiku"]
  batch_max_items: 60
cluster:
  similarity_threshold: 80
  window_hours: 48
telegram:
  bot_token_env: JAMASP_TG_TOKEN
  chat_id_env: JAMASP_TG_CHAT
```

- [ ] **Step 5: Run tests, expect pass**

Run: `uv run pytest tests/test_config.py -v`
Expected: 3 PASSED

- [ ] **Step 6: Commit**

```bash
git add jamasp/config.py config/ tests/test_config.py
git commit -m "feat: config loading + starting sources/settings"
```

---

### Task 3: SQLite store

**Files:**
- Create: `jamasp/db.py`, `jamasp/models.py`, `tests/test_db.py`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `models.Item(id: str, source: str, published_at: str, headline: str, url: str, topic: str, lede: str | None = None)`
  - `db.connect(path: Path = Path("state/jamasp.db")) -> sqlite3.Connection` — creates schema idempotently, `row_factory = sqlite3.Row`
  - `db.utcnow() -> str` — `"YYYY-MM-DDTHH:MM:SSZ"`
  - Tables: `items(id PK, source, published_at, headline, lede, url, topic, cluster_id, fetched_at, read_at)`, `prices(symbol, ts, value, PRIMARY KEY(symbol, ts))`, `extract_cache(url PK, fetched_at, text)`, `source_errors(source, ts, error)`

- [ ] **Step 1: Write failing tests**

`tests/test_db.py`:
```python
from jamasp import db


def test_connect_creates_schema(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    tables = {
        r["name"]
        for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {"items", "prices", "extract_cache", "source_errors"} <= tables


def test_connect_is_idempotent(tmp_path):
    p = tmp_path / "t.db"
    db.connect(p).close()
    conn = db.connect(p)  # must not raise on existing schema
    conn.execute("INSERT INTO prices VALUES ('XAUUSD', '2026-07-31T00:00:00Z', 3400.0)")
    conn.commit()


def test_utcnow_format():
    ts = db.utcnow()
    assert len(ts) == 20 and ts.endswith("Z") and ts[10] == "T"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_db.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement models.py and db.py**

`jamasp/models.py`:
```python
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Item:
    id: str
    source: str
    published_at: str  # UTC ISO-8601 Z
    headline: str
    url: str
    topic: str
    lede: str | None = None
```

`jamasp/db.py`:
```python
"""SQLite store: schema + connection helpers."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    id           TEXT PRIMARY KEY,
    source       TEXT NOT NULL,
    published_at TEXT NOT NULL,
    headline     TEXT NOT NULL,
    lede         TEXT,
    url          TEXT NOT NULL,
    topic        TEXT NOT NULL,
    cluster_id   TEXT,
    fetched_at   TEXT NOT NULL,
    read_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_read ON items(read_at);
CREATE TABLE IF NOT EXISTS prices (
    symbol TEXT NOT NULL,
    ts     TEXT NOT NULL,
    value  REAL NOT NULL,
    PRIMARY KEY (symbol, ts)
);
CREATE TABLE IF NOT EXISTS extract_cache (
    url        TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL,
    text       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_errors (
    source TEXT NOT NULL,
    ts     TEXT NOT NULL,
    error  TEXT NOT NULL
);
"""


def connect(path: Path = Path("state/jamasp.db")) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
```

- [ ] **Step 4: Run tests, expect pass**

Run: `uv run pytest tests/test_db.py -v`
Expected: 3 PASSED

- [ ] **Step 5: Commit**

```bash
git add jamasp/db.py jamasp/models.py tests/test_db.py
git commit -m "feat: sqlite store with items/prices/extract_cache/source_errors"
```

---

### Task 4: RSS parsing & storage

**Files:**
- Create: `jamasp/ingest/__init__.py`, `jamasp/ingest/rss.py`, `tests/test_rss.py`, `tests/fixtures/feed_fxstreet.xml`

**Interfaces:**
- Consumes: `config.Source`, `models.Item`, `db.utcnow`
- Produces:
  - `rss.item_id(source_name: str, url: str, headline: str) -> str` — 16-hex-char sha256 prefix
  - `rss.parse_feed(source: Source, content: bytes) -> list[Item]` — pure, no network
  - `rss.store_items(conn, items: list[Item]) -> int` — INSERT OR IGNORE, returns newly-inserted count
  - `rss.fetch_source(source: Source, client: httpx.Client) -> list[Item]` — raises on HTTP error (caller logs to `source_errors`)

- [ ] **Step 1: Write fixture feed**

`tests/fixtures/feed_fxstreet.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>FXStreet News</title>
    <item>
      <title>Gold climbs as dollar softens ahead of Fed decision</title>
      <link>https://www.fxstreet.com/news/gold-climbs-1</link>
      <description>Gold rose 0.8% on Wednesday as traders positioned for the FOMC.</description>
      <pubDate>Wed, 30 Jul 2026 14:05:00 GMT</pubDate>
    </item>
    <item>
      <title>US CPI due Thursday: what markets expect</title>
      <link>https://www.fxstreet.com/news/us-cpi-preview-2</link>
      <description>Consensus sees core CPI at 0.2% m/m.</description>
      <pubDate>Wed, 30 Jul 2026 12:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>
```

- [ ] **Step 2: Write failing tests**

`tests/test_rss.py`:
```python
from pathlib import Path

from jamasp import db
from jamasp.config import Source
from jamasp.ingest import rss

FIXTURES = Path(__file__).parent / "fixtures"
SRC = Source("fxstreet", "rss", "https://x.example/rss", 15, "markets")


def _items():
    return rss.parse_feed(SRC, (FIXTURES / "feed_fxstreet.xml").read_bytes())


def test_parse_feed_extracts_items():
    items = _items()
    assert len(items) == 2
    first = items[0]
    assert first.headline == "Gold climbs as dollar softens ahead of Fed decision"
    assert first.url == "https://www.fxstreet.com/news/gold-climbs-1"
    assert first.published_at == "2026-07-30T14:05:00Z"
    assert first.source == "fxstreet"
    assert first.topic == "markets"
    assert first.id == rss.item_id("fxstreet", first.url, first.headline)


def test_item_id_is_stable_and_short():
    a = rss.item_id("s", "u", "h")
    assert a == rss.item_id("s", "u", "h") and len(a) == 16


def test_store_items_dedupes(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    items = _items()
    assert rss.store_items(conn, items) == 2
    assert rss.store_items(conn, items) == 0  # same ids: ignored
    n = conn.execute("SELECT COUNT(*) c FROM items").fetchone()["c"]
    assert n == 2
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_rss.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'jamasp.ingest'`

- [ ] **Step 4: Implement rss.py**

`jamasp/ingest/__init__.py`: empty file.

`jamasp/ingest/rss.py`:
```python
"""Fetch and normalize RSS sources into Items."""
from __future__ import annotations

import calendar
import hashlib
import sqlite3
from datetime import datetime, timezone

import feedparser
import httpx

from jamasp.config import Source
from jamasp.db import utcnow
from jamasp.models import Item


def item_id(source_name: str, url: str, headline: str) -> str:
    raw = f"{source_name}|{url}|{headline}".encode()
    return hashlib.sha256(raw).hexdigest()[:16]


def _published_at(entry) -> str:
    parsed = entry.get("published_parsed") or entry.get("updated_parsed")
    if parsed:
        dt = datetime.fromtimestamp(calendar.timegm(parsed), tz=timezone.utc)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    return utcnow()


def parse_feed(source: Source, content: bytes) -> list[Item]:
    feed = feedparser.parse(content)
    items = []
    for e in feed.entries:
        headline = (e.get("title") or "").strip()
        url = (e.get("link") or "").strip()
        if not headline or not url:
            continue
        items.append(
            Item(
                id=item_id(source.name, url, headline),
                source=source.name,
                published_at=_published_at(e),
                headline=headline,
                url=url,
                topic=source.topic,
            )
        )
    return items


def fetch_source(source: Source, client: httpx.Client) -> list[Item]:
    resp = client.get(source.url, follow_redirects=True, timeout=30)
    resp.raise_for_status()
    return parse_feed(source, resp.content)


def store_items(conn: sqlite3.Connection, items: list[Item]) -> int:
    now = utcnow()
    inserted = 0
    for it in items:
        cur = conn.execute(
            "INSERT OR IGNORE INTO items (id, source, published_at, headline, url, topic, fetched_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (it.id, it.source, it.published_at, it.headline, it.url, it.topic, now),
        )
        inserted += cur.rowcount
    conn.commit()
    return inserted
```

- [ ] **Step 5: Run tests, expect pass**

Run: `uv run pytest tests/test_rss.py -v`
Expected: 3 PASSED

- [ ] **Step 6: Commit**

```bash
git add jamasp/ingest/ tests/test_rss.py tests/fixtures/
git commit -m "feat: rss fetch/normalize/dedupe into items table"
```

---

### Task 5: Price fetchers (Stooq + FRED)

**Files:**
- Create: `jamasp/ingest/prices.py`, `tests/test_prices.py`, `tests/fixtures/stooq_xauusd.csv`, `tests/fixtures/fred_dfii10.csv`

**Interfaces:**
- Consumes: `config.Source` (`parser` field selects the format), `db` tables
- Produces:
  - `prices.parse_stooq_csv(text: str) -> tuple[str, str, float]` — `(symbol_upper, ts_iso, close)`
  - `prices.parse_fred_csv(text: str) -> tuple[str, str, float]` — `(series_id, ts_iso, latest_value)` skipping missing `"."` rows
  - `prices.fetch_price(source: Source, client: httpx.Client) -> tuple[str, str, float]`
  - `prices.store_price(conn, symbol: str, ts: str, value: float) -> None` (INSERT OR IGNORE)
  - `prices.latest(conn, symbol: str) -> sqlite3.Row | None` and `prices.value_at_or_before(conn, symbol: str, ts: str) -> float | None` (used by Task 12)

- [ ] **Step 1: Write fixtures**

`tests/fixtures/stooq_xauusd.csv`:
```csv
Symbol,Date,Time,Open,High,Low,Close,Volume
XAUUSD,2026-07-30,22:59:52,3391.24,3416.80,3388.10,3412.55,0
```

`tests/fixtures/fred_dfii10.csv`:
```csv
observation_date,DFII10
2026-07-28,1.92
2026-07-29,.
2026-07-30,1.95
```

- [ ] **Step 2: Write failing tests**

`tests/test_prices.py`:
```python
from pathlib import Path

from jamasp import db
from jamasp.ingest import prices

FIXTURES = Path(__file__).parent / "fixtures"


def test_parse_stooq_csv():
    symbol, ts, value = prices.parse_stooq_csv((FIXTURES / "stooq_xauusd.csv").read_text())
    assert symbol == "XAUUSD"
    assert ts == "2026-07-30T22:59:52Z"
    assert value == 3412.55


def test_parse_fred_csv_skips_missing():
    symbol, ts, value = prices.parse_fred_csv((FIXTURES / "fred_dfii10.csv").read_text())
    assert symbol == "DFII10"
    assert ts == "2026-07-30T00:00:00Z"
    assert value == 1.95


def test_store_and_query(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    prices.store_price(conn, "XAUUSD", "2026-07-29T00:00:00Z", 3390.0)
    prices.store_price(conn, "XAUUSD", "2026-07-30T00:00:00Z", 3412.55)
    prices.store_price(conn, "XAUUSD", "2026-07-30T00:00:00Z", 9999.0)  # dup ts ignored
    assert prices.latest(conn, "XAUUSD")["value"] == 3412.55
    assert prices.value_at_or_before(conn, "XAUUSD", "2026-07-29T12:00:00Z") == 3390.0
    assert prices.value_at_or_before(conn, "XAUUSD", "2026-07-28T00:00:00Z") is None
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_prices.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 4: Implement prices.py**

```python
"""Price snapshot fetchers: Stooq CSV and FRED CSV."""
from __future__ import annotations

import csv
import io
import sqlite3

import httpx

from jamasp.config import Source

PARSERS = {}


def parse_stooq_csv(text: str) -> tuple[str, str, float]:
    row = next(csv.DictReader(io.StringIO(text)))
    ts = f"{row['Date']}T{row['Time']}Z"
    return row["Symbol"].upper(), ts, float(row["Close"])


def parse_fred_csv(text: str) -> tuple[str, str, float]:
    reader = csv.reader(io.StringIO(text))
    header = next(reader)
    series = header[1]
    last = None
    for date, value in reader:
        if value.strip() and value.strip() != ".":
            last = (date, float(value))
    if last is None:
        raise ValueError(f"no observations in FRED csv for {series}")
    return series, f"{last[0]}T00:00:00Z", last[1]


PARSERS["stooq_csv"] = parse_stooq_csv
PARSERS["fred_csv"] = parse_fred_csv


def fetch_price(source: Source, client: httpx.Client) -> tuple[str, str, float]:
    resp = client.get(source.url, follow_redirects=True, timeout=30)
    resp.raise_for_status()
    return PARSERS[source.parser](resp.text)


def store_price(conn: sqlite3.Connection, symbol: str, ts: str, value: float) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO prices (symbol, ts, value) VALUES (?, ?, ?)",
        (symbol, ts, value),
    )
    conn.commit()


def latest(conn: sqlite3.Connection, symbol: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT ts, value FROM prices WHERE symbol = ? ORDER BY ts DESC LIMIT 1",
        (symbol,),
    ).fetchone()


def value_at_or_before(conn: sqlite3.Connection, symbol: str, ts: str) -> float | None:
    row = conn.execute(
        "SELECT value FROM prices WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT 1",
        (symbol, ts),
    ).fetchone()
    return row["value"] if row else None
```

- [ ] **Step 5: Run tests, expect pass**

Run: `uv run pytest tests/test_prices.py -v`
Expected: 3 PASSED

- [ ] **Step 6: Commit**

```bash
git add jamasp/ingest/prices.py tests/test_prices.py tests/fixtures/
git commit -m "feat: stooq/fred price fetchers with snapshot storage"
```

---

### Task 6: Headline clustering

**Files:**
- Create: `jamasp/cluster.py`, `tests/test_cluster.py`

**Interfaces:**
- Consumes: `items` table (`cluster_id` column), `rapidfuzz.fuzz.token_set_ratio`
- Produces: `cluster.assign_clusters(conn, threshold: int = 80, window_hours: int = 48) -> int` — assigns `cluster_id` to every item where it is NULL; a near-duplicate joins the earlier item's cluster, otherwise `cluster_id = id` (it becomes its own representative). Returns number of items that joined an existing cluster. Inbox (Task 8) shows only representatives (`cluster_id = id`) with `also_reported_by`.

- [ ] **Step 1: Write failing tests**

`tests/test_cluster.py`:
```python
from jamasp import cluster, db
from jamasp.config import Source
from jamasp.ingest import rss
from jamasp.models import Item


def _mk(conn, source, headline, ts="2026-07-30T14:00:00Z"):
    it = Item(
        id=rss.item_id(source, f"https://{source}.example/{headline[:10]}", headline),
        source=source,
        published_at=ts,
        headline=headline,
        url=f"https://{source}.example/x",
        topic="gold",
    )
    rss.store_items(conn, [it])
    return it


def test_near_duplicates_share_cluster(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    a = _mk(conn, "fxstreet", "Gold climbs as dollar softens ahead of Fed decision")
    b = _mk(conn, "kitco", "Gold climbs ahead of Fed decision as dollar softens")
    c = _mk(conn, "marketwatch_top", "Oil slides on OPEC supply surprise")
    joined = cluster.assign_clusters(conn)
    assert joined == 1
    rows = {r["id"]: r["cluster_id"] for r in conn.execute("SELECT id, cluster_id FROM items")}
    assert rows[a.id] == a.id            # representative
    assert rows[b.id] == a.id            # joined a's cluster
    assert rows[c.id] == c.id            # unrelated: own cluster


def test_old_items_outside_window_not_matched(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    _mk(conn, "fxstreet", "Gold climbs as dollar softens", ts="2026-07-01T00:00:00Z")
    conn.execute("UPDATE items SET cluster_id = id")
    conn.commit()
    b = _mk(conn, "kitco", "Gold climbs as dollar softens", ts="2026-07-30T00:00:00Z")
    cluster.assign_clusters(conn, window_hours=48)
    row = conn.execute("SELECT cluster_id FROM items WHERE id = ?", (b.id,)).fetchone()
    assert row["cluster_id"] == b.id  # month-old story is not "the same story"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_cluster.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement cluster.py**

```python
"""Cross-source near-duplicate clustering by fuzzy headline match."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

from rapidfuzz import fuzz


def _window_start(window_hours: int) -> str:
    dt = datetime.now(timezone.utc) - timedelta(hours=window_hours)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def assign_clusters(
    conn: sqlite3.Connection, threshold: int = 80, window_hours: int = 48
) -> int:
    since = _window_start(window_hours)
    candidates = conn.execute(
        "SELECT id, headline, cluster_id FROM items"
        " WHERE cluster_id IS NOT NULL AND published_at >= ?",
        (since,),
    ).fetchall()
    pending = conn.execute(
        "SELECT id, headline FROM items WHERE cluster_id IS NULL ORDER BY published_at"
    ).fetchall()

    joined = 0
    known = [(c["headline"], c["cluster_id"]) for c in candidates]
    for item in pending:
        best_cluster = None
        best_score = 0.0
        for headline, cluster_id in known:
            score = fuzz.token_set_ratio(item["headline"], headline)
            if score >= threshold and score > best_score:
                best_cluster, best_score = cluster_id, score
        cluster_id = best_cluster or item["id"]
        if best_cluster:
            joined += 1
        conn.execute(
            "UPDATE items SET cluster_id = ? WHERE id = ?", (cluster_id, item["id"])
        )
        known.append((item["headline"], cluster_id))
    conn.commit()
    return joined
```

- [ ] **Step 4: Run tests, expect pass**

Run: `uv run pytest tests/test_cluster.py -v`
Expected: 2 PASSED

- [ ] **Step 5: Commit**

```bash
git add jamasp/cluster.py tests/test_cluster.py
git commit -m "feat: fuzzy headline clustering for cross-source dedupe"
```

---

### Task 7: Haiku digest pass

**Files:**
- Create: `jamasp/digest.py`, `tests/test_digest.py`, `tests/fake_claude.py`

**Interfaces:**
- Consumes: `items` table (`lede` NULL rows), settings key `digest` (`claude_cmd: list[str]`, `batch_max_items: int`)
- Produces:
  - `digest.build_prompt(rows: list[sqlite3.Row]) -> str` — prompt lines formatted `id<TAB>headline`, requests strict JSON `{id: lede}`
  - `digest.parse_response(text: str) -> dict[str, str]` — tolerant of code fences/prose around the JSON object
  - `digest.run_digest(conn, settings: dict) -> int` — one subprocess call per invocation, updates `items.lede`, returns count updated. On subprocess failure or unparseable output: returns 0, leaves ledes NULL (inbox falls back to headline-only; never blocks ingest).

- [ ] **Step 1: Write the fake claude binary (test double)**

`tests/fake_claude.py`:
```python
"""Stand-in for the `claude` CLI: reads ids from the prompt, emits JSON ledes."""
import json
import re
import sys

prompt = sys.argv[-1]
ids = re.findall(r"^([0-9a-f]{16})\t", prompt, flags=re.MULTILINE)
print(json.dumps({i: f"LEDE for {i}" for i in ids}))
```

- [ ] **Step 2: Write failing tests**

`tests/test_digest.py`:
```python
import sys
from pathlib import Path

from jamasp import db, digest
from jamasp.ingest import rss
from jamasp.models import Item

FAKE = [sys.executable, str(Path(__file__).parent / "fake_claude.py")]


def _seed(conn, n=3):
    items = [
        Item(
            id=rss.item_id("s", f"https://e/{i}", f"Headline number {i}"),
            source="s",
            published_at="2026-07-30T10:00:00Z",
            headline=f"Headline number {i}",
            url=f"https://e/{i}",
            topic="gold",
        )
        for i in range(n)
    ]
    rss.store_items(conn, items)
    return items


def test_parse_response_tolerates_fences():
    text = 'Here you go:\n```json\n{"abc": "a lede"}\n```\nDone.'
    assert digest.parse_response(text) == {"abc": "a lede"}


def test_run_digest_fills_ledes(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    items = _seed(conn)
    settings = {"digest": {"claude_cmd": FAKE, "batch_max_items": 60}}
    assert digest.run_digest(conn, settings) == 3
    row = conn.execute("SELECT lede FROM items WHERE id = ?", (items[0].id,)).fetchone()
    assert row["lede"] == f"LEDE for {items[0].id}"
    # second run: nothing left to do, no subprocess needed
    assert digest.run_digest(conn, settings) == 0


def test_run_digest_survives_broken_cli(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    _seed(conn)
    settings = {"digest": {"claude_cmd": ["/nonexistent/claude"], "batch_max_items": 60}}
    assert digest.run_digest(conn, settings) == 0  # no crash, ledes stay NULL
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_digest.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 4: Implement digest.py**

```python
"""Batched Haiku pass: write uniform one-line ledes for new items."""
from __future__ import annotations

import json
import sqlite3
import subprocess

PROMPT_HEADER = """You are a financial newswire editor for a gold trading desk.
For each line below (format: id<TAB>headline), write a neutral one-line lede
of at most 25 words stating the concrete fact and, where obvious, its gold-market relevance.
Respond with ONLY a JSON object mapping each id to its lede string. No other text.

"""


def build_prompt(rows: list[sqlite3.Row]) -> str:
    lines = "\n".join(f"{r['id']}\t{r['headline']}" for r in rows)
    return PROMPT_HEADER + lines


def parse_response(text: str) -> dict[str, str]:
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object in response")
    parsed = json.loads(text[start : end + 1])
    return {k: str(v) for k, v in parsed.items()}


def run_digest(conn: sqlite3.Connection, settings: dict) -> int:
    cfg = settings["digest"]
    rows = conn.execute(
        "SELECT id, headline FROM items WHERE lede IS NULL AND read_at IS NULL"
        " ORDER BY published_at DESC LIMIT ?",
        (cfg["batch_max_items"],),
    ).fetchall()
    if not rows:
        return 0
    try:
        result = subprocess.run(
            list(cfg["claude_cmd"]) + [build_prompt(rows)],
            capture_output=True,
            text=True,
            timeout=120,
            check=True,
        )
        ledes = parse_response(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError, json.JSONDecodeError) as exc:
        conn.execute(
            "INSERT INTO source_errors (source, ts, error) VALUES ('digest', "
            "strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?)",
            (str(exc)[:500],),
        )
        conn.commit()
        return 0
    updated = 0
    for item_id, lede in ledes.items():
        cur = conn.execute(
            "UPDATE items SET lede = ? WHERE id = ? AND lede IS NULL", (lede, item_id)
        )
        updated += cur.rowcount
    conn.commit()
    return updated
```

- [ ] **Step 5: Run tests, expect pass**

Run: `uv run pytest tests/test_digest.py -v`
Expected: 3 PASSED

- [ ] **Step 6: Commit**

```bash
git add jamasp/digest.py tests/test_digest.py tests/fake_claude.py
git commit -m "feat: batched haiku digest pass writes one-line ledes"
```

---

### Task 8: Inbox rendering & mark-read

**Files:**
- Create: `jamasp/inbox.py`, `tests/test_inbox.py`

**Interfaces:**
- Consumes: `items`, `source_errors` tables; settings `inbox_cap`
- Produces:
  - `inbox.render(conn, cap: int = 120) -> str` — header comment lines, then one JSON line per unread *representative* item (`cluster_id = id`), newest first, keys `{"id","t","src","head","lede","topic","url","also"}` (`lede`/`also` omitted when empty); overflow line `# +N more unread: {"topic": count, ...}` when unread representatives exceed cap
  - `inbox.mark_read(conn) -> int` — sets `read_at` on ALL unread items (including cluster members), returns count
  - `inbox.dead_sources(conn, hours: int = 24) -> list[str]` — sources with an error in the window and no successfully fetched item in the window

- [ ] **Step 1: Write failing tests**

`tests/test_inbox.py`:
```python
import json

from jamasp import cluster, db, inbox
from jamasp.ingest import rss
from jamasp.models import Item


def _mk(source, headline, i, ts="2026-07-30T14:00:00Z"):
    return Item(
        id=rss.item_id(source, f"https://e/{source}/{i}", headline),
        source=source,
        published_at=ts,
        headline=headline,
        url=f"https://e/{source}/{i}",
        topic="gold",
    )


def _seed_clustered(conn):
    a = _mk("fxstreet", "Gold climbs as dollar softens ahead of Fed decision", 1)
    b = _mk("kitco", "Gold climbs ahead of Fed decision as dollar softens", 2)
    c = _mk("marketwatch_top", "Oil slides on OPEC supply surprise", 3, ts="2026-07-30T15:00:00Z")
    rss.store_items(conn, [a, b, c])
    cluster.assign_clusters(conn)
    return a, b, c


def test_render_shows_representatives_with_also(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    a, b, c = _seed_clustered(conn)
    out = inbox.render(conn)
    lines = [l for l in out.splitlines() if l and not l.startswith("#")]
    assert len(lines) == 2  # b is folded into a's cluster
    newest = json.loads(lines[0])
    assert newest["head"] == "Oil slides on OPEC supply surprise"
    rep = json.loads(lines[1])
    assert rep["also"] == ["kitco"]
    assert "lede" not in rep  # no lede yet -> key omitted


def test_render_overflow_summarizes_by_topic(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    items = [_mk("s", f"Completely distinct headline {i} {'x' * i}", i) for i in range(5)]
    rss.store_items(conn, items)
    cluster.assign_clusters(conn, threshold=101)  # force: no clustering
    out = inbox.render(conn, cap=3)
    lines = [l for l in out.splitlines() if l and not l.startswith("#")]
    assert len(lines) == 3
    assert '# +2 more unread: {"gold": 2}' in out


def test_mark_read_clears_inbox(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    _seed_clustered(conn)
    assert inbox.mark_read(conn) == 3  # cluster members marked too
    out = inbox.render(conn)
    assert "0 unread" in out
    assert inbox.mark_read(conn) == 0


def test_dead_sources(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    now = db.utcnow()
    conn.execute(
        "INSERT INTO source_errors VALUES ('treasury_press', ?, 'HTTP 404')", (now,)
    )
    conn.commit()
    assert inbox.dead_sources(conn) == ["treasury_press"]
    out = inbox.render(conn)
    assert "treasury_press" in out and "WARNING" in out
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_inbox.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement inbox.py**

```python
"""Compact JSONL inbox for agent runs."""
from __future__ import annotations

import json
import sqlite3
from collections import Counter
from datetime import datetime, timedelta, timezone

from jamasp.db import utcnow


def dead_sources(conn: sqlite3.Connection, hours: int = 24) -> list[str]:
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    rows = conn.execute(
        """
        SELECT DISTINCT e.source FROM source_errors e
        WHERE e.ts >= :since
          AND NOT EXISTS (
            SELECT 1 FROM items i WHERE i.source = e.source AND i.fetched_at >= :since
          )
        ORDER BY e.source
        """,
        {"since": since},
    ).fetchall()
    return [r["source"] for r in rows]


def _also_map(conn: sqlite3.Connection) -> dict[str, list[str]]:
    rows = conn.execute(
        "SELECT cluster_id, source FROM items WHERE cluster_id != id ORDER BY source"
    ).fetchall()
    also: dict[str, list[str]] = {}
    for r in rows:
        also.setdefault(r["cluster_id"], []).append(r["source"])
    return also


def render(conn: sqlite3.Connection, cap: int = 120) -> str:
    reps = conn.execute(
        "SELECT * FROM items WHERE read_at IS NULL AND (cluster_id = id OR cluster_id IS NULL)"
        " ORDER BY published_at DESC"
    ).fetchall()
    also = _also_map(conn)
    lines = [f"# jamasp inbox {utcnow()} — {len(reps)} unread"]
    for src in dead_sources(conn):
        lines.append(f"# WARNING: source '{src}' failing for 24h+ — coverage gap")
    for r in reps[:cap]:
        obj = {
            "id": r["id"],
            "t": r["published_at"],
            "src": r["source"],
            "head": r["headline"],
            "topic": r["topic"],
            "url": r["url"],
        }
        if r["lede"]:
            obj["lede"] = r["lede"]
        if r["id"] in also:
            obj["also"] = also[r["id"]]
        lines.append(json.dumps(obj, ensure_ascii=False))
    if len(reps) > cap:
        overflow = Counter(r["topic"] for r in reps[cap:])
        lines.append(
            f"# +{len(reps) - cap} more unread: {json.dumps(dict(overflow), sort_keys=True)}"
        )
    return "\n".join(lines)


def mark_read(conn: sqlite3.Connection) -> int:
    cur = conn.execute(
        "UPDATE items SET read_at = ? WHERE read_at IS NULL", (utcnow(),)
    )
    conn.commit()
    return cur.rowcount
```

- [ ] **Step 4: Run tests, expect pass**

Run: `uv run pytest tests/test_inbox.py -v`
Expected: 4 PASSED

- [ ] **Step 5: Commit**

```bash
git add jamasp/inbox.py tests/test_inbox.py
git commit -m "feat: capped jsonl inbox with cluster folding and dead-source warnings"
```

---

### Task 9: Article extraction with cache

**Files:**
- Create: `jamasp/extract.py`, `tests/test_extract.py`

**Interfaces:**
- Consumes: `extract_cache` table; settings `extract_max_chars`; `trafilatura.extract`
- Produces: `extract.extract_url(conn, url: str, max_chars: int = 16000, fetch=None) -> str` — returns cached text if present; otherwise fetches HTML (via `fetch(url) -> str`, default httpx GET), runs trafilatura, truncates to `max_chars` with a `\n[truncated]` suffix, caches, returns. Raises `ValueError` if extraction yields nothing.

- [ ] **Step 1: Write failing tests**

`tests/test_extract.py`:
```python
import pytest

from jamasp import db, extract

HTML = (
    "<html><body><nav>menu menu</nav><article><p>"
    + "Gold rallied two percent after the CPI miss. " * 40
    + "</p></article></body></html>"
)


def test_extract_strips_and_truncates(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    calls = []

    def fake_fetch(url):
        calls.append(url)
        return HTML

    text = extract.extract_url(conn, "https://e/a", max_chars=200, fetch=fake_fetch)
    assert text.endswith("[truncated]")
    assert len(text) <= 200 + len("\n[truncated]")
    assert "menu menu" not in text
    assert "Gold rallied" in text


def test_extract_uses_cache(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    calls = []

    def fake_fetch(url):
        calls.append(url)
        return HTML

    a = extract.extract_url(conn, "https://e/a", max_chars=200, fetch=fake_fetch)
    b = extract.extract_url(conn, "https://e/a", max_chars=200, fetch=fake_fetch)
    assert a == b
    assert len(calls) == 1  # second call served from cache


def test_extract_empty_raises(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    with pytest.raises(ValueError):
        extract.extract_url(conn, "https://e/x", fetch=lambda u: "<html></html>")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_extract.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement extract.py**

```python
"""Readability extraction: the only path for web content into agent context."""
from __future__ import annotations

import sqlite3
from typing import Callable

import httpx
import trafilatura

from jamasp.db import utcnow


def _default_fetch(url: str) -> str:
    resp = httpx.get(url, follow_redirects=True, timeout=30)
    resp.raise_for_status()
    return resp.text


def extract_url(
    conn: sqlite3.Connection,
    url: str,
    max_chars: int = 16000,
    fetch: Callable[[str], str] | None = None,
) -> str:
    cached = conn.execute(
        "SELECT text FROM extract_cache WHERE url = ?", (url,)
    ).fetchone()
    if cached:
        return cached["text"]
    html = (fetch or _default_fetch)(url)
    text = trafilatura.extract(html, url=url)
    if not text:
        raise ValueError(f"could not extract article text from {url}")
    if len(text) > max_chars:
        text = text[:max_chars] + "\n[truncated]"
    conn.execute(
        "INSERT INTO extract_cache (url, fetched_at, text) VALUES (?, ?, ?)",
        (url, utcnow(), text),
    )
    conn.commit()
    return text
```

- [ ] **Step 4: Run tests, expect pass**

Run: `uv run pytest tests/test_extract.py -v`
Expected: 3 PASSED

- [ ] **Step 5: Commit**

```bash
git add jamasp/extract.py tests/test_extract.py
git commit -m "feat: cached trafilatura article extraction with truncation"
```

---

### Task 10: Telegram notify

**Files:**
- Create: `jamasp/notify.py`, `tests/test_notify.py`

**Interfaces:**
- Consumes: settings `telegram.bot_token_env` / `telegram.chat_id_env`; env vars
- Produces:
  - `notify.send_telegram(text: str, token: str, chat_id: str, post=None) -> None` — POSTs `https://api.telegram.org/bot{token}/sendMessage` with `{"chat_id", "text"}` (plain text, no parse_mode); `post(url, data)` injectable, default httpx; raises `RuntimeError` on non-ok response
  - `notify.notify(text: str, settings: dict, dry_run: bool = False, post=None) -> str` — resolves env vars; on `dry_run` returns `f"[dry-run] would send {len(text)} chars to chat {chat_id}"` without posting; raises `RuntimeError` with a clear message if env vars are missing

- [ ] **Step 1: Write failing tests**

`tests/test_notify.py`:
```python
import pytest

from jamasp import notify

SETTINGS = {"telegram": {"bot_token_env": "JAMASP_TG_TOKEN", "chat_id_env": "JAMASP_TG_CHAT"}}


def test_send_telegram_posts_to_bot_api():
    sent = {}

    def fake_post(url, data):
        sent["url"], sent["data"] = url, data
        return {"ok": True}

    notify.send_telegram("سلام gold brief", "TOK123", "-100", post=fake_post)
    assert sent["url"] == "https://api.telegram.org/botTOK123/sendMessage"
    assert sent["data"] == {"chat_id": "-100", "text": "سلام gold brief"}


def test_send_telegram_raises_on_api_error():
    with pytest.raises(RuntimeError):
        notify.send_telegram("x", "T", "C", post=lambda u, d: {"ok": False, "description": "bad"})


def test_notify_dry_run_skips_network(monkeypatch):
    monkeypatch.setenv("JAMASP_TG_TOKEN", "T")
    monkeypatch.setenv("JAMASP_TG_CHAT", "C")
    out = notify.notify("hello", SETTINGS, dry_run=True, post=None)
    assert out == "[dry-run] would send 5 chars to chat C"


def test_notify_missing_env_raises(monkeypatch):
    monkeypatch.delenv("JAMASP_TG_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="JAMASP_TG_TOKEN"):
        notify.notify("hello", SETTINGS)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_notify.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement notify.py**

```python
"""Telegram delivery via raw Bot API."""
from __future__ import annotations

import os
from typing import Callable

import httpx

Poster = Callable[[str, dict], dict]


def _default_post(url: str, data: dict) -> dict:
    resp = httpx.post(url, data=data, timeout=30)
    return resp.json()


def send_telegram(text: str, token: str, chat_id: str, post: Poster | None = None) -> None:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    result = (post or _default_post)(url, {"chat_id": chat_id, "text": text})
    if not result.get("ok"):
        raise RuntimeError(f"telegram send failed: {result.get('description', result)}")


def notify(
    text: str, settings: dict, dry_run: bool = False, post: Poster | None = None
) -> str:
    cfg = settings["telegram"]
    token = os.environ.get(cfg["bot_token_env"])
    chat_id = os.environ.get(cfg["chat_id_env"])
    if not token:
        raise RuntimeError(f"missing env var {cfg['bot_token_env']}")
    if not chat_id:
        raise RuntimeError(f"missing env var {cfg['chat_id_env']}")
    if dry_run:
        return f"[dry-run] would send {len(text)} chars to chat {chat_id}"
    send_telegram(text, token, chat_id, post=post)
    return f"sent {len(text)} chars to chat {chat_id}"
```

- [ ] **Step 4: Run tests, expect pass**

Run: `uv run pytest tests/test_notify.py -v`
Expected: 4 PASSED

- [ ] **Step 5: Commit**

```bash
git add jamasp/notify.py tests/test_notify.py
git commit -m "feat: telegram notify with dry-run and env-based secrets"
```

---

### Task 11: CLI wiring — ingest orchestration, inbox, extract, notify, sources check

**Files:**
- Create: `jamasp/cli.py`, `tests/test_cli.py`

**Interfaces:**
- Consumes: everything from Tasks 2–10
- Produces console commands (all accept `--db PATH` [default `state/jamasp.db`], `--config-dir PATH` [default `config/`]):
  - `jamasp ingest [--no-digest]` — for each source: rss → `fetch_source`+`store_items`, price_api → `fetch_price`+`store_price`; per-source errors go to `source_errors` and stderr, run continues; then `assign_clusters`; then `run_digest` unless `--no-digest`. Prints one summary line.
  - `jamasp inbox [--mark-read] [--cap N]` — prints `inbox.render`; with `--mark-read` marks and prints count instead
  - `jamasp extract URL` — prints extracted text
  - `jamasp notify [--dry-run] TEXT` (or `-` to read stdin) — sends via Telegram
  - `jamasp sources check` — fetches every source once, prints `OK <name> (N items)` / `FAIL <name>: <error>`; exits 0 always (informational)

- [ ] **Step 1: Write failing tests**

`tests/test_cli.py`:
```python
import json
from pathlib import Path

from click.testing import CliRunner

from jamasp import db
from jamasp.cli import main
from jamasp.ingest import rss
from jamasp.models import Item

FIXTURES = Path(__file__).parent / "fixtures"


def _write_configs(tmp_path, sources_yaml):
    cfg = tmp_path / "config"
    cfg.mkdir()
    (cfg / "sources.yaml").write_text(sources_yaml)
    (cfg / "settings.yaml").write_text(
        "timezone: Asia/Dubai\ninbox_cap: 120\nextract_max_chars: 16000\n"
        "digest:\n  claude_cmd: [\"/nonexistent\"]\n  batch_max_items: 60\n"
        "cluster:\n  similarity_threshold: 80\n  window_hours: 48\n"
        "telegram:\n  bot_token_env: JAMASP_TG_TOKEN\n  chat_id_env: JAMASP_TG_CHAT\n"
    )
    return cfg


def test_ingest_survives_dead_source_and_reports(tmp_path, monkeypatch):
    cfg = _write_configs(
        tmp_path,
        """
sources:
  - name: deadfeed
    type: rss
    url: http://127.0.0.1:1/rss
    interval_minutes: 15
    topic: markets
""",
    )
    dbp = tmp_path / "j.db"
    runner = CliRunner()
    result = runner.invoke(
        main, ["ingest", "--no-digest", "--db", str(dbp), "--config-dir", str(cfg)]
    )
    assert result.exit_code == 0
    conn = db.connect(dbp)
    errs = conn.execute("SELECT source FROM source_errors").fetchall()
    assert [e["source"] for e in errs] == ["deadfeed"]


def test_inbox_command_renders_and_marks(tmp_path):
    cfg = _write_configs(tmp_path, "sources: []\n")
    dbp = tmp_path / "j.db"
    conn = db.connect(dbp)
    it = Item(
        id=rss.item_id("s", "https://e/1", "Gold pops"),
        source="s", published_at="2026-07-30T10:00:00Z",
        headline="Gold pops", url="https://e/1", topic="gold",
    )
    rss.store_items(conn, [it])
    conn.execute("UPDATE items SET cluster_id = id")
    conn.commit()
    runner = CliRunner()
    out = runner.invoke(main, ["inbox", "--db", str(dbp), "--config-dir", str(cfg)])
    assert out.exit_code == 0
    line = [l for l in out.output.splitlines() if not l.startswith("#")][0]
    assert json.loads(line)["head"] == "Gold pops"
    marked = runner.invoke(
        main, ["inbox", "--mark-read", "--db", str(dbp), "--config-dir", str(cfg)]
    )
    assert "marked 1 items read" in marked.output


def test_notify_dry_run(tmp_path, monkeypatch):
    cfg = _write_configs(tmp_path, "sources: []\n")
    monkeypatch.setenv("JAMASP_TG_TOKEN", "T")
    monkeypatch.setenv("JAMASP_TG_CHAT", "C")
    runner = CliRunner()
    out = runner.invoke(
        main,
        ["notify", "--dry-run", "hello", "--db", str(tmp_path / "j.db"), "--config-dir", str(cfg)],
    )
    assert out.exit_code == 0
    assert "[dry-run] would send 5 chars" in out.output
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_cli.py -v`
Expected: FAIL with `ModuleNotFoundError` (no `jamasp.cli`)

- [ ] **Step 3: Implement cli.py**

```python
"""jamasp CLI — the agent's toolbox and the operator's ops tool."""
from __future__ import annotations

import sys
from pathlib import Path

import click
import httpx

from jamasp import cluster as cluster_mod
from jamasp import db as db_mod
from jamasp import digest as digest_mod
from jamasp import extract as extract_mod
from jamasp import inbox as inbox_mod
from jamasp import notify as notify_mod
from jamasp.config import load_settings, load_sources
from jamasp.ingest import prices as prices_mod
from jamasp.ingest import rss as rss_mod


def _common(db_path: str, config_dir: str):
    cfg = Path(config_dir)
    conn = db_mod.connect(Path(db_path))
    sources = load_sources(cfg / "sources.yaml")
    settings = load_settings(cfg / "settings.yaml")
    return conn, sources, settings


db_opt = click.option("--db", "db_path", default="state/jamasp.db", show_default=True)
cfg_opt = click.option("--config-dir", default="config", show_default=True)


@click.group()
def main():
    """Jamasp toolbox: deterministic ingestion + compact agent-facing views."""


@main.command()
@click.option("--no-digest", is_flag=True, help="skip the haiku lede pass")
@db_opt
@cfg_opt
def ingest(no_digest, db_path, config_dir):
    """Fetch all sources, dedupe, cluster, and (optionally) write ledes."""
    conn, sources, settings = _common(db_path, config_dir)
    new_items = prices_n = errors = 0
    with httpx.Client(headers={"User-Agent": "jamasp/0.1"}) as client:
        for source in sources:
            try:
                if source.type == "rss":
                    new_items += rss_mod.store_items(
                        conn, rss_mod.fetch_source(source, client)
                    )
                elif source.type == "price_api":
                    symbol, ts, value = prices_mod.fetch_price(source, client)
                    prices_mod.store_price(conn, symbol, ts, value)
                    prices_n += 1
            except Exception as exc:  # per-source isolation, by design
                errors += 1
                conn.execute(
                    "INSERT INTO source_errors (source, ts, error) VALUES (?, ?, ?)",
                    (source.name, db_mod.utcnow(), str(exc)[:500]),
                )
                conn.commit()
                click.echo(f"WARN {source.name}: {exc}", err=True)
    ccfg = settings["cluster"]
    joined = cluster_mod.assign_clusters(
        conn, ccfg["similarity_threshold"], ccfg["window_hours"]
    )
    ledes = 0 if no_digest else digest_mod.run_digest(conn, settings)
    click.echo(
        f"ingest: {new_items} new items ({joined} clustered), "
        f"{prices_n} price snapshots, {ledes} ledes, {errors} source errors"
    )


@main.command()
@click.option("--mark-read", is_flag=True)
@click.option("--cap", type=int, default=None)
@db_opt
@cfg_opt
def inbox(mark_read, cap, db_path, config_dir):
    """Print unread items as compact JSONL (the agent's news delta)."""
    conn, _, settings = _common(db_path, config_dir)
    if mark_read:
        click.echo(f"marked {inbox_mod.mark_read(conn)} items read")
        return
    click.echo(inbox_mod.render(conn, cap or settings["inbox_cap"]))


@main.command()
@click.argument("url")
@db_opt
@cfg_opt
def extract(url, db_path, config_dir):
    """Print readability-extracted article text (cached, truncated)."""
    conn, _, settings = _common(db_path, config_dir)
    click.echo(extract_mod.extract_url(conn, url, settings["extract_max_chars"]))


@main.command()
@click.argument("text")
@click.option("--dry-run", is_flag=True)
@db_opt
@cfg_opt
def notify(text, dry_run, db_path, config_dir):
    """Send TEXT (or '-' for stdin) to the Telegram chat."""
    _, _, settings = _common(db_path, config_dir)
    if text == "-":
        text = sys.stdin.read()
    click.echo(notify_mod.notify(text, settings, dry_run=dry_run))


@main.group()
def sources():
    """Source management."""


@sources.command("check")
@db_opt
@cfg_opt
def sources_check(db_path, config_dir):
    """Fetch every configured source once and report health."""
    _, source_list, _ = _common(db_path, config_dir)
    with httpx.Client(headers={"User-Agent": "jamasp/0.1"}) as client:
        for source in source_list:
            try:
                if source.type == "rss":
                    n = len(rss_mod.fetch_source(source, client))
                    click.echo(f"OK   {source.name} ({n} items)")
                elif source.type == "price_api":
                    symbol, ts, value = prices_mod.fetch_price(source, client)
                    click.echo(f"OK   {source.name} ({symbol}={value} @ {ts})")
            except Exception as exc:
                click.echo(f"FAIL {source.name}: {exc}")
```

- [ ] **Step 4: Run full suite, expect pass**

Run: `uv run pytest -v`
Expected: all tests pass (Tasks 1–11)

- [ ] **Step 5: Live-verify the starting feeds and fix sources.yaml**

Run: `uv run jamasp sources check`

For every `FAIL <name>` line: find the source's current RSS URL (check the site's /rss page) and update `config/sources.yaml`; if no working feed exists, delete the entry and note the gap in the commit message. Re-run until every remaining source prints `OK`. This step is expected to change `sources.yaml` — the URLs in Task 2 are best-effort.

- [ ] **Step 6: Commit**

```bash
git add jamasp/cli.py tests/test_cli.py config/sources.yaml
git commit -m "feat: jamasp CLI (ingest/inbox/extract/notify/sources-check), live-verified feeds"
```

---

### Task 12: `jamasp price` summary command

**Files:**
- Create: `jamasp/pricesummary.py`, `tests/test_pricesummary.py`
- Modify: `jamasp/cli.py` (add `price` command at the end of the file, before any `if __name__` block)

**Interfaces:**
- Consumes: `prices.latest`, `prices.value_at_or_before`, `prices` table
- Produces:
  - `pricesummary.render(conn, now: str | None = None) -> str` — one line per symbol in the DB: `XAUUSD 3412.55 (24h: +0.66%, 7d: n/a)`; deltas computed against `value_at_or_before(now - 24h)` and `(now - 7d)`; `n/a` when no old-enough snapshot; `now` injectable for tests, defaults to `db.utcnow()`
  - CLI: `jamasp price` prints it

- [ ] **Step 1: Write failing tests**

`tests/test_pricesummary.py`:
```python
from jamasp import db, pricesummary
from jamasp.ingest import prices


def test_render_with_deltas(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    prices.store_price(conn, "XAUUSD", "2026-07-29T08:00:00Z", 3390.0)
    prices.store_price(conn, "XAUUSD", "2026-07-30T08:00:00Z", 3412.55)
    out = pricesummary.render(conn, now="2026-07-30T09:00:00Z")
    assert "XAUUSD 3412.55" in out
    assert "24h: +0.67%" in out
    assert "7d: n/a" in out


def test_render_empty_db(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    assert pricesummary.render(conn) == "no price data"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_pricesummary.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Implement pricesummary.py**

```python
"""Compact price summary for agent briefs."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

from jamasp.db import utcnow
from jamasp.ingest import prices


def _shift(now: str, hours: int) -> str:
    dt = datetime.strptime(now, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    return (dt - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _delta(conn: sqlite3.Connection, symbol: str, current: float, ref_ts: str) -> str:
    old = prices.value_at_or_before(conn, symbol, ref_ts)
    if old is None or old == 0:
        return "n/a"
    pct = (current - old) / old * 100
    return f"{pct:+.2f}%"


def render(conn: sqlite3.Connection, now: str | None = None) -> str:
    now = now or utcnow()
    symbols = [
        r["symbol"]
        for r in conn.execute("SELECT DISTINCT symbol FROM prices ORDER BY symbol")
    ]
    if not symbols:
        return "no price data"
    lines = []
    for symbol in symbols:
        row = prices.latest(conn, symbol)
        value = row["value"]
        lines.append(
            f"{symbol} {value:g} "
            f"(24h: {_delta(conn, symbol, value, _shift(now, 24))}, "
            f"7d: {_delta(conn, symbol, value, _shift(now, 24 * 7))})"
        )
    return "\n".join(lines)
```

- [ ] **Step 4: Add the CLI command**

Append to `jamasp/cli.py`:
```python
from jamasp import pricesummary as pricesummary_mod  # noqa: E402  (add with other imports)


@main.command()
@db_opt
@cfg_opt
def price(db_path, config_dir):
    """Print latest snapshots with 24h/7d deltas."""
    conn, _, _ = _common(db_path, config_dir)
    click.echo(pricesummary_mod.render(conn))
```

(Put the import at the top of the file with the other `jamasp` imports.)

- [ ] **Step 5: Run full suite, expect pass**

Run: `uv run pytest -v`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add jamasp/pricesummary.py jamasp/cli.py tests/test_pricesummary.py
git commit -m "feat: jamasp price summary with 24h/7d deltas"
```

---

### Task 13: Agent layer — CLAUDE.md, /brief skill, seed state

**Files:**
- Create: `CLAUDE.md`, `.claude/skills/brief/SKILL.md`, `state/stance.md`, `state/watchlist.yaml`, `reports/.gitkeep`

**Interfaces:**
- Consumes: the `jamasp` CLI (Tasks 11–12) — the skill instructs the agent to call it
- Produces: the prompt layer that phase-1 manual runs (`claude -p "/brief"` from repo root) execute. No code interfaces.

- [ ] **Step 1: Write CLAUDE.md**

```markdown
# Jamasp — جاماسپ

You are Jamasp, the market analyst of a physical gold trading company based in
Dubai. Your job: read the news delta, understand what moves gold, and keep the
desk informed with grounded, opinionated, falsifiable analysis. You are named
for the sage-advisor of the Shahnameh: measured, far-sighted, never breathless.

## Hard rules

1. **Never fetch raw web pages into this session.** All news arrives through
   `jamasp` CLI commands. To read a full article use `jamasp extract <url>`
   — never WebFetch, never curl.
2. **Long documents go to subagents.** If extracted text exceeds ~2 pages,
   dispatch a subagent (Haiku or Sonnet, low effort) to read it and return
   conclusions only.
3. **Persian for Telegram, English for reports.** Telegram messages are
   concise Persian (numbers and tickers stay Latin); repo reports are English.
4. **Commit at the end of every run**: reports, state files, and
   `state/jamasp.db`, with message `jamasp: <run-type> <date>`.
5. **Keep state small.** `state/stance.md` must stay under one page; rewrite
   it, don't append.
6. **No trading instructions.** You advise on market conditions; humans
   decide trades. Frame advice as conditions + reasoning, not orders.

## Toolbox (run from repo root)

| Command | Purpose |
|---|---|
| `uv run jamasp inbox` | unread news delta (compact JSONL, pre-deduped) |
| `uv run jamasp inbox --mark-read` | close the delta at the END of a successful run |
| `uv run jamasp price` | latest gold/dollar/real-yield snapshots + deltas |
| `uv run jamasp extract <url>` | clean article text for a headline worth deep reading |
| `uv run jamasp notify [--dry-run] -` | send stdin text to the desk Telegram |
| `uv run jamasp ingest` | refresh sources (only if inbox seems stale) |

## State files

- `state/stance.md` — your current market view. Read at start, rewrite at end.
- `state/watchlist.yaml` — themes you're tracking, each with a `since` date.
- `reports/` — your published archive. Grep it for history; never bulk-load.
```

- [ ] **Step 2: Write the /brief skill**

`.claude/skills/brief/SKILL.md`:
```markdown
---
name: brief
description: Produce the daily Jamasp morning brief — read the news delta, analyze gold-market impact, publish the English report, send the Persian Telegram summary, update stance.
---

# Daily Brief

Work through these steps in order. Today's date in Dubai (UTC+4) determines
the report path: `reports/YYYY/MM/YYYY-MM-DD-brief.md`.

## 1. Load context (cheap, do all of it)

- Read `state/stance.md` and `state/watchlist.yaml`.
- Run `uv run jamasp ingest` (refresh), then `uv run jamasp price` and
  `uv run jamasp inbox`.

## 2. Analyze

- Identify the 3–7 developments since the last brief that actually matter for
  gold (rates, dollar, real yields, central-bank demand, geopolitics, physical
  flows). Ignore noise; the inbox is pre-deduped but not pre-ranked.
- For at most 2–3 items where the headline+lede is insufficient AND the impact
  is material, run `uv run jamasp extract <url>`; if the text is long,
  summarize via a subagent.
- Form a view: what changed versus `stance.md`? Be explicit when you are
  updating or contradicting yesterday's view, and say why.

## 3. Write the report (English)

Create `reports/YYYY/MM/YYYY-MM-DD-brief.md`:

    # Jamasp Brief — YYYY-MM-DD (Dubai)

    ## Market snapshot
    <output of `jamasp price`, one line of interpretation>

    ## What happened
    <3–7 bullets: development → mechanism → expected gold impact (direction + conviction)>

    ## Outlook
    <your stance for the coming days: base case, key risks, what would change your mind>

    ## Watching
    <upcoming events/data with dates (Dubai time), and watchlist changes>

## 4. Update state

- Rewrite `state/stance.md` (≤1 page: current view, key drivers, conviction).
- Add/remove `state/watchlist.yaml` entries (new themes get `since: <today>`).

## 5. Deliver

- Compose a Persian summary (≤12 lines: خلاصه بازار، مهم‌ترین رویدادها، چشم‌انداز)
  ending with the report path. Numbers/tickers stay Latin.
- Send it: pipe the summary text to `uv run jamasp notify -`.

## 6. Close out

- Run `uv run jamasp inbox --mark-read`.
- `git add reports/ state/ && git commit -m "jamasp: brief YYYY-MM-DD"`.
```

- [ ] **Step 3: Seed state files**

`state/stance.md`:
```markdown
# Stance — (not yet formed)

First brief pending. No inherited view: form the initial stance from the first
run's inbox and price data, and note that it is an initial, low-conviction take.
```

`state/watchlist.yaml`:
```yaml
watchlist:
  - theme: fed-rate-path
    why: dominant driver of real yields and hence gold
    since: 2026-07-31
  - theme: central-bank-gold-buying
    why: structural demand floor; watch monthly reserve reports
    since: 2026-07-31
```

`reports/.gitkeep`: empty file.

- [ ] **Step 4: Validate the skill loads**

Run: `claude -p "List your available skills. Do NOT run any of them." 2>&1 | head -20`
Expected: output mentions a `brief` skill. (If the skill is not listed, check `.claude/skills/brief/SKILL.md` frontmatter syntax.)

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md .claude/ state/ reports/.gitkeep
git commit -m "feat: jamasp persona, /brief skill, seed state"
```

---

### Task 14: E2E smoke run + README

**Files:**
- Create: `README.md`
- Modify: `config/sources.yaml` (only if the smoke run exposes broken feeds)

**Interfaces:**
- Consumes: everything
- Produces: a verified, documented daily-run procedure. This task spends real tokens and sends a real Telegram message — run it attended.

- [ ] **Step 1: Set up the Telegram bot (manual, with Saman)**

1. Create a bot via @BotFather → get token.
2. Add the bot to the desk chat (or DM it), get the chat id: send a message,
   then `curl "https://api.telegram.org/bot<TOKEN>/getUpdates"` → `chat.id`.
3. Export in the shell profile used for runs:
   `export JAMASP_TG_TOKEN=... JAMASP_TG_CHAT=...`
4. Verify: `uv run jamasp notify --dry-run "test"` then `uv run jamasp notify "سلام از جاماسپ 🜚"` — confirm it arrives.

- [ ] **Step 2: Real ingest + inbox sanity check**

Run: `uv run jamasp ingest && uv run jamasp inbox | head -30 && uv run jamasp price`
Expected: summary line with >0 new items and ≥1 price snapshot; inbox shows JSONL with ledes (haiku digest ran); price shows XAUUSD. Fix any failing source in `config/sources.yaml` before proceeding.

- [ ] **Step 3: First supervised /brief run**

Run: `claude "/brief"` (interactive, NOT `-p`, so Saman can watch and interrupt).
Expected: report file appears under `reports/2026/…`, `state/stance.md` rewritten, Persian summary lands in Telegram, run ends with a commit. Review the report quality together; note desired prompt adjustments and apply them to `.claude/skills/brief/SKILL.md` before the next run.

- [ ] **Step 4: Write README.md**

```markdown
# Jamasp — جاماسپ

Autonomous gold-market analyst for the desk. Spec:
`docs/superpowers/specs/2026-07-31-jamasp-design.md`.

## Setup

    uv sync
    export JAMASP_TG_TOKEN=<botfather token>
    export JAMASP_TG_CHAT=<chat id>

## Daily run (phase 1: manual, on the Mac)

    uv run jamasp ingest        # any time; safe to run repeatedly
    claude "/brief"             # the morning brief (Dubai morning)

Outputs: `reports/YYYY/MM/YYYY-MM-DD-brief.md` + Persian Telegram summary.

## Useful commands

    uv run jamasp inbox           # what the agent will see
    uv run jamasp price           # latest snapshots + deltas
    uv run jamasp sources check   # feed health
    uv run pytest                 # test suite

## Phase status

Phase 1 (MVP) — manual daily runs. Wakeup queue, /scan, /deepdive, retros,
VPS deployment: phase 2 (see spec roadmap).
```

- [ ] **Step 5: Full suite + commit**

Run: `uv run pytest -v`
Expected: all pass

```bash
git add README.md config/sources.yaml
git commit -m "docs: README + verified e2e daily-run procedure"
```

- [ ] **Step 6: Begin the acceptance week**

Run `/brief` each Dubai morning for a week (manually or via a temporary
`launchd`/cron entry on the Mac). Phase 1 exits when Saman judges a week of
briefs genuinely useful. Collect friction notes in `docs/phase1-notes.md` as
input to phase 2.

---

## Self-review (completed)

- **Spec coverage:** phase-1 scope rows all mapped: scaffold→T1, CLI ingest→T4/T5/T11, digest→T7, inbox→T8, extract→T9, price→T12, notify→T10, sources.yaml→T2/T11, /brief→T13, Telegram→T10/T14, manual runs→T14. Clustering (T6) and dead-source warnings (T8) implement the spec's ingestion-layer requirements. Out of phase-1 scope per spec: wakeups, /scan, /deepdive, dispatcher, watchdog, predictions/retros, positions.
- **Placeholder scan:** clean — every step has concrete code/commands; the two intentionally open steps (feed URL verification T11.5, prompt tuning T14.3) are real-world calibration steps with explicit procedures, not placeholders.
- **Type consistency:** `Item` fields, `Source` fields, `(symbol, ts, value)` tuples, and CLI option names cross-checked across tasks 2–12; `inbox.render`/`mark_read`/`dead_sources`, `prices.latest`/`value_at_or_before` signatures match their uses in T11/T12.
