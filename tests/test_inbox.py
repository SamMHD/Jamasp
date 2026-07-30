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
