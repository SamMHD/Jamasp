from pathlib import Path

import pytest

from jamasp import config
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


def test_load_weights_reads_themes(tmp_path):
    p = tmp_path / "w.yaml"
    p.write_text("themes:\n  - rates_dollar\n  - geopolitics\n  - other\n")
    assert config.themes(config.load_weights(p)) == (
        "rates_dollar", "geopolitics", "other")


def test_themes_order_is_preserved(tmp_path):
    # The ridge fit in Plan 2 indexes feature columns by this order, so it is
    # data, not presentation. Sorting it here would silently permute the
    # fitted coefficients against their labels.
    p = tmp_path / "w.yaml"
    p.write_text("themes:\n  - zulu\n  - alpha\n  - other\n")
    assert config.themes(config.load_weights(p)) == ("zulu", "alpha", "other")


def test_shipped_weights_config_has_other_as_the_fallback_slot():
    # Task 4 falls back to "other" for any theme the model invents, so the
    # slot must exist in the shipped taxonomy or those items land nowhere.
    weights = config.load_weights(Path("config/weights.yaml"))
    assert "other" in config.themes(weights)


def test_themes_raises_when_other_slot_is_missing():
    # A retro that drops or misspells the "other" slot must fail loudly here
    # instead of letting _theme()'s fallback write a value outside the
    # configured set — silent corruption of every score from that point on,
    # and a break of Plan 2's positional column assumption with no error.
    weights = {"themes": ["rates_dollar", "geopolitics"]}
    with pytest.raises(ValueError, match="other"):
        config.themes(weights)


from jamasp.config import (
    active_pins, fit_config, load_weights, signal_columns, signal_specs,
    tier_weights,
)

REAL_WEIGHTS = Path("config/weights.yaml")


def test_tier_weights_match_the_panel_constant():
    # panel/lib/marketmap.ts#TIER_WEIGHT is the same table. They encode the
    # same claim about materiality; a silent divergence means the map's areas
    # and the fit's exposures stop describing the same world.
    assert tier_weights(load_weights(REAL_WEIGHTS)) == {5: 100, 4: 60, 3: 30, 2: 10, 1: 3}


def test_signal_columns_are_thirty_eight_and_ordered():
    cols = signal_columns(load_weights(REAL_WEIGHTS))
    assert len(cols) == 38
    assert len(set(cols)) == 38
    assert cols[0] == "sma50@1d"
    assert cols[-1] == "net_spec@1d"


def test_external_signals_carry_a_symbol_and_one_timeframe():
    by_name = {s.name: s for s in signal_specs(load_weights(REAL_WEIGHTS))}
    assert by_name["gvz"].source == "price_series"
    assert by_name["gvz"].symbol == "^GVZ"
    assert by_name["gvz"].timeframes == ("1d",)
    assert by_name["net_spec"].symbol == "GC_NET_SPEC"
    # There is no such thing as a 4h CFTC print.
    assert by_name["net_spec"].timeframes == ("1d",)


def test_every_family_is_non_empty():
    fams = {s.family for s in signal_specs(load_weights(REAL_WEIGHTS))}
    assert fams == {"trend", "momentum", "levels", "volatility", "positioning"}


def test_signal_specs_rejects_a_duplicate_name(tmp_path):
    p = tmp_path / "w.yaml"
    p.write_text(
        "themes: [other]\n"
        "signals:\n"
        "  - {name: rsi14, family: momentum, timeframes: ['1d'], source: bars}\n"
        "  - {name: rsi14, family: trend, timeframes: ['1d'], source: bars}\n"
    )
    with pytest.raises(ValueError, match="duplicate"):
        signal_specs(load_weights(p))


def test_signal_specs_rejects_an_unknown_source(tmp_path):
    p = tmp_path / "w.yaml"
    p.write_text(
        "themes: [other]\n"
        "signals:\n"
        "  - {name: rsi14, family: momentum, timeframes: ['1d'], source: vibes}\n"
    )
    with pytest.raises(ValueError, match="source"):
        signal_specs(load_weights(p))


def test_signal_specs_rejects_a_price_series_with_no_symbol(tmp_path):
    p = tmp_path / "w.yaml"
    p.write_text(
        "themes: [other]\n"
        "signals:\n"
        "  - {name: gvz, family: volatility, timeframes: ['1d'], source: price_series}\n"
    )
    with pytest.raises(ValueError, match="symbol"):
        signal_specs(load_weights(p))


def test_fit_config_has_the_keys_the_fit_reads():
    cfg = fit_config(load_weights(REAL_WEIGHTS))
    assert cfg["horizon_hours"] == 24
    assert cfg["multiplier_min"] == 0.25 and cfg["multiplier_max"] == 3.0
    assert cfg["ridge_alpha"] > 0 and cfg["min_rows"] > 0


def test_active_pins_drops_expired_and_keeps_live(tmp_path):
    p = tmp_path / "w.yaml"
    p.write_text(
        "themes: [other]\nsignals: []\n"
        "pins:\n"
        "  - {key: rates_dollar, value: 1.5, reason: 'cut cycle', expires: '2026-09-01'}\n"
        "  - {key: 'rsi14@1d', value: 0.5, reason: 'noisy', expires: '2026-08-01'}\n"
    )
    assert active_pins(load_weights(p), "2026-08-20") == {"rates_dollar": 1.5}


def test_active_pins_rejects_a_pin_with_no_expiry(tmp_path):
    # An un-expiring pin is how a fit quietly stops mattering: the map keeps
    # rendering, the number keeps looking measured, and nothing ever revisits
    # the judgement that froze it.
    p = tmp_path / "w.yaml"
    p.write_text(
        "themes: [other]\nsignals: []\n"
        "pins:\n  - {key: rates_dollar, value: 1.5, reason: 'cut cycle'}\n"
    )
    with pytest.raises(ValueError, match="expires"):
        active_pins(load_weights(p), "2026-08-20")


def test_active_pins_rejects_a_pin_with_no_reason(tmp_path):
    p = tmp_path / "w.yaml"
    p.write_text(
        "themes: [other]\nsignals: []\n"
        "pins:\n  - {key: rates_dollar, value: 1.5, expires: '2026-09-01'}\n"
    )
    with pytest.raises(ValueError, match="reason"):
        active_pins(load_weights(p), "2026-08-20")
