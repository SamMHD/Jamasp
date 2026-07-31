from datetime import datetime, timedelta, timezone

from jamasp import cluster, db
from jamasp.config import Source
from jamasp.ingest import rss
from jamasp.models import Item


def _ts(hours_ago: float = 0) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def _mk(conn, source, headline, ts=None):
    if ts is None:
        ts = _ts(2)
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
    _mk(conn, "fxstreet", "Gold climbs as dollar softens", ts=_ts(24 * 30))
    conn.execute("UPDATE items SET cluster_id = id")
    conn.commit()
    b = _mk(conn, "kitco", "Gold climbs as dollar softens", ts=_ts(2))
    cluster.assign_clusters(conn, window_hours=48)
    row = conn.execute("SELECT cluster_id FROM items WHERE id = ?", (b.id,)).fetchone()
    assert row["cluster_id"] == b.id  # month-old story is not "the same story"


def test_backlog_old_pending_item_not_a_match_target(tmp_path):
    conn = db.connect(tmp_path / "t.db")
    old = _mk(conn, "fxstreet", "Gold climbs as dollar softens", ts=_ts(24 * 30))
    new = _mk(conn, "kitco", "Gold climbs as dollar softens", ts=_ts(2))
    joined = cluster.assign_clusters(conn, window_hours=48)
    assert joined == 0  # old item outside window is not a match target
    rows = {r["id"]: r["cluster_id"] for r in conn.execute("SELECT id, cluster_id FROM items")}
    assert rows[old.id] == old.id  # old: own representative
    assert rows[new.id] == new.id  # new: own cluster (does not join old)
