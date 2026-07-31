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
