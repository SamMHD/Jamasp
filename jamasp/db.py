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
-- Backs the panel's getScoredItems (panel/lib/db.ts): it collapses rows that
-- share a URL with a window function partitioned and sorted by url, and this
-- index lets SQLite satisfy that PARTITION BY/ORDER BY with a sorted scan
-- instead of an in-memory sort over every candidate row.
CREATE INDEX IF NOT EXISTS idx_items_url ON items(url);
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
