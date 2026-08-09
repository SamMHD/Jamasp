from pathlib import Path

from jamasp.config import Source, load_settings, load_sources

FIXTURES = Path(__file__).parent / "fixtures"


def test_load_sources_parses_entries(tmp_path):
    p = tmp_path / "sources.yaml"
    p.write_text(
        """
sources:
  - name: fxstreet
    type: rss
    url: https://www.fxstreet.com/rss/news
    interval_minutes: 15
    topic: markets
  - name: gold_spot
    type: price_api
    url: "https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv"
    interval_minutes: 15
    topic: prices
    parser: stooq_csv
"""
    )
    sources = load_sources(p)
    assert len(sources) == 2
    assert sources[0] == Source("fxstreet", "rss", "https://www.fxstreet.com/rss/news", 15, "markets", None)
    assert sources[1].parser == "stooq_csv"


def test_load_settings(tmp_path):
    p = tmp_path / "settings.yaml"
    p.write_text("inbox_cap: 120\ntimezone: Asia/Dubai\n")
    s = load_settings(p)
    assert s["inbox_cap"] == 120


def test_repo_configs_load():
    sources = load_sources()
    assert any(s.type == "rss" for s in sources)
    assert any(s.type == "price_api" for s in sources)
    settings = load_settings()
    assert settings["inbox_cap"] == 120
    assert settings["timezone"] == "Asia/Dubai"


def test_repo_settings_carry_the_whole_flash_block():
    # A dropped or renamed key here passes every other test while silently
    # disabling flash in production: one source_errors row per ingest tick.
    from jamasp.flash import REQUIRED_CFG_KEYS

    settings = load_settings()
    cfg = settings["flash"]
    missing = [key for key in REQUIRED_CFG_KEYS if key not in cfg]
    assert missing == []
    assert cfg["enabled"] is True
    assert settings["telegram"]["news_chat_id_env"]


def test_display_names_uses_display_then_falls_back():
    from jamasp.config import display_names

    sources = [
        Source(name="cnbc_finance", type="rss", url="u", interval_minutes=15,
               topic="markets", display="CNBC"),
        Source(name="mining_com", type="rss", url="u", interval_minutes=15,
               topic="gold"),
    ]
    assert display_names(sources) == {
        "cnbc_finance": "CNBC",
        "mining_com": "Mining Com",
    }
