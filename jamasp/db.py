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
-- Backs the panel's unscoredCountSince (panel/lib/db.ts): its NOT EXISTS
-- subquery does a per-row `i2.url = i.url` lookup to test whether a URL has
-- been scored, and this index lets SQLite satisfy that with an indexed
-- search (SEARCH i2 USING INDEX idx_items_url (url=?)) instead of a full
-- table scan per outer row. Confirmed with EXPLAIN QUERY PLAN against the
-- real schema. getScoredItems's URL collapse does NOT use this index — its
-- plan is identical with and without it (USE TEMP B-TREE FOR ORDER BY in
-- both cases) because the CTE materialises the item_scores/items join
-- before the window function ever runs, so there is no per-row url lookup
-- for an index to drive.
CREATE INDEX IF NOT EXISTS idx_items_url ON items(url);
CREATE TABLE IF NOT EXISTS prices (
    symbol TEXT NOT NULL,
    ts     TEXT NOT NULL,
    value  REAL NOT NULL,
    PRIMARY KEY (symbol, ts)
);
-- OHLC bars, for the indicators and the ridge fit. `prices` is scalar and
-- cannot hold a high or a low; ATR needs both, and ATR is both a signal and
-- the divisor that normalises the fit's target.
--
-- ts is the bar's OPEN time. Stated here because a close-stamped bar shifts
-- every indicator by one period, and that error stays invisible until
-- someone compares a computed SMA against a chart.
--
-- '1h' is stored as well as the spec's '1d'/'4h'/'1w': the fit's target is a
-- forward return at hourly resolution, so it needs an hourly close to
-- measure from. Yahoo returns the hourly series in the same call we make for
-- the 4h resample, so storing it is free. Yahoo caps interval=1h at
-- range=730d, which is what bounds the hourly history — not this table.
CREATE TABLE IF NOT EXISTS bars (
    symbol    TEXT NOT NULL,
    timeframe TEXT NOT NULL,   -- '1h' | '4h' | '1d' | '1w'
    ts        TEXT NOT NULL,   -- bar OPEN time, UTC
    open      REAL NOT NULL,
    high      REAL NOT NULL,
    low       REAL NOT NULL,
    close     REAL NOT NULL,
    PRIMARY KEY (symbol, timeframe, ts)
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
CREATE TABLE IF NOT EXISTS notify_log (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    ts   TEXT NOT NULL,
    text TEXT NOT NULL,
    ok   INTEGER NOT NULL
);
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
CREATE TABLE IF NOT EXISTS rollups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    text_fa    TEXT NOT NULL,
    message_id INTEGER,
    status     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rollups_created ON rollups(created_at);
CREATE TABLE IF NOT EXISTS item_scores (
    item_id    TEXT PRIMARY KEY REFERENCES items(id),
    tier       INTEGER NOT NULL,
    direction  INTEGER NOT NULL,
    conviction REAL    NOT NULL,
    theme      TEXT    NOT NULL,
    scored_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_item_scores_theme ON item_scores(theme);
-- Current technical states for the technical map, in [-1, +1] where positive
-- is bullish for gold. Written by `jamasp signals refresh`; read by the panel.
--
-- ts is the CLOSE time of the bar the state was computed from, not that
-- bar's open: a state derived from a daily bar is not knowable until that day
-- ends. Storing the open time would let the panel show a state hours before
-- it existed, and would let the fit train on it.
--
-- The fit does NOT read this table. It recomputes every historical state from
-- bars, so a refit is reproducible from bars alone and cannot inherit a state
-- written by an older version of a classifier.
CREATE TABLE IF NOT EXISTS signal_states (
    key   TEXT NOT NULL,   -- "<signal>@<timeframe>", e.g. "rsi14@1d"
    ts    TEXT NOT NULL,   -- bar CLOSE time, UTC
    value REAL NOT NULL,   -- [-1, +1], positive = bullish for gold
    PRIMARY KEY (key, ts)
);
CREATE INDEX IF NOT EXISTS idx_signal_states_key_ts ON signal_states(key, ts DESC);
-- Every fitted coefficient from every run, so a multiplier's drift over time
-- is inspectable. state/weights.json holds only the current fit; this is the
-- trajectory, and it is the difference between "rates_dollar is 1.8" and
-- "rates_dollar has climbed from 1.1 to 1.8 over six weeks".
CREATE TABLE IF NOT EXISTS weight_fits (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    fitted_at  TEXT NOT NULL,
    fit        TEXT NOT NULL,   -- 'technical' | 'theme'
    key        TEXT NOT NULL,
    beta       REAL NOT NULL,
    se         REAL NOT NULL,
    multiplier REAL NOT NULL,
    n          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_weight_fits_key ON weight_fits(fit, key, fitted_at);
"""

# Columns added to tables that already exist in deployed databases. The schema
# above is all CREATE TABLE IF NOT EXISTS, so it never alters an existing table
# — and the live database is months of history that cannot be recreated.
# SQLite's ADD COLUMN doesn't rewrite the table, so this stays instant.
ADDED_COLUMNS = (
    ("flash_items", "tier", "INTEGER"),
    ("flash_items", "rollup_id", "INTEGER"),
)


def _add_missing_columns(conn: sqlite3.Connection) -> None:
    for table, column, decl in ADDED_COLUMNS:
        existing = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        if not existing:
            continue  # table itself is absent; the schema script owns creating it
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
    conn.commit()


def connect(path: Path = Path("state/jamasp.db")) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.executescript(SCHEMA)
    _add_missing_columns(conn)
    return conn


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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
