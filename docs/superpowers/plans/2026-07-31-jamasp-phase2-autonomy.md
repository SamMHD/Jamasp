# Jamasp Phase 2 (Autonomy + VPS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jamasp schedules its own future work: a wakeup queue + dispatcher fire headless Claude runs (`/scan`, `/deepdive`, `/retro`) with retries, timeouts, and a daily safety cap; calendar ingestion feeds an events table; predictions are recorded and scored, closing the learning loop via daily micro-retro and weekly `/retro`; a watchdog makes downtime non-silent.

**Architecture:** All new autonomy machinery is deterministic Python in the existing `jamasp` CLI (new tables in `state/jamasp.db`, new commands `wakeup`, `calendar`, `predictions`, `run`, `dispatch`, `watchdog`). Agent behavior changes are markdown skills in `.claude/skills/`. systemd timers in `ops/systemd/` call only `jamasp` CLI commands — the CLI (runner) is the single wrapper around every `claude -p` invocation, so cap/retry/timeout/failure-notice logic lives in one tested place.

**Tech Stack:** Same as phase 1 — Python ≥3.12, uv, click, httpx, stdlib sqlite3, PyYAML, pytest. New external source: ForexFactory weekly calendar JSON (free, no key). No new Python dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-31-jamasp-design.md` — phase 2 scope (roadmap row 2). Phase 3 items (positions, source-quality learning, gated self-edits) are OUT: `/retro` notes them as future sections but no code supports them.
- All timestamps stored in UTC ISO-8601 (`YYYY-MM-DDTHH:MM:SSZ`); display timezone Asia/Dubai (UTC+4, no DST).
- `state/jamasp.db` stays committed to git; schema changes must be additive `CREATE TABLE IF NOT EXISTS` (the existing `db.connect()` runs `executescript(SCHEMA)` on every connect, which migrates existing DBs for free).
- Deterministic code never blocks on the agent: every `claude -p` subprocess has a hard timeout; every Telegram send from infra code is best-effort (wrapped, never raises out).
- Safety cap: `max_agent_runs_per_day` from `config/settings.yaml`; exceeding it defers the run AND sends a Telegram warning — never silent drops (spec §Scheduler).
- Failures are never silent: run failure after retries → Telegram notice; watchdog violations → Telegram notice.
- Python style (match phase 1): stdlib `sqlite3` + `sqlite3.Row`, dataclasses, type hints, sync httpx, module-per-concern, `click` CLI in `jamasp/cli.py` delegating to modules.
- Tests use `tmp_path` DBs/configs and `tests/fake_claude.py`-style stand-ins for the `claude` CLI; no test touches the network or real Telegram (use `notify(..., post=fake)` / dry-run).
- Skills stay consistent with `CLAUDE.md` hard rules: Persian for Telegram, English reports, commit at end of run, `stance.md` ≤ 1 page.

## File Structure (end state of phase 2)

```
jamasp/
├── wakeup.py            # NEW  wakeup queue over `wakeups` table
├── predictions.py       # NEW  predictions ledger over state/predictions.jsonl
├── runner.py            # NEW  wrapped `claude -p` execution: cap, timeout, retry, telegram
├── dispatch.py          # NEW  fire due wakeups through runner
├── watchdog.py          # NEW  health checks + telegram
├── calendarview.py      # NEW  render upcoming events for agent/operator
├── ingest/calendar.py   # NEW  ForexFactory JSON → events table
├── db.py                # MOD  + wakeups, events, agent_runs, meta tables
├── cli.py               # MOD  + wakeup/calendar/predictions/run/dispatch/watchdog commands
config/
├── settings.yaml        # MOD  + runs: (claude_cmd, cap, timeouts), predictions: price_symbol
├── sources.yaml         # MOD  + ff_calendar entry
state/
├── playbook.md          # NEW  seeded; /retro-only
├── lessons-inbox.md     # NEW  seeded empty
├── calendar.yaml        # NEW  agent-curated event notes
.claude/skills/
├── scan/SKILL.md        # NEW
├── deepdive/SKILL.md    # NEW
├── retro/SKILL.md       # NEW
├── brief/SKILL.md       # MOD  micro-retro, wakeups, calendar, predictions
├── deploy/SKILL.md      # MOD  new timers, ops/systemd reference
ops/systemd/             # NEW  6 timers + 6 services (templates)
```

---

### Task 1: Schema — wakeups, events, agent_runs, meta tables

**Files:**
- Modify: `jamasp/db.py`
- Test: `tests/test_db.py` (append)

**Interfaces:**
- Consumes: existing `db.connect(path) -> sqlite3.Connection`, `db.utcnow() -> str`.
- Produces: four new tables available on every connection —
  - `wakeups(id INTEGER PK AUTOINCREMENT, due_at TEXT, run_type TEXT, task TEXT, status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, created_at TEXT, fired_at TEXT)` — status ∈ pending|done|failed.
  - `events(id TEXT PK, source TEXT, title TEXT, country TEXT, impact TEXT, starts_at TEXT, fetched_at TEXT)`.
  - `agent_runs(id INTEGER PK AUTOINCREMENT, run_type TEXT, task TEXT, started_at TEXT, finished_at TEXT, exit_code INTEGER, status TEXT)` — status ∈ ok|failed|timeout|deferred.
  - `meta(key TEXT PK, value TEXT)` — infra heartbeats (e.g. `last_ingest_at`).
  - Helper: `db.set_meta(conn, key, value)` and `db.get_meta(conn, key) -> str | None`.

- [ ] **Step 1: Write the failing tests** — append to `tests/test_db.py`:

```python
def test_phase2_tables_exist(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    for table in ("wakeups", "events", "agent_runs", "meta"):
        assert conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone(), f"missing table {table}"


def test_phase2_schema_migrates_existing_db(tmp_path):
    # simulate a phase-1 db: connect (creates old+new tables), then drop new ones
    p = tmp_path / "j.db"
    conn = db.connect(p)
    conn.executescript("DROP TABLE wakeups; DROP TABLE events; DROP TABLE agent_runs; DROP TABLE meta;")
    conn.close()
    conn = db.connect(p)  # re-connect must recreate them
    assert conn.execute("SELECT COUNT(*) FROM wakeups").fetchone()[0] == 0


def test_meta_helpers(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    assert db.get_meta(conn, "last_ingest_at") is None
    db.set_meta(conn, "last_ingest_at", "2026-07-31T05:00:00Z")
    db.set_meta(conn, "last_ingest_at", "2026-07-31T05:15:00Z")  # upsert
    assert db.get_meta(conn, "last_ingest_at") == "2026-07-31T05:15:00Z"
```

Note: `tests/test_db.py` already does `from jamasp import db` (check its imports; if it imports names individually, add `from jamasp import db`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_db.py -v`
Expected: FAIL — `missing table wakeups` / `AttributeError: module 'jamasp.db' has no attribute 'get_meta'`.

- [ ] **Step 3: Implement** — in `jamasp/db.py`, append to the `SCHEMA` string (inside the triple-quoted literal, after `source_errors`):

```sql
CREATE TABLE IF NOT EXISTS wakeups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    due_at     TEXT NOT NULL,
    run_type   TEXT NOT NULL,
    task       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    fired_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_wakeups_status_due ON wakeups(status, due_at);
CREATE TABLE IF NOT EXISTS events (
    id         TEXT PRIMARY KEY,
    source     TEXT NOT NULL,
    title      TEXT NOT NULL,
    country    TEXT,
    impact     TEXT,
    starts_at  TEXT NOT NULL,
    fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_starts ON events(starts_at);
CREATE TABLE IF NOT EXISTS agent_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_type    TEXT NOT NULL,
    task        TEXT,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    exit_code   INTEGER,
    status      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

and add the helpers at module bottom:

```python
def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?)"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    conn.commit()


def get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_db.py -v`
Expected: all PASS (old tests too).

- [ ] **Step 5: Commit**

```bash
git add jamasp/db.py tests/test_db.py
git commit -m "feat(db): phase-2 tables — wakeups, events, agent_runs, meta"
```

---

### Task 2: Wakeup queue module + CLI

**Files:**
- Create: `jamasp/wakeup.py`, `tests/test_wakeup.py`
- Modify: `jamasp/cli.py`

**Interfaces:**
- Consumes: Task 1 `wakeups` table; `db.utcnow()`.
- Produces (used by Task 6 dispatcher and the skills):
  - `wakeup.add(conn, due_at: str, run_type: str, task: str) -> int` — validates `due_at` is `YYYY-MM-DDTHH:MM(:SS)Z` or `±HH:MM`-offset ISO (normalized to UTC `Z` form before storing) and `run_type ∈ {"deepdive", "scan", "brief", "retro"}`; raises `ValueError` otherwise; returns new row id.
  - `wakeup.list_open(conn) -> list[sqlite3.Row]` — pending, ordered by `due_at`.
  - `wakeup.due(conn, now: str | None = None) -> list[sqlite3.Row]` — pending with `due_at <= now` (default `utcnow()`), ordered by `due_at`.
  - `wakeup.record_attempt(conn, wakeup_id: int) -> int` — increments `attempts`, returns new count.
  - `wakeup.mark(conn, wakeup_id: int, status: str) -> None` — sets status (`done`/`failed`) + `fired_at = utcnow()`.
  - CLI: `jamasp wakeup add "<ISO>" <run_type> "<task>"`, `jamasp wakeup list`.

- [ ] **Step 1: Write the failing tests** — `tests/test_wakeup.py`:

```python
import pytest
from click.testing import CliRunner

from jamasp import db, wakeup
from jamasp.cli import main


def test_add_normalizes_and_lists(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    wid = wakeup.add(conn, "2026-08-01T18:30:00+04:00", "deepdive", "read FOMC minutes")
    rows = wakeup.list_open(conn)
    assert [r["id"] for r in rows] == [wid]
    assert rows[0]["due_at"] == "2026-08-01T14:30:00Z"  # normalized to UTC
    assert rows[0]["status"] == "pending"


def test_add_rejects_bad_input(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    with pytest.raises(ValueError):
        wakeup.add(conn, "tomorrow evening", "deepdive", "t")
    with pytest.raises(ValueError):
        wakeup.add(conn, "2026-08-01T18:30:00Z", "espresso", "t")


def test_due_and_lifecycle(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    early = wakeup.add(conn, "2026-08-01T06:00:00Z", "deepdive", "a")
    late = wakeup.add(conn, "2026-08-01T09:00:00Z", "scan", "b")
    d = wakeup.due(conn, now="2026-08-01T07:00:00Z")
    assert [r["id"] for r in d] == [early]
    assert wakeup.record_attempt(conn, early) == 1
    assert wakeup.record_attempt(conn, early) == 2
    wakeup.mark(conn, early, "done")
    assert wakeup.due(conn, now="2026-08-01T07:00:00Z") == []
    assert [r["id"] for r in wakeup.list_open(conn)] == [late]
    row = conn.execute("SELECT * FROM wakeups WHERE id = ?", (early,)).fetchone()
    assert row["status"] == "done" and row["fired_at"] is not None


def test_cli_wakeup_add_and_list(tmp_path):
    cfg = tmp_path / "config"
    cfg.mkdir()
    (cfg / "sources.yaml").write_text("sources: []\n")
    (cfg / "settings.yaml").write_text("timezone: Asia/Dubai\ninbox_cap: 120\n")
    dbp = tmp_path / "j.db"
    runner = CliRunner()
    out = runner.invoke(main, [
        "wakeup", "add", "2026-08-01T14:30:00Z", "deepdive",
        "read FOMC statement, compare to stance",
        "--db", str(dbp), "--config-dir", str(cfg),
    ])
    assert out.exit_code == 0 and "scheduled wakeup" in out.output
    lst = runner.invoke(main, ["wakeup", "list", "--db", str(dbp), "--config-dir", str(cfg)])
    assert "2026-08-01T14:30:00Z" in lst.output and "deepdive" in lst.output
    bad = runner.invoke(main, [
        "wakeup", "add", "whenever", "deepdive", "t",
        "--db", str(dbp), "--config-dir", str(cfg),
    ])
    assert bad.exit_code != 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_wakeup.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jamasp.wakeup'` (or ImportError).

- [ ] **Step 3: Implement `jamasp/wakeup.py`**

```python
"""Wakeup queue: the agent requests future runs; the dispatcher executes them."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

from jamasp.db import utcnow

RUN_TYPES = {"deepdive", "scan", "brief", "retro"}


def _normalize_due(due_at: str) -> str:
    try:
        dt = datetime.fromisoformat(due_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"due_at must be ISO-8601, got {due_at!r}") from exc
    if dt.tzinfo is None:
        raise ValueError(f"due_at must carry a timezone (Z or offset), got {due_at!r}")
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def add(conn: sqlite3.Connection, due_at: str, run_type: str, task: str) -> int:
    if run_type not in RUN_TYPES:
        raise ValueError(f"run_type must be one of {sorted(RUN_TYPES)}, got {run_type!r}")
    cur = conn.execute(
        "INSERT INTO wakeups (due_at, run_type, task, created_at) VALUES (?, ?, ?, ?)",
        (_normalize_due(due_at), run_type, task, utcnow()),
    )
    conn.commit()
    return cur.lastrowid


def list_open(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM wakeups WHERE status = 'pending' ORDER BY due_at"
    ).fetchall()


def due(conn: sqlite3.Connection, now: str | None = None) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM wakeups WHERE status = 'pending' AND due_at <= ? ORDER BY due_at",
        (now or utcnow(),),
    ).fetchall()


def record_attempt(conn: sqlite3.Connection, wakeup_id: int) -> int:
    conn.execute(
        "UPDATE wakeups SET attempts = attempts + 1 WHERE id = ?", (wakeup_id,)
    )
    conn.commit()
    row = conn.execute(
        "SELECT attempts FROM wakeups WHERE id = ?", (wakeup_id,)
    ).fetchone()
    return row["attempts"]


def mark(conn: sqlite3.Connection, wakeup_id: int, status: str) -> None:
    conn.execute(
        "UPDATE wakeups SET status = ?, fired_at = ? WHERE id = ?",
        (status, utcnow(), wakeup_id),
    )
    conn.commit()
```

- [ ] **Step 4: Add the CLI group** — in `jamasp/cli.py`, import `from jamasp import wakeup as wakeup_mod` and add after the `sources` group:

```python
@main.group("wakeup")
def wakeup_group():
    """Wakeup queue: schedule future agent runs."""


@wakeup_group.command("add")
@click.argument("due_at")
@click.argument("run_type")
@click.argument("task")
@db_opt
@cfg_opt
def wakeup_add(due_at, run_type, task, db_path, config_dir):
    """Schedule RUN_TYPE at DUE_AT (ISO-8601 with timezone) carrying TASK text."""
    conn, _, _ = _common(db_path, config_dir)
    try:
        wid = wakeup_mod.add(conn, due_at, run_type, task)
    except ValueError as exc:
        raise click.BadParameter(str(exc))
    row = conn.execute("SELECT due_at FROM wakeups WHERE id = ?", (wid,)).fetchone()
    click.echo(f"scheduled wakeup #{wid}: {run_type} at {row['due_at']}")


@wakeup_group.command("list")
@db_opt
@cfg_opt
def wakeup_list(db_path, config_dir):
    """List pending wakeups, soonest first."""
    conn, _, _ = _common(db_path, config_dir)
    rows = wakeup_mod.list_open(conn)
    if not rows:
        click.echo("no pending wakeups")
        return
    for r in rows:
        click.echo(f"#{r['id']}  {r['due_at']}  {r['run_type']}  attempts={r['attempts']}  {r['task']}")
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_wakeup.py -v`
Expected: 4 PASS.

- [ ] **Step 6: Commit**

```bash
git add jamasp/wakeup.py jamasp/cli.py tests/test_wakeup.py
git commit -m "feat(wakeup): wakeup queue module + CLI add/list"
```

---

### Task 3: Calendar ingestion (events table) + `jamasp calendar` view

**Files:**
- Create: `jamasp/ingest/calendar.py`, `jamasp/calendarview.py`, `tests/test_calendar.py`
- Modify: `jamasp/cli.py` (ingest loop + `calendar` command), `config/sources.yaml`

**Interfaces:**
- Consumes: Task 1 `events` table; `Source` dataclass (type `"calendar"`, parser `"ff_json"`); `net.get_with_fallback`.
- Produces:
  - `ingest.calendar.parse_ff_json(source: Source, text: str) -> list[dict]` — dicts with keys `id, source, title, country, impact, starts_at` (UTC).
  - `ingest.calendar.fetch_source(source: Source, client: httpx.Client) -> list[dict]`.
  - `ingest.calendar.store_events(conn, events: list[dict]) -> int` — INSERT OR IGNORE, returns inserted count.
  - `calendarview.render(conn, days: int = 14, now: str | None = None) -> str` — upcoming events as JSONL (`{"t_utc", "t_dubai", "title", "country", "impact"}`), header line with count; only impact High/Medium shown by default (`impact_min` param).
  - CLI: `jamasp calendar [--days N] [--all-impacts]`.
- ForexFactory weekly calendar JSON (`https://nfs.faireconomy.media/ff_calendar_thisweek.json`) is a list of objects like `{"title": "CPI y/y", "country": "USD", "date": "2026-08-12T08:30:00-04:00", "impact": "High", "forecast": "...", "previous": "..."}`.

- [ ] **Step 1: Write the failing tests** — `tests/test_calendar.py`:

```python
import json

from jamasp import calendarview, db
from jamasp.config import Source
from jamasp.ingest import calendar as cal

SRC = Source(name="ff_calendar", type="calendar",
             url="https://x/ff.json", interval_minutes=360,
             topic="macro", parser="ff_json")

FF_JSON = json.dumps([
    {"title": "CPI y/y", "country": "USD", "date": "2026-08-12T08:30:00-04:00",
     "impact": "High", "forecast": "3.1%", "previous": "3.0%"},
    {"title": "Bank Holiday", "country": "FRF", "date": "2026-08-15T00:00:00-04:00",
     "impact": "Holiday", "forecast": "", "previous": ""},
])


def test_parse_ff_json_normalizes_to_utc():
    events = cal.parse_ff_json(SRC, FF_JSON)
    assert len(events) == 2
    e = events[0]
    assert e["title"] == "CPI y/y" and e["country"] == "USD"
    assert e["starts_at"] == "2026-08-12T12:30:00Z"
    assert e["source"] == "ff_calendar" and len(e["id"]) == 16


def test_store_events_dedupes(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    events = cal.parse_ff_json(SRC, FF_JSON)
    assert cal.store_events(conn, events) == 2
    assert cal.store_events(conn, events) == 0  # same week refetched


def test_calendar_render_filters_and_localizes(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    cal.store_events(conn, cal.parse_ff_json(SRC, FF_JSON))
    out = calendarview.render(conn, days=14, now="2026-08-10T00:00:00Z")
    lines = [l for l in out.splitlines() if not l.startswith("#")]
    assert len(lines) == 1  # Holiday impact filtered out
    obj = json.loads(lines[0])
    assert obj["t_dubai"] == "2026-08-12 16:30"  # UTC+4
    assert obj["impact"] == "High"
    all_out = calendarview.render(conn, days=14, now="2026-08-10T00:00:00Z",
                                  impact_min="all")
    assert len([l for l in all_out.splitlines() if not l.startswith("#")]) == 2


def test_calendar_render_window(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    cal.store_events(conn, cal.parse_ff_json(SRC, FF_JSON))
    out = calendarview.render(conn, days=1, now="2026-08-10T00:00:00Z")
    assert len([l for l in out.splitlines() if not l.startswith("#")]) == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_calendar.py -v`
Expected: FAIL — `ImportError` on `jamasp.ingest.calendar` / `jamasp.calendarview`.

- [ ] **Step 3: Implement `jamasp/ingest/calendar.py`**

```python
"""Economic-calendar ingestion: ForexFactory weekly JSON -> events table."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone

import httpx

from jamasp.config import Source
from jamasp.db import utcnow
from jamasp.net import get_with_fallback


def _event_id(source_name: str, title: str, starts_at: str) -> str:
    raw = f"{source_name}|{title}|{starts_at}".encode()
    return hashlib.sha256(raw).hexdigest()[:16]


def parse_ff_json(source: Source, text: str) -> list[dict]:
    events = []
    for row in json.loads(text):
        title = (row.get("title") or "").strip()
        date = (row.get("date") or "").strip()
        if not title or not date:
            continue
        dt = datetime.fromisoformat(date)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        starts_at = dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        events.append({
            "id": _event_id(source.name, title, starts_at),
            "source": source.name,
            "title": title,
            "country": (row.get("country") or "").strip(),
            "impact": (row.get("impact") or "").strip(),
            "starts_at": starts_at,
        })
    return events


PARSERS = {"ff_json": parse_ff_json}


def fetch_source(source: Source, client: httpx.Client) -> list[dict]:
    resp = get_with_fallback(source.url, client)
    return PARSERS[source.parser](source, resp.text)


def store_events(conn: sqlite3.Connection, events: list[dict]) -> int:
    now = utcnow()
    inserted = 0
    for e in events:
        cur = conn.execute(
            "INSERT OR IGNORE INTO events (id, source, title, country, impact, starts_at, fetched_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (e["id"], e["source"], e["title"], e["country"], e["impact"], e["starts_at"], now),
        )
        inserted += cur.rowcount
    conn.commit()
    return inserted
```

- [ ] **Step 4: Implement `jamasp/calendarview.py`**

```python
"""Compact upcoming-events view for agent runs and the operator."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone

from jamasp.db import utcnow

DUBAI = timezone(timedelta(hours=4))
DEFAULT_IMPACTS = ("High", "Medium")


def render(
    conn: sqlite3.Connection,
    days: int = 14,
    now: str | None = None,
    impact_min: str = "default",
) -> str:
    start = now or utcnow()
    end_dt = datetime.fromisoformat(start.replace("Z", "+00:00")) + timedelta(days=days)
    end = end_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = conn.execute(
        "SELECT * FROM events WHERE starts_at >= ? AND starts_at < ? ORDER BY starts_at",
        (start, end),
    ).fetchall()
    if impact_min != "all":
        rows = [r for r in rows if r["impact"] in DEFAULT_IMPACTS]
    lines = [f"# jamasp calendar — {len(rows)} events next {days}d (times: UTC + Dubai)"]
    for r in rows:
        dt = datetime.fromisoformat(r["starts_at"].replace("Z", "+00:00"))
        lines.append(json.dumps({
            "t_utc": r["starts_at"],
            "t_dubai": dt.astimezone(DUBAI).strftime("%Y-%m-%d %H:%M"),
            "title": r["title"],
            "country": r["country"],
            "impact": r["impact"],
        }, ensure_ascii=False))
    return "\n".join(lines)
```

- [ ] **Step 5: Wire into the CLI** — in `jamasp/cli.py`:
  - imports: `from jamasp import calendarview as calendarview_mod` and `from jamasp.ingest import calendar as calendar_mod`.
  - inside the `ingest` command's source loop, add a branch alongside `rss`/`price_api`:

```python
                elif source.type == "calendar":
                    events_n += calendar_mod.store_events(
                        conn, calendar_mod.fetch_source(source, client)
                    )
```

  (initialize `events_n = 0` next to the other counters and extend the summary line: `f"... {events_n} events, ..."`.)
  - after the loop (still inside `ingest`, before the final `click.echo`), record the heartbeat for the watchdog: `db_mod.set_meta(conn, "last_ingest_at", db_mod.utcnow())`.
  - also extend `sources check` with the same `elif source.type == "calendar":` branch printing `OK   {source.name} ({n} events)`.
  - new command:

```python
@main.command()
@click.option("--days", type=int, default=14, show_default=True)
@click.option("--all-impacts", is_flag=True, help="include Low/Holiday impact rows")
@db_opt
@cfg_opt
def calendar(days, all_impacts, db_path, config_dir):
    """Print upcoming economic-calendar events (JSONL, UTC + Dubai times)."""
    conn, _, _ = _common(db_path, config_dir)
    click.echo(calendarview_mod.render(
        conn, days=days, impact_min="all" if all_impacts else "default"
    ))
```

- [ ] **Step 6: Add the source** — append to `config/sources.yaml` under `sources:`:

```yaml
  # --- calendars ---
  # ff_calendar: ForexFactory weekly economic calendar mirror (faireconomy
  # media CDN), free JSON, no key. Gives CPI/NFP/FOMC-class events with
  # impact ratings. Refreshed 4x/day; whole-week payload, dedupe by
  # (source, title, starts_at) hash.
  - name: ff_calendar
    type: calendar
    url: "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
    interval_minutes: 360
    topic: macro
    parser: ff_json
```

- [ ] **Step 7: Run tests + live smoke check**

Run: `uv run pytest tests/test_calendar.py tests/test_cli.py -v`
Expected: PASS.
Run: `uv run jamasp sources check` (network) — `ff_calendar` should print `OK` with a nonzero event count. If the endpoint 403s or the JSON shape differs from the fixture, do NOT guess at an alternative feed — stop and flag it to Saman (the XML variant at the same CDN is not a drop-in replacement).
Run: `uv run jamasp ingest --no-digest && uv run jamasp calendar`
Expected: upcoming week's high/medium-impact events with Dubai times.

- [ ] **Step 8: Commit**

```bash
git add jamasp/ingest/calendar.py jamasp/calendarview.py jamasp/cli.py config/sources.yaml tests/test_calendar.py
git commit -m "feat(calendar): ForexFactory calendar ingestion + jamasp calendar view"
```

---

### Task 4: Predictions ledger + scoring helpers

**Files:**
- Create: `jamasp/predictions.py`, `tests/test_predictions.py`
- Modify: `jamasp/cli.py`, `config/settings.yaml`

**Interfaces:**
- Consumes: `state/predictions.jsonl` (created on first add); `prices` table via `ingest.prices.row_at_or_before` / `latest` (symbol `GC` — Yahoo `GC=F` is stored with the `=F` suffix stripped); settings key `predictions.price_symbol`.
- Produces:
  - Prediction JSONL schema (one object per line): `{"id": str8, "date": "YYYY-MM-DD", "claim": str, "direction": "up"|"down"|"flat", "horizon_days": int, "confidence": float, "created_at": iso, "outcome": null|"hit"|"miss"|"unclear", "scored_at": null|iso, "note": null|str}`.
  - `predictions.add(path, claim, direction, horizon_days, confidence, now=None) -> dict` — appends line, returns entry; `id` = sha256 of `created_at|claim` first 8 hex chars; `date` derived from `now` in Dubai time.
  - `predictions.load(path) -> list[dict]`.
  - `predictions.due(path, now=None) -> list[dict]` — unscored entries whose `created_at + horizon_days` ≤ now.
  - `predictions.score(path, pred_id, outcome, note=None, now=None) -> dict` — rewrites the file with outcome/scored_at/note set; raises `KeyError` on unknown id, `ValueError` on already-scored or bad outcome.
  - `predictions.render_due(conn, path, symbol, now=None) -> str` — JSONL of due entries, each annotated with `price_then` / `price_now` / `move_pct` from local price history (nulls if history missing).
  - CLI: `jamasp predictions add|list|due|score`.

- [ ] **Step 1: Write the failing tests** — `tests/test_predictions.py`:

```python
import json

import pytest

from jamasp import db, predictions
from jamasp.ingest import prices


def test_add_and_load(tmp_path):
    p = tmp_path / "predictions.jsonl"
    e = predictions.add(p, "gold breaks 2500 on CPI miss", "up", 3, 0.7,
                        now="2026-07-31T05:00:00Z")
    assert e["date"] == "2026-07-31" and e["direction"] == "up"
    assert e["outcome"] is None and len(e["id"]) == 8
    assert predictions.load(p) == [e]


def test_add_validates(tmp_path):
    p = tmp_path / "p.jsonl"
    with pytest.raises(ValueError):
        predictions.add(p, "c", "sideways-ish", 3, 0.7)
    with pytest.raises(ValueError):
        predictions.add(p, "c", "up", 3, 1.7)


def test_due_only_matured_unscored(tmp_path):
    p = tmp_path / "p.jsonl"
    old = predictions.add(p, "matured", "up", 2, 0.6, now="2026-07-28T05:00:00Z")
    predictions.add(p, "fresh", "down", 7, 0.5, now="2026-07-30T05:00:00Z")
    d = predictions.due(p, now="2026-07-31T05:00:00Z")
    assert [x["claim"] for x in d] == ["matured"]
    predictions.score(p, old["id"], "hit", note="CPI missed, gold +1.8%",
                      now="2026-07-31T06:00:00Z")
    assert predictions.due(p, now="2026-07-31T05:00:00Z") == []
    scored = [e for e in predictions.load(p) if e["id"] == old["id"]][0]
    assert scored["outcome"] == "hit" and scored["scored_at"] is not None


def test_score_errors(tmp_path):
    p = tmp_path / "p.jsonl"
    e = predictions.add(p, "c", "up", 1, 0.5, now="2026-07-28T05:00:00Z")
    with pytest.raises(KeyError):
        predictions.score(p, "nope1234", "hit")
    with pytest.raises(ValueError):
        predictions.score(p, e["id"], "sorta")
    predictions.score(p, e["id"], "miss")
    with pytest.raises(ValueError):
        predictions.score(p, e["id"], "hit")  # already scored


def test_render_due_annotates_price_move(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    prices.store_price(conn, "GC", "2026-07-28T05:00:00Z", 2400.0)
    prices.store_price(conn, "GC", "2026-07-31T04:00:00Z", 2448.0)
    p = tmp_path / "p.jsonl"
    predictions.add(p, "gold up on CPI", "up", 2, 0.6, now="2026-07-28T05:00:00Z")
    out = predictions.render_due(conn, p, "GC", now="2026-07-31T05:00:00Z")
    lines = [l for l in out.splitlines() if not l.startswith("#")]
    obj = json.loads(lines[0])
    assert obj["price_then"] == 2400.0 and obj["price_now"] == 2448.0
    assert obj["move_pct"] == 2.0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_predictions.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jamasp.predictions'`.

- [ ] **Step 3: Implement `jamasp/predictions.py`**

```python
"""Structured, scoreable forecasts in state/predictions.jsonl."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from jamasp.db import utcnow
from jamasp.ingest import prices

DIRECTIONS = {"up", "down", "flat"}
OUTCOMES = {"hit", "miss", "unclear"}
DUBAI = timezone(timedelta(hours=4))


def load(path: Path) -> list[dict]:
    if not Path(path).exists():
        return []
    return [json.loads(l) for l in Path(path).read_text().splitlines() if l.strip()]


def _dump(path: Path, entries: list[dict]) -> None:
    Path(path).write_text(
        "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in entries)
    )


def add(
    path: Path,
    claim: str,
    direction: str,
    horizon_days: int,
    confidence: float,
    now: str | None = None,
) -> dict:
    if direction not in DIRECTIONS:
        raise ValueError(f"direction must be one of {sorted(DIRECTIONS)}")
    if not 0.0 <= confidence <= 1.0:
        raise ValueError("confidence must be in [0, 1]")
    if horizon_days < 1:
        raise ValueError("horizon_days must be >= 1")
    created_at = now or utcnow()
    dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    entry = {
        "id": hashlib.sha256(f"{created_at}|{claim}".encode()).hexdigest()[:8],
        "date": dt.astimezone(DUBAI).strftime("%Y-%m-%d"),
        "claim": claim,
        "direction": direction,
        "horizon_days": horizon_days,
        "confidence": confidence,
        "created_at": created_at,
        "outcome": None,
        "scored_at": None,
        "note": None,
    }
    entries = load(path)
    entries.append(entry)
    _dump(path, entries)
    return entry


def due(path: Path, now: str | None = None) -> list[dict]:
    now_dt = datetime.fromisoformat((now or utcnow()).replace("Z", "+00:00"))
    out = []
    for e in load(path):
        if e["outcome"] is not None:
            continue
        created = datetime.fromisoformat(e["created_at"].replace("Z", "+00:00"))
        if created + timedelta(days=e["horizon_days"]) <= now_dt:
            out.append(e)
    return out


def score(
    path: Path, pred_id: str, outcome: str, note: str | None = None, now: str | None = None
) -> dict:
    if outcome not in OUTCOMES:
        raise ValueError(f"outcome must be one of {sorted(OUTCOMES)}")
    entries = load(path)
    match = [e for e in entries if e["id"] == pred_id]
    if not match:
        raise KeyError(f"no prediction with id {pred_id}")
    entry = match[0]
    if entry["outcome"] is not None:
        raise ValueError(f"prediction {pred_id} already scored: {entry['outcome']}")
    entry.update(outcome=outcome, scored_at=now or utcnow(), note=note)
    _dump(path, entries)
    return entry


def render_due(
    conn: sqlite3.Connection, path: Path, symbol: str, now: str | None = None
) -> str:
    now_ts = now or utcnow()
    entries = due(path, now=now_ts)
    lines = [f"# jamasp predictions due — {len(entries)} matured, unscored"]
    for e in entries:
        then = prices.row_at_or_before(conn, symbol, e["created_at"])
        latest_row = prices.row_at_or_before(conn, symbol, now_ts)
        annotated = dict(e)
        annotated["price_then"] = then["value"] if then else None
        annotated["price_now"] = latest_row["value"] if latest_row else None
        if then and latest_row and then["value"]:
            annotated["move_pct"] = round(
                (latest_row["value"] - then["value"]) / then["value"] * 100, 2
            )
        else:
            annotated["move_pct"] = None
        lines.append(json.dumps(annotated, ensure_ascii=False))
    return "\n".join(lines)
```

- [ ] **Step 4: Wire into the CLI** — in `jamasp/cli.py`, import `from jamasp import predictions as predictions_mod` plus `from pathlib import Path` (already imported) and add:

```python
pred_path_opt = click.option(
    "--path", "pred_path", default="state/predictions.jsonl", show_default=True
)


@main.group("predictions")
def predictions_group():
    """Structured forecast ledger (add, list, due, score)."""


@predictions_group.command("add")
@click.argument("claim")
@click.option("--direction", type=click.Choice(["up", "down", "flat"]), required=True)
@click.option("--horizon-days", type=int, required=True)
@click.option("--confidence", type=float, required=True)
@pred_path_opt
@db_opt
@cfg_opt
def predictions_add(claim, direction, horizon_days, confidence, pred_path, db_path, config_dir):
    """Record a falsifiable claim with direction, horizon, and confidence."""
    try:
        e = predictions_mod.add(Path(pred_path), claim, direction, horizon_days, confidence)
    except ValueError as exc:
        raise click.BadParameter(str(exc))
    click.echo(f"recorded prediction {e['id']}: {claim}")


@predictions_group.command("list")
@pred_path_opt
@db_opt
@cfg_opt
def predictions_list(pred_path, db_path, config_dir):
    """Print every ledger entry as JSONL."""
    for e in predictions_mod.load(Path(pred_path)):
        click.echo(json.dumps(e, ensure_ascii=False))


@predictions_group.command("due")
@pred_path_opt
@db_opt
@cfg_opt
def predictions_due(pred_path, db_path, config_dir):
    """Matured, unscored predictions annotated with the actual price move."""
    conn, _, settings = _common(db_path, config_dir)
    symbol = settings.get("predictions", {}).get("price_symbol", "GC")
    click.echo(predictions_mod.render_due(conn, Path(pred_path), symbol))


@predictions_group.command("score")
@click.argument("pred_id")
@click.option("--outcome", type=click.Choice(["hit", "miss", "unclear"]), required=True)
@click.option("--note", default=None)
@pred_path_opt
@db_opt
@cfg_opt
def predictions_score(pred_id, outcome, note, pred_path, db_path, config_dir):
    """Mark a matured prediction hit/miss/unclear (with a why note)."""
    try:
        e = predictions_mod.score(Path(pred_path), pred_id, outcome, note=note)
    except (KeyError, ValueError) as exc:
        raise click.ClickException(str(exc))
    click.echo(f"scored {e['id']} {outcome}: {e['claim']}")
```

(add `import json` to `cli.py` if not present.)

- [ ] **Step 5: Add settings** — in `config/settings.yaml` append:

```yaml
predictions:
  price_symbol: GC
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `uv run pytest tests/test_predictions.py tests/test_cli.py -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add jamasp/predictions.py jamasp/cli.py config/settings.yaml tests/test_predictions.py
git commit -m "feat(predictions): jsonl forecast ledger with price-annotated scoring"
```

---

### Task 5: Runner — the single wrapper around `claude -p`

**Files:**
- Create: `jamasp/runner.py`, `tests/test_runner.py`, `tests/fake_agent.py`
- Modify: `jamasp/cli.py`, `config/settings.yaml`

**Interfaces:**
- Consumes: Task 1 `agent_runs` table + `db.utcnow`; `notify.notify` (best-effort); settings block `runs:`.
- Produces (used by Task 6 dispatcher and the systemd units):
  - Settings block (added this task):

    ```yaml
    runs:
      claude_cmd: ["claude", "-p", "--dangerously-skip-permissions"]
      max_agent_runs_per_day: 20
      timeouts_seconds:
        brief: 900
        deepdive: 900
        scan: 300
        retro: 1200
    ```

  - `runner.runs_today(conn, now: str | None = None) -> int` — count of `agent_runs` rows whose `started_at` falls on the current *Dubai* date, excluding rows with status `deferred` (deferrals don't consume the cap).
  - `runner.run_agent(conn, settings, run_type: str, task: str | None = None, dry_run: bool = False) -> str` — returns final status: `"ok" | "failed" | "timeout" | "deferred"`. Behavior:
    1. If `runs_today >= max_agent_runs_per_day`: insert an `agent_runs` row with status `deferred`, send Telegram warning (best-effort), return `"deferred"`. Never executes claude.
    2. Builds prompt `f"/{run_type} {task}"` (or `f"/{run_type}"` when task is None) and runs `claude_cmd + [prompt]` with the per-type timeout, `cwd` = repo root (current dir).
    3. Nonzero exit or `TimeoutExpired` → one immediate retry; if the retry also fails → Telegram failure notice (best-effort) and status `failed`/`timeout`.
    4. Every execution records an `agent_runs` row (started_at, finished_at, exit_code, status).
    5. `dry_run=True` prints/returns without executing or recording: status `"ok"`.
  - `runner._notify_safe(settings, text) -> None` — wraps `notify.notify`, swallows every exception (infra must not die on Telegram hiccups).
  - CLI: `jamasp run <run_type> [TASK] [--dry-run]` — exit code 0 on `ok`/`deferred`(warned), 1 on `failed`/`timeout`.

- [ ] **Step 1: Write `tests/fake_agent.py`** — a controllable stand-in for `claude -p` (mirrors `tests/fake_claude.py` style):

```python
"""Stand-in for `claude -p` in runner tests.

argv[1] = mode: ok | fail | flaky | sleep
For `flaky`, a state file (argv[2]) makes the first call fail, later calls succeed.
The prompt is always the last argument.
"""
import pathlib
import sys
import time

mode = sys.argv[1]
if mode == "ok":
    print("ran fine")
    sys.exit(0)
if mode == "fail":
    print("boom", file=sys.stderr)
    sys.exit(1)
if mode == "flaky":
    marker = pathlib.Path(sys.argv[2])
    if marker.exists():
        print("recovered")
        sys.exit(0)
    marker.write_text("tried")
    sys.exit(1)
if mode == "sleep":
    time.sleep(5)
    sys.exit(0)
```

- [ ] **Step 2: Write the failing tests** — `tests/test_runner.py`:

```python
import sys
from pathlib import Path

from jamasp import db, runner

FAKE = str(Path(__file__).parent / "fake_agent.py")


def settings_with(cmd_tail, cap=20, scan_timeout=300):
    return {
        "runs": {
            "claude_cmd": [sys.executable, FAKE] + cmd_tail,
            "max_agent_runs_per_day": cap,
            "timeouts_seconds": {"brief": 900, "deepdive": 900,
                                 "scan": scan_timeout, "retro": 1200},
        },
        "telegram": {"bot_token_env": "JAMASP_TG_TOKEN", "chat_id_env": "JAMASP_TG_CHAT"},
    }


def test_ok_run_recorded(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    status = runner.run_agent(conn, settings_with(["ok"]), "scan")
    assert status == "ok"
    rows = conn.execute("SELECT * FROM agent_runs").fetchall()
    assert len(rows) == 1
    assert rows[0]["run_type"] == "scan" and rows[0]["status"] == "ok"
    assert rows[0]["exit_code"] == 0 and rows[0]["finished_at"] is not None


def test_retry_recovers_flaky(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    marker = tmp_path / "marker"
    status = runner.run_agent(
        conn, settings_with(["flaky", str(marker)]), "deepdive", task="read X"
    )
    assert status == "ok"


def test_persistent_failure_notifies(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(runner, "_notify_safe", lambda s, t: sent.append(t))
    conn = db.connect(tmp_path / "j.db")
    status = runner.run_agent(conn, settings_with(["fail"]), "scan")
    assert status == "failed"
    assert sent and "scan" in sent[0]
    row = conn.execute("SELECT status FROM agent_runs ORDER BY id DESC").fetchone()
    assert row["status"] == "failed"


def test_timeout_status(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "_notify_safe", lambda s, t: None)
    conn = db.connect(tmp_path / "j.db")
    status = runner.run_agent(conn, settings_with(["sleep"], scan_timeout=1), "scan")
    assert status == "timeout"


def test_cap_defers_and_warns(tmp_path, monkeypatch):
    sent = []
    monkeypatch.setattr(runner, "_notify_safe", lambda s, t: sent.append(t))
    conn = db.connect(tmp_path / "j.db")
    s = settings_with(["ok"], cap=1)
    assert runner.run_agent(conn, s, "scan") == "ok"
    assert runner.run_agent(conn, s, "scan") == "deferred"
    assert sent and "cap" in sent[-1].lower()
    statuses = [r["status"] for r in conn.execute("SELECT status FROM agent_runs")]
    assert statuses == ["ok", "deferred"]
    # deferred rows don't consume the cap themselves
    assert runner.runs_today(conn) == 1


def test_notify_safe_swallows(monkeypatch):
    # no telegram env vars set -> notify.notify raises; _notify_safe must not
    runner._notify_safe({"telegram": {"bot_token_env": "X_NOPE", "chat_id_env": "Y_NOPE"}}, "t")
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_runner.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jamasp.runner'`.

- [ ] **Step 4: Implement `jamasp/runner.py`**

```python
"""Wrapped `claude -p` execution: safety cap, timeout, one retry, telegram notice.

Every agent run — fixed timers and dispatched wakeups alike — goes through
run_agent(), so cap accounting and failure notices live in exactly one place.
"""
from __future__ import annotations

import sqlite3
import subprocess
from datetime import datetime, timedelta, timezone

from jamasp import notify as notify_mod
from jamasp.db import utcnow

DUBAI = timezone(timedelta(hours=4))


def _notify_safe(settings: dict, text: str) -> None:
    try:
        notify_mod.notify(text, settings)
    except Exception:
        pass  # infra never dies on a Telegram hiccup


def runs_today(conn: sqlite3.Connection, now: str | None = None) -> int:
    now_dt = datetime.fromisoformat((now or utcnow()).replace("Z", "+00:00"))
    today_dubai = now_dt.astimezone(DUBAI).strftime("%Y-%m-%d")
    n = 0
    for r in conn.execute(
        "SELECT started_at FROM agent_runs WHERE status != 'deferred'"
    ):
        started = datetime.fromisoformat(r["started_at"].replace("Z", "+00:00"))
        if started.astimezone(DUBAI).strftime("%Y-%m-%d") == today_dubai:
            n += 1
    return n


def _record(conn, run_type, task, started_at, exit_code, status) -> None:
    conn.execute(
        "INSERT INTO agent_runs (run_type, task, started_at, finished_at, exit_code, status)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (run_type, task, started_at, utcnow(), exit_code, status),
    )
    conn.commit()


def _execute_once(cmd: list[str], timeout: int) -> tuple[int | None, str]:
    """Run once; return (exit_code, status) where status is ok|failed|timeout."""
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except OSError:
        return None, "failed"
    return proc.returncode, "ok" if proc.returncode == 0 else "failed"


def run_agent(
    conn: sqlite3.Connection,
    settings: dict,
    run_type: str,
    task: str | None = None,
    dry_run: bool = False,
) -> str:
    cfg = settings["runs"]
    prompt = f"/{run_type} {task}" if task else f"/{run_type}"
    cmd = list(cfg["claude_cmd"]) + [prompt]
    if dry_run:
        return "ok"
    started_at = utcnow()
    cap = cfg["max_agent_runs_per_day"]
    if runs_today(conn) >= cap:
        _record(conn, run_type, task, started_at, None, "deferred")
        _notify_safe(
            settings,
            f"Jamasp: daily run cap ({cap}) reached — deferred {run_type} run."
            + (f" Task: {task}" if task else ""),
        )
        return "deferred"
    timeout = cfg["timeouts_seconds"][run_type]
    exit_code, status = _execute_once(cmd, timeout)
    if status != "ok":  # one retry, immediately
        exit_code, status = _execute_once(cmd, timeout)
    _record(conn, run_type, task, started_at, exit_code, status)
    if status != "ok":
        _notify_safe(
            settings,
            f"Jamasp FAILURE: {run_type} run {status} after retry"
            + (f" (task: {task})" if task else "")
            + f", exit={exit_code}.",
        )
    return status
```

- [ ] **Step 5: Add settings + CLI** — append to `config/settings.yaml`:

```yaml
runs:
  claude_cmd: ["claude", "-p", "--dangerously-skip-permissions"]
  max_agent_runs_per_day: 20
  timeouts_seconds:
    brief: 900
    deepdive: 900
    scan: 300
    retro: 1200
```

In `jamasp/cli.py`, import `from jamasp import runner as runner_mod` and add:

```python
@main.command("run")
@click.argument("run_type", type=click.Choice(["brief", "scan", "deepdive", "retro"]))
@click.argument("task", required=False, default=None)
@click.option("--dry-run", is_flag=True, help="print the command; don't execute or record")
@db_opt
@cfg_opt
def run_cmd(run_type, task, dry_run, db_path, config_dir):
    """Fire one wrapped agent run (cap, timeout, retry, failure notice)."""
    conn, _, settings = _common(db_path, config_dir)
    if dry_run:
        prompt = f"/{run_type} {task}" if task else f"/{run_type}"
        click.echo(f"[dry-run] would run: {' '.join(settings['runs']['claude_cmd'])} {prompt!r}")
        return
    status = runner_mod.run_agent(conn, settings, run_type, task=task)
    click.echo(f"{run_type}: {status}")
    if status in ("failed", "timeout"):
        raise SystemExit(1)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `uv run pytest tests/test_runner.py tests/test_cli.py -v`
Expected: PASS.
Also: `uv run jamasp run scan --dry-run` prints the claude command without executing.

- [ ] **Step 7: Commit**

```bash
git add jamasp/runner.py jamasp/cli.py config/settings.yaml tests/test_runner.py tests/fake_agent.py
git commit -m "feat(runner): wrapped claude -p execution with cap, timeout, retry, telegram"
```

---

### Task 6: Dispatcher — fire due wakeups

**Files:**
- Create: `jamasp/dispatch.py`, `tests/test_dispatch.py`
- Modify: `jamasp/cli.py`

**Interfaces:**
- Consumes: `wakeup.due/record_attempt/mark` (Task 2); `runner.run_agent` (Task 5); `runner._notify_safe`.
- Produces:
  - `dispatch.run_due(conn, settings, now: str | None = None, dry_run: bool = False) -> list[tuple[int, str]]` — for each due wakeup (in due_at order): increments attempts; if `run_agent` returns `ok` → `mark done`; if `deferred` → leave pending, **undo nothing** (the attempt counts; cap deferral notice already sent by runner) and stop processing further wakeups this tick (cap is hit — later ones would also defer); if failed/timeout and `attempts >= 2` → `mark failed` + Telegram notice; else leave pending for the next 5-min tick. Returns `[(wakeup_id, final_status_this_tick), ...]` where status ∈ ok|failed|timeout|deferred.
  - CLI: `jamasp dispatch [--dry-run]` — dry-run prints what would fire, fires nothing.

- [ ] **Step 1: Write the failing tests** — `tests/test_dispatch.py`:

```python
from click.testing import CliRunner

from jamasp import db, dispatch, runner, wakeup
from jamasp.cli import main

SETTINGS = {
    "runs": {"claude_cmd": ["true"], "max_agent_runs_per_day": 20,
             "timeouts_seconds": {"brief": 900, "deepdive": 900, "scan": 300, "retro": 1200}},
    "telegram": {"bot_token_env": "JAMASP_TG_TOKEN", "chat_id_env": "JAMASP_TG_CHAT"},
}


def test_fires_due_marks_done(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "j.db")
    wid = wakeup.add(conn, "2026-08-01T06:00:00Z", "deepdive", "read minutes")
    calls = []
    monkeypatch.setattr(
        dispatch.runner, "run_agent",
        lambda c, s, rt, task=None, dry_run=False: calls.append((rt, task)) or "ok",
    )
    results = dispatch.run_due(conn, SETTINGS, now="2026-08-01T07:00:00Z")
    assert results == [(wid, "ok")]
    assert calls == [("deepdive", "read minutes")]
    assert conn.execute("SELECT status FROM wakeups WHERE id=?", (wid,)).fetchone()["status"] == "done"


def test_failure_retries_next_tick_then_fails(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "j.db")
    wid = wakeup.add(conn, "2026-08-01T06:00:00Z", "deepdive", "t")
    sent = []
    monkeypatch.setattr(dispatch.runner, "run_agent",
                        lambda c, s, rt, task=None, dry_run=False: "failed")
    monkeypatch.setattr(dispatch.runner, "_notify_safe", lambda s, t: sent.append(t))
    # tick 1: attempt 1 -> stays pending
    assert dispatch.run_due(conn, SETTINGS, now="2026-08-01T07:00:00Z") == [(wid, "failed")]
    row = conn.execute("SELECT * FROM wakeups WHERE id=?", (wid,)).fetchone()
    assert row["status"] == "pending" and row["attempts"] == 1
    # tick 2: attempt 2 -> marked failed + telegram
    dispatch.run_due(conn, SETTINGS, now="2026-08-01T07:05:00Z")
    row = conn.execute("SELECT * FROM wakeups WHERE id=?", (wid,)).fetchone()
    assert row["status"] == "failed" and row["attempts"] == 2
    assert sent and "wakeup" in sent[-1].lower()


def test_deferred_stops_tick(tmp_path, monkeypatch):
    conn = db.connect(tmp_path / "j.db")
    w1 = wakeup.add(conn, "2026-08-01T06:00:00Z", "deepdive", "a")
    w2 = wakeup.add(conn, "2026-08-01T06:30:00Z", "deepdive", "b")
    monkeypatch.setattr(dispatch.runner, "run_agent",
                        lambda c, s, rt, task=None, dry_run=False: "deferred")
    results = dispatch.run_due(conn, SETTINGS, now="2026-08-01T07:00:00Z")
    assert results == [(w1, "deferred")]  # w2 untouched this tick
    assert conn.execute("SELECT attempts FROM wakeups WHERE id=?", (w2,)).fetchone()["attempts"] == 0


def test_cli_dry_run_fires_nothing(tmp_path, monkeypatch):
    cfg = tmp_path / "config"
    cfg.mkdir()
    (cfg / "sources.yaml").write_text("sources: []\n")
    (cfg / "settings.yaml").write_text(
        "timezone: Asia/Dubai\ninbox_cap: 120\n"
        "runs:\n  claude_cmd: [\"true\"]\n  max_agent_runs_per_day: 20\n"
        "  timeouts_seconds: {brief: 900, deepdive: 900, scan: 300, retro: 1200}\n"
        "telegram:\n  bot_token_env: JAMASP_TG_TOKEN\n  chat_id_env: JAMASP_TG_CHAT\n"
    )
    dbp = tmp_path / "j.db"
    conn = db.connect(dbp)
    wakeup.add(conn, "2000-01-01T00:00:00Z", "deepdive", "ancient")
    out = CliRunner().invoke(main, ["dispatch", "--dry-run", "--db", str(dbp), "--config-dir", str(cfg)])
    assert out.exit_code == 0 and "deepdive" in out.output
    row = conn.execute("SELECT status, attempts FROM wakeups").fetchone()
    assert row["status"] == "pending" and row["attempts"] == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_dispatch.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jamasp.dispatch'`.

- [ ] **Step 3: Implement `jamasp/dispatch.py`**

```python
"""Dispatcher: fire due wakeup-queue entries through the runner."""
from __future__ import annotations

import sqlite3

from jamasp import runner, wakeup

MAX_ATTEMPTS = 2


def run_due(
    conn: sqlite3.Connection,
    settings: dict,
    now: str | None = None,
    dry_run: bool = False,
) -> list[tuple[int, str]]:
    results: list[tuple[int, str]] = []
    for w in wakeup.due(conn, now=now):
        if dry_run:
            results.append((w["id"], "would-fire"))
            continue
        attempts = wakeup.record_attempt(conn, w["id"])
        status = runner.run_agent(conn, settings, w["run_type"], task=w["task"])
        results.append((w["id"], status))
        if status == "ok":
            wakeup.mark(conn, w["id"], "done")
        elif status == "deferred":
            break  # daily cap hit — later wakeups would defer too; next tick retries
        elif attempts >= MAX_ATTEMPTS:
            wakeup.mark(conn, w["id"], "failed")
            runner._notify_safe(
                settings,
                f"Jamasp FAILURE: wakeup #{w['id']} ({w['run_type']}: {w['task']})"
                f" gave up after {attempts} attempts.",
            )
        # else: leave pending; the next 5-minute tick retries it
    return results
```

- [ ] **Step 4: Add the CLI command** — in `jamasp/cli.py`, import `from jamasp import dispatch as dispatch_mod` and add:

```python
@main.command()
@click.option("--dry-run", is_flag=True, help="show what would fire; fire nothing")
@db_opt
@cfg_opt
def dispatch(dry_run, db_path, config_dir):
    """Fire due wakeup-queue entries as headless agent runs."""
    conn, _, settings = _common(db_path, config_dir)
    if dry_run:
        for w in wakeup_mod.due(conn):  # wakeup_mod imported in Task 2
            click.echo(f"[dry-run] would fire #{w['id']} {w['run_type']}: {w['task']}")
        return
    results = dispatch_mod.run_due(conn, settings)
    if not results:
        click.echo("no due wakeups")
        return
    for wid, status in results:
        click.echo(f"wakeup #{wid}: {status}")
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_dispatch.py -v`
Expected: 4 PASS.

- [ ] **Step 6: Commit**

```bash
git add jamasp/dispatch.py jamasp/cli.py tests/test_dispatch.py
git commit -m "feat(dispatch): fire due wakeups through the runner with 2-attempt retry"
```

---

### Task 7: Watchdog — non-silent downtime

**Files:**
- Create: `jamasp/watchdog.py`, `tests/test_watchdog.py`
- Modify: `jamasp/cli.py`

**Interfaces:**
- Consumes: `meta.last_ingest_at` (set by `ingest` since Task 3); `wakeups` table; `reports/` layout `reports/YYYY/MM/YYYY-MM-DD-brief.md`; `runner._notify_safe`.
- Produces:
  - `watchdog.check(conn, reports_dir: Path, now: str | None = None) -> list[str]` — list of human-readable violations (empty = healthy). Checks:
    1. `last_ingest_at` missing or older than 60 min → "ingestion stale".
    2. Yesterday's (Dubai date) brief file missing → "no brief yesterday".
    3. Any pending wakeup overdue by more than 30 min → "wakeup queue stuck".
  - `watchdog.run(conn, settings, reports_dir: Path, now=None) -> list[str]` — calls `check`; if violations, sends ONE plain-text Telegram via `runner._notify_safe` listing them; returns violations.
  - CLI: `jamasp watchdog` — prints `OK` or the violations; exit code always 0 (the watchdog reporting a violation is a success of the watchdog).

- [ ] **Step 1: Write the failing tests** — `tests/test_watchdog.py`:

```python
from pathlib import Path

from jamasp import db, watchdog, wakeup

NOW = "2026-08-01T06:00:00Z"  # 2026-08-01 10:00 Dubai


def healthy(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    db.set_meta(conn, "last_ingest_at", "2026-08-01T05:30:00Z")
    reports = tmp_path / "reports"
    (reports / "2026" / "07").mkdir(parents=True)
    (reports / "2026" / "07" / "2026-07-31-brief.md").write_text("# brief")
    return conn, reports


def test_healthy_no_violations(tmp_path):
    conn, reports = healthy(tmp_path)
    assert watchdog.check(conn, reports, now=NOW) == []


def test_stale_ingest(tmp_path):
    conn, reports = healthy(tmp_path)
    db.set_meta(conn, "last_ingest_at", "2026-08-01T04:00:00Z")  # 2h old
    v = watchdog.check(conn, reports, now=NOW)
    assert any("ingest" in x for x in v)


def test_missing_ingest_meta(tmp_path):
    conn, reports = healthy(tmp_path)
    conn.execute("DELETE FROM meta")
    conn.commit()
    assert any("ingest" in x for x in watchdog.check(conn, reports, now=NOW))


def test_missing_yesterday_brief(tmp_path):
    conn, reports = healthy(tmp_path)
    (reports / "2026" / "07" / "2026-07-31-brief.md").unlink()
    v = watchdog.check(conn, reports, now=NOW)
    assert any("brief" in x for x in v)


def test_stuck_wakeup(tmp_path):
    conn, reports = healthy(tmp_path)
    wakeup.add(conn, "2026-08-01T05:00:00Z", "deepdive", "t")  # 60 min overdue
    v = watchdog.check(conn, reports, now=NOW)
    assert any("wakeup" in x for x in v)


def test_run_sends_single_telegram_on_violation(tmp_path, monkeypatch):
    conn, reports = healthy(tmp_path)
    db.set_meta(conn, "last_ingest_at", "2026-08-01T04:00:00Z")
    sent = []
    monkeypatch.setattr(watchdog.runner, "_notify_safe", lambda s, t: sent.append(t))
    v = watchdog.run(conn, {}, reports, now=NOW)
    assert v and len(sent) == 1 and "Jamasp watchdog" in sent[0]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_watchdog.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'jamasp.watchdog'`.

- [ ] **Step 3: Implement `jamasp/watchdog.py`**

```python
"""No-LLM health checks; Jamasp being down is never silent."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from jamasp import runner
from jamasp.db import get_meta, utcnow

DUBAI = timezone(timedelta(hours=4))
INGEST_STALE_MINUTES = 60
WAKEUP_STUCK_MINUTES = 30


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def check(conn: sqlite3.Connection, reports_dir: Path, now: str | None = None) -> list[str]:
    now_dt = _parse(now or utcnow())
    violations: list[str] = []

    last_ingest = get_meta(conn, "last_ingest_at")
    if last_ingest is None:
        violations.append("ingest has never recorded a heartbeat (meta.last_ingest_at missing)")
    elif now_dt - _parse(last_ingest) > timedelta(minutes=INGEST_STALE_MINUTES):
        violations.append(f"ingest stale: last ran {last_ingest} (> {INGEST_STALE_MINUTES} min ago)")

    yesterday = (now_dt.astimezone(DUBAI) - timedelta(days=1)).strftime("%Y-%m-%d")
    y, m, _ = yesterday.split("-")
    brief = Path(reports_dir) / y / m / f"{yesterday}-brief.md"
    if not brief.exists():
        violations.append(f"yesterday's brief missing: {brief}")

    threshold = (now_dt - timedelta(minutes=WAKEUP_STUCK_MINUTES)).strftime("%Y-%m-%dT%H:%M:%SZ")
    stuck = conn.execute(
        "SELECT COUNT(*) FROM wakeups WHERE status = 'pending' AND due_at < ?",
        (threshold,),
    ).fetchone()[0]
    if stuck:
        violations.append(f"wakeup queue stuck: {stuck} pending entries overdue > {WAKEUP_STUCK_MINUTES} min")

    return violations


def run(
    conn: sqlite3.Connection, settings: dict, reports_dir: Path, now: str | None = None
) -> list[str]:
    violations = check(conn, reports_dir, now=now)
    if violations:
        runner._notify_safe(
            settings, "Jamasp watchdog:\n" + "\n".join(f"- {v}" for v in violations)
        )
    return violations
```

- [ ] **Step 4: Add the CLI command** — in `jamasp/cli.py`, import `from jamasp import watchdog as watchdog_mod` and add:

```python
@main.command()
@click.option("--reports-dir", default="reports", show_default=True)
@db_opt
@cfg_opt
def watchdog(reports_dir, db_path, config_dir):
    """Health check: ingestion fresh, yesterday's brief exists, queue draining."""
    conn, _, settings = _common(db_path, config_dir)
    violations = watchdog_mod.run(conn, settings, Path(reports_dir))
    if not violations:
        click.echo("OK")
    else:
        for v in violations:
            click.echo(f"VIOLATION: {v}")
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_watchdog.py -v`
Expected: 6 PASS. Then `uv run pytest -v` — the whole suite green.

- [ ] **Step 6: Commit**

```bash
git add jamasp/watchdog.py jamasp/cli.py tests/test_watchdog.py
git commit -m "feat(watchdog): health checks with single telegram alert"
```

---

### Task 8: Skills + state seeds — /scan, /deepdive, /retro, upgraded /brief

No pytest here; the deliverables are markdown. Verification = read-through against the spec §Agent runs + a `--dry-run` sanity pass. Skills must only use CLI commands that exist after Tasks 2–7.

**Files:**
- Create: `.claude/skills/scan/SKILL.md`, `.claude/skills/deepdive/SKILL.md`, `.claude/skills/retro/SKILL.md`, `state/playbook.md`, `state/lessons-inbox.md`, `state/calendar.yaml`
- Modify: `.claude/skills/brief/SKILL.md`

**Interfaces:**
- Consumes: CLI commands `jamasp inbox|price|extract|notify|calendar|wakeup add|wakeup list|predictions add|predictions due|predictions score`.
- Produces: the four run-type prompts fired by runner/dispatcher as `/brief`, `/scan`, `/deepdive <task>`, `/retro`.

- [ ] **Step 1: Write `.claude/skills/scan/SKILL.md`**

```markdown
---
name: scan
description: 2-hourly urgent-news scan — read the delta against the stance; stay silent unless something demands desk attention.
---

# Urgent Scan

Cheap run. Target: a few thousand tokens, sub-minute. The default outcome is
**silence**.

## 1. Load (only this)

- Read `state/stance.md`.
- Run `uv run jamasp inbox` and `uv run jamasp price`.

## 2. Decide

Urgency test — does anything in the delta meet at least one of:
- surprise data print or central-bank action that contradicts the stance;
- geopolitical shock with a plausible gold transmission channel;
- gold move ≥ 1.5% since the last price snapshot in `stance.md`'s context.

If NO (the normal case): run `uv run jamasp inbox --mark-read`, commit
(`jamasp: scan YYYY-MM-DD HH:MM`), and exit. **No report, no Telegram, no
stance edit.**

## 3. If YES — alert

- Compose a terse bilingual alert: 2–4 lines Persian (numbers/tickers Latin)
  then 1–2 lines English: what happened, expected gold impact, whether the
  stance changes. Send via `uv run jamasp notify -`.
- If the stance changes materially, rewrite `state/stance.md` (≤1 page) and
  say so in the alert.
- If the item deserves a focused read (statement, transcript, dataset),
  schedule it instead of doing it now:
  `uv run jamasp wakeup add "<ISO time, soon>" deepdive "<precise task>"`.
- Record any new falsifiable view:
  `uv run jamasp predictions add "<claim>" --direction up|down|flat --horizon-days N --confidence 0.x`.

## 4. Close out

- `uv run jamasp inbox --mark-read`
- `git add -A state/ && git commit -m "jamasp: scan YYYY-MM-DD HH:MM"`
```

- [ ] **Step 2: Write `.claude/skills/deepdive/SKILL.md`**

```markdown
---
name: deepdive
description: Focused single-topic analysis run, dispatched from the wakeup queue with its task text (e.g. read a Fed statement and assess gold impact).
---

# Deep Dive

You were invoked as `/deepdive <task>`. The task text is your entire mission —
do it, assess gold impact, deliver, exit. Don't re-scan the whole news delta.

## 1. Load

- Read `state/stance.md` and `state/playbook.md`.
- Run `uv run jamasp price`.

## 2. Investigate

- Use `uv run jamasp extract <url>` for the primary document(s) named or
  implied by the task. If extracted text runs past ~2 pages, dispatch a
  subagent (Haiku/Sonnet, low effort) to read it and return conclusions only
  — raw source text never enters this session.
- Compare findings to the relevant section of `stance.md`: confirm, refine,
  or contradict. Be explicit about which.

## 3. Deliver

- Append a `## Deep dive — <topic> (HH:MM Dubai)` section to today's report
  `reports/YYYY/MM/YYYY-MM-DD-brief.md` (create the file with just this
  section if no brief exists yet): findings, mechanism, gold impact,
  stance change or not.
- If the stance changed: rewrite `state/stance.md` (≤1 page) and send a
  short Persian Telegram note (`uv run jamasp notify -`) saying what changed
  and why. If it didn't change, no Telegram.
- Record new falsifiable views with `uv run jamasp predictions add ...`.
- If this analysis surfaces a future event worth watching, add it to
  `state/calendar.yaml` and schedule it:
  `uv run jamasp wakeup add "<ISO>" deepdive "<task>"`.

## 4. Close out

- `git add -A reports/ state/ && git commit -m "jamasp: deepdive YYYY-MM-DD <topic>"`
```

- [ ] **Step 3: Write `.claude/skills/retro/SKILL.md`**

```markdown
---
name: retro
description: Weekly deep learning run (Sunday) — calibration scorecard from the week's scored predictions, playbook rewrite from evidence, lessons-inbox consumption.
---

# Weekly Retro

The learning run. Markets are closed; take the long view. This is the ONLY
run allowed to rewrite `state/playbook.md`.

## 1. Load

- Read `state/playbook.md`, `state/lessons-inbox.md`, `state/stance.md`.
- Run `uv run jamasp predictions list` and `uv run jamasp predictions due`.
- Score anything still due (judge against the annotated price move):
  `uv run jamasp predictions score <id> --outcome hit|miss|unclear --note "<why>"`.

## 2. Scorecard report

Write `reports/YYYY/MM/YYYY-MM-DD-retro.md`:

    # Jamasp Retro — week ending YYYY-MM-DD

    ## Scorecard
    <this week's scored predictions: claim, confidence, outcome. Hit rate
    overall and by claim type (rates/dollar/geopolitics/flows). Where am I
    reliably right? Where do I overweight noise?>

    ## Calibration notes
    <compare stated confidence to observed hit rate; name one concrete bias>

    ## Playbook changes
    <bullet list: promoted / revised / pruned heuristics, each with the
    evidence line that justifies it>

## 3. Rewrite the playbook

Rewrite `state/playbook.md` in full (never append-only):
- Promote lessons from `lessons-inbox.md` that this week's evidence supports.
- Prune heuristics disproven or unused for 4+ weeks.
- Hard cap: 25 heuristics / one page. Every heuristic carries a one-line
  evidence note (`— evidence: <dates/outcomes>`).
- Then empty `state/lessons-inbox.md` (consumed), leaving its header.

## 4. Address human feedback

Search the week's Telegram feedback forwarded into the repo (grep
`reports/` and `state/lessons-inbox.md` for `feedback:` entries). Every
piece of feedback from Saman gets an explicit response in the retro report:
adopted (how) or declined (why).

## 5. Deliver + close out

- Persian summary of the scorecard (≤8 lines) → `uv run jamasp notify -`.
- `git add -A reports/ state/ && git commit -m "jamasp: retro YYYY-MM-DD"`.

Phase 3 (not yet): source-quality analysis and gated self-edit proposals on
a branch. Do not attempt them.
```

- [ ] **Step 4: Seed the state files**

`state/playbook.md`:

```markdown
# Playbook

Earned heuristics only — rewritten weekly by /retro, never by other runs.
Cap: 25 heuristics, one page. Each carries an evidence note.

## Heuristics

(none yet — earned starting with the first weekly retro)
```

`state/lessons-inbox.md`:

```markdown
# Lessons inbox

Candidate lessons from daily micro-retros and feedback; consumed (emptied)
by the weekly /retro. One bullet per lesson: date, observation, suggested rule.
```

`state/calendar.yaml`:

```yaml
# Agent-curated event notes: things Jamasp decided to care about, with why.
# The raw feed lives in the events table (`jamasp calendar`); this file is
# judgment — which events matter for gold and what to do when they hit.
events: []
# example entry:
# - date: 2026-08-12
#   time_dubai: "16:30"
#   title: US CPI (Jul)
#   why: dominant real-yield driver; stance §rates hinges on it
#   action: wakeup scheduled for 16:45 same day (deepdive: compare print to consensus)
```

- [ ] **Step 5: Upgrade `.claude/skills/brief/SKILL.md`** — three edits:

(a) Replace the "## 1. Load context" bullet list with:

```markdown
- Read `state/stance.md`, `state/playbook.md`, `state/watchlist.yaml`,
  and `state/calendar.yaml`.
- Run `uv run jamasp ingest` (refresh), then `uv run jamasp price`,
  `uv run jamasp inbox`, `uv run jamasp calendar`, `uv run jamasp wakeup list`,
  and `uv run jamasp predictions due`.
```

(b) Insert a new section between "## 1. Load context" and "## 2. Analyze":

```markdown
## 1.5 Micro-retro (yesterday's calls)

- For each prediction printed by `jamasp predictions due` (already annotated
  with the actual gold move): judge it honestly and score it —
  `uv run jamasp predictions score <id> --outcome hit|miss|unclear --note "<why>"`.
- Summarize hits/misses in one short "Yesterday's calls" section of today's
  report. No scored predictions → skip the section.
- A miss with a nameable cause → append one bullet to
  `state/lessons-inbox.md` (date, observation, suggested rule). You may
  adjust `state/stance.md`; NEVER touch `state/playbook.md` (that's /retro's).
```

(c) Extend "## 4. Update state" with:

```markdown
- Calendar maintenance: newly discovered events worth acting on go into
  `state/calendar.yaml` (with why + action), and each gets a wakeup:
  `uv run jamasp wakeup add "<ISO>" deepdive "<precise task>"`
  (e.g. transcript analysis 30 min after a speech).
- Record today's falsifiable outlook claims:
  `uv run jamasp predictions add "<claim>" --direction up|down|flat
  --horizon-days N --confidence 0.x` — 1–3 per brief, only claims you'd
  accept being scored on.
- First brief of the week (Monday): prune watchlist entries stale for
  4+ weeks (check each `since:`), noting removals in the report.
```

Also extend the report template's "## Watching" line to mention wakeups:
`<upcoming events/data with dates (Dubai time), scheduled wakeups (from jamasp wakeup list), and watchlist changes>`.

- [ ] **Step 6: Verify**

- Read each skill start-to-finish; confirm every `jamasp` invocation exists in the CLI built by Tasks 2–7 (exact flags: `predictions add` takes `--direction/--horizon-days/--confidence`; `wakeup add` takes positional `DUE_AT RUN_TYPE TASK`).
- Run: `uv run jamasp run scan --dry-run` and `uv run jamasp run deepdive "test task" --dry-run` — prompts render as `/scan` and `/deepdive test task`.

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/ state/playbook.md state/lessons-inbox.md state/calendar.yaml
git commit -m "feat(skills): /scan, /deepdive, /retro; brief gains micro-retro + scheduling"
```

---

### Task 9: Ops — systemd units, CLAUDE.md toolbox, deploy runbook

**Files:**
- Create: `ops/systemd/` — 6 service + 6 timer templates (below)
- Modify: `CLAUDE.md` (toolbox table), `.claude/skills/deploy/SKILL.md`

**Interfaces:**
- Consumes: CLI commands from Tasks 3–7 (`jamasp run`, `jamasp dispatch`, `jamasp watchdog`).
- Produces: unit templates the deploy skill installs verbatim (with `%h` home expansion; `User=jamasp` variants documented in the deploy skill).

- [ ] **Step 1: Write the unit templates** — every service is `Type=oneshot`, `WorkingDirectory=%h/Jamasp`, with:

```ini
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-%h/.config/jamasp/env
```

Create these 12 files under `ops/systemd/` (shown as service `ExecStart` + timer `OnCalendar`; write each full file with `[Unit]` Description, `[Service]`/`[Timer]`, and `[Install] WantedBy=timers.target` on timers):

| unit | ExecStart | timer OnCalendar | timer extras |
|---|---|---|---|
| `jamasp-ingest` | `%h/.local/bin/uv run jamasp ingest` | `*:0/15` | `Persistent=true`, `RandomizedDelaySec=90` |
| `jamasp-brief` | `%h/.local/bin/uv run jamasp run brief` | `*-*-* 07:30:00 Asia/Dubai` | `Persistent=true` |
| `jamasp-scan` | `%h/.local/bin/uv run jamasp run scan` | `*-*-* 09,11,13,15,17,19,21,23:00:00 Asia/Dubai` | — |
| `jamasp-dispatch` | `%h/.local/bin/uv run jamasp dispatch` | `*:0/5` | — |
| `jamasp-retro` | `%h/.local/bin/uv run jamasp run retro` | `Sun *-*-* 20:00:00 Asia/Dubai` | `Persistent=true` |
| `jamasp-watchdog` | `%h/.local/bin/uv run jamasp watchdog` | `*-*-* 09:00:00 Asia/Dubai` | `Persistent=true` |

Full example to copy for the others — `ops/systemd/jamasp-dispatch.service`:

```ini
[Unit]
Description=Jamasp dispatcher — fire due wakeup-queue entries

[Service]
Type=oneshot
WorkingDirectory=%h/Jamasp
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-%h/.config/jamasp/env
ExecStart=%h/.local/bin/uv run jamasp dispatch
```

and `ops/systemd/jamasp-dispatch.timer`:

```ini
[Unit]
Description=Run the Jamasp dispatcher every 5 minutes

[Timer]
OnCalendar=*:0/5

[Install]
WantedBy=timers.target
```

Note: `jamasp-brief` replaces phase 1's direct `claude -p "/brief"` ExecStart — the runner now wraps it (cap/retry/telegram). The brief/scan/retro/dispatch services rely on `claude` being on the PATH above.

- [ ] **Step 2: Update `CLAUDE.md` toolbox table** — add rows:

```markdown
| `uv run jamasp calendar` | upcoming economic events (UTC + Dubai), high/medium impact |
| `uv run jamasp wakeup add "<ISO>" <type> "<task>"` | schedule a future run (usually deepdive) |
| `uv run jamasp wakeup list` | pending wakeups (feed the brief's "watching" section) |
| `uv run jamasp predictions add\|due\|score` | record and score falsifiable forecasts |
```

(Do not add `run`/`dispatch`/`watchdog` — those are infra commands, not agent tools.)

- [ ] **Step 3: Update `.claude/skills/deploy/SKILL.md`** — replace section "### 5. systemd units" content with: copy every file from `ops/systemd/` into `/etc/systemd/system/` (root; replace `%h` with `/home/jamasp` and add `User=jamasp`) or `~/.config/systemd/user/` (user units keep `%h`), then `daemon-reload` and `enable --now` the six timers — ingest + dispatch + watchdog immediately; brief, scan, retro only after the human handoff. Update the "Sanity / ops" section's timer list to all six. Add one line to Human handoff: "check `uv run jamasp watchdog` prints OK after the first full day."

- [ ] **Step 4: Verify**

- `systemd-analyze verify` is unavailable on macOS — instead re-read each unit against the table above (ExecStart paths, OnCalendar syntax, `Persistent=` placement in `[Timer]`).
- `grep -c OnCalendar ops/systemd/*.timer` → exactly 1 each; 6 timers, 6 services present.

- [ ] **Step 5: Commit**

```bash
git add ops/systemd/ CLAUDE.md .claude/skills/deploy/SKILL.md
git commit -m "feat(ops): phase-2 systemd units; toolbox + deploy runbook updates"
```

---

### Task 10: End-to-end smoke test (manual, token-spending)

**Files:** none created (throwaway scratch config).

Run before deploying to the VPS, per spec §Testing. This validates the full autonomy loop on the Mac with the real `claude` CLI.

- [ ] **Step 1: Full suite green**

Run: `uv run pytest -v` → everything passes.

- [ ] **Step 2: Dispatcher loop with a real run**

```bash
uv run jamasp ingest
uv run jamasp wakeup add "$(date -u +%Y-%m-%dT%H:%M:%SZ)" deepdive \
  "Smoke test: read state/stance.md, confirm you can run jamasp price, append a one-line '## Deep dive — smoke test' section to today's report, commit."
uv run jamasp dispatch
```

Expected: dispatch prints `wakeup #N: ok`; today's report gained the section; a commit exists; `uv run jamasp wakeup list` shows no pending entries; `agent_runs` has an `ok` row (`sqlite3 state/jamasp.db "select run_type,status from agent_runs"`).

- [ ] **Step 3: Watchdog + cap behavior (no tokens)**

```bash
uv run jamasp watchdog            # expect OK (or explainable violations)
```

Then temporarily set `max_agent_runs_per_day: 0` in `config/settings.yaml`, run `uv run jamasp run scan`, expect `scan: deferred` + a Telegram cap warning; revert the setting.

- [ ] **Step 4: Commit the smoke-test state**

```bash
git add -A state/ reports/
git commit -m "jamasp: phase-2 smoke test"
```

---

## Self-review (done at planning time)

- **Spec coverage:** wakeup queue + dispatcher (T2, T6), `/scan` + `/deepdive` (T8), calendar ingestion (T3), watchlist pruning (T8 brief edit; watchlist file exists from phase 1), systemd timers (T9), watchdog (T7), deploy script updates (T9), predictions + micro-retro + weekly `/retro` with playbook (T4, T8). Safety cap + rate-limit/failure handling (T5). Exit criterion — "self-schedules an event analysis correctly" — exercised by T10 step 2; "first weekly scorecard" lands the first Sunday after deploy.
- **Deliberate deviations from spec text:** (1) fixed runs (brief/scan/retro) go through `jamasp run` rather than bare `claude -p` in timers, so the spec's §Error-handling requirements (timeout, retry, telegram, cap) apply uniformly — the "dispatcher wraps every claude -p" sentence is satisfied by the shared runner. (2) Rate-limit detection is subsumed into generic failure/retry + cap deferral rather than parsing CLI error strings (brittle); revisit if rate limits bite in practice. (3) Central-bank speech schedules: ForexFactory's calendar includes speeches, so no separate speech source is added in phase 2. (4) The spec's "expected-but-missing report file counts as failure" is covered by the watchdog's yesterday-brief check rather than a post-run file check in the runner — accepted substitute, noted at final review.
- **Type consistency check:** `wakeup.add/due/mark/record_attempt` signatures match T6's dispatcher usage; `predictions` CLI flags in T8 skills match T4's click definitions; `runner.run_agent` return statuses (`ok|failed|timeout|deferred`) match T6's branching; `meta.last_ingest_at` written in T3 CLI wiring matches T7 watchdog read; symbol `GC` (Yahoo `GC=F` stripped by `parse_yahoo_chart_json`) matches T4 settings default.



