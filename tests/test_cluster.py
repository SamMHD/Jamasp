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
