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


def test_render_due_annotates_window_extremes(tmp_path):
    # Endpoints alone said "untagged"; the window high says 4501.8 printed.
    conn = db.connect(tmp_path / "j.db")
    prices.store_price(conn, "GC", "2026-08-12T05:00:00Z", 4468.0)
    prices.store_price(conn, "GC", "2026-08-13T00:35:00Z", 4501.8)
    prices.store_price(conn, "GC", "2026-08-14T04:00:00Z", 4471.0)
    p = tmp_path / "p.jsonl"
    predictions.add(p, "gold tags the 200DMA at 4500", "up", 2, 0.7,
                    now="2026-08-12T05:00:00Z")
    out = predictions.render_due(conn, p, "GC", now="2026-08-14T05:00:00Z")
    obj = json.loads([l for l in out.splitlines() if not l.startswith("#")][0])
    assert obj["window_high"] == 4501.8
    assert obj["window_high_ts"] == "2026-08-13T00:35:00Z"
    assert obj["window_low"] == 4468.0


def test_render_due_open_includes_unmatured_with_extremes(tmp_path):
    # The wrong-stance runs happened while the claim was still open, so the
    # window high has to be visible before maturity, not only at scoring.
    conn = db.connect(tmp_path / "j.db")
    prices.store_price(conn, "GC", "2026-08-12T05:00:00Z", 4468.0)
    prices.store_price(conn, "GC", "2026-08-13T00:35:00Z", 4501.8)
    p = tmp_path / "p.jsonl"
    predictions.add(p, "matured claim", "up", 1, 0.7, now="2026-08-12T05:00:00Z")
    predictions.add(p, "still open claim", "up", 30, 0.8, now="2026-08-12T05:00:00Z")

    closed = predictions.render_due(conn, p, "GC", now="2026-08-13T06:00:00Z")
    assert "still open claim" not in closed

    both = predictions.render_due(
        conn, p, "GC", now="2026-08-13T06:00:00Z", include_open=True
    )
    objs = {
        json.loads(l)["claim"]: json.loads(l)
        for l in both.splitlines() if not l.startswith("#")
    }
    assert set(objs) == {"matured claim", "still open claim"}
    assert objs["still open claim"]["matured"] is False
    assert objs["matured claim"]["matured"] is True
    assert objs["still open claim"]["window_high"] == 4501.8


def test_render_due_open_skips_scored(tmp_path):
    conn = db.connect(tmp_path / "j.db")
    p = tmp_path / "p.jsonl"
    e = predictions.add(p, "already judged", "up", 30, 0.8, now="2026-08-12T05:00:00Z")
    predictions.score(p, e["id"], "hit", now="2026-08-12T09:00:00Z")
    out = predictions.render_due(
        conn, p, "GC", now="2026-08-13T06:00:00Z", include_open=True
    )
    assert "already judged" not in out
