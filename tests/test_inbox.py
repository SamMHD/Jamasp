import json
from datetime import datetime, timedelta, timezone

from jamasp import cluster, db, inbox
from jamasp.ingest import rss
from jamasp.models import Item


def _ts(hours_ago: float = 0) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def _mk(source, headline, i, ts=None):
    if ts is None:
        ts = _ts(2)
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
    c = _mk("marketwatch_top", "Oil slides on OPEC supply surprise", 3, ts=_ts(1))
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


def test_dead_sources_ignores_pipeline_pseudo_sources(tmp_path):
    # flash and digest log to source_errors but never write items, so the
    # dead-feed rule would report them as a permanent coverage gap. A missing
    # JAMASP_TG_NEWS_CHAT alone is 96 flash errors a day.
    conn = db.connect(tmp_path / "t.db")
    now = db.utcnow()
    for src in ("flash", "digest", "treasury_press"):
        conn.execute("INSERT INTO source_errors VALUES (?, ?, 'boom')", (src, now))
    conn.commit()
    assert inbox.dead_sources(conn) == ["treasury_press"]
    out = inbox.render(conn)
    assert "'flash'" not in out and "'digest'" not in out
    assert "'treasury_press'" in out
