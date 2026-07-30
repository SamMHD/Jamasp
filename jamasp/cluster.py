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
