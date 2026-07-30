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
