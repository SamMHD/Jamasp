"""Cross-check our indicators against TradingView's own numbers.

This is what makes "we compute them ourselves" a checkable claim rather than
a second implementation nobody can compare.

The two series are NOT identical instruments: TradingView reads COMEX:GC1!,
a continuous front-month contract, while our bars are Yahoo's GC=F. Roll
conventions and session boundaries differ, so the tolerances below are wide
on purpose. They are wide enough to survive that difference and far too tight
to survive a wrong smoothing constant, an off-by-one window, or a close-stamped
bar — which is exactly the class of error this test exists to catch.
"""
import json
from pathlib import Path

import pytest

from jamasp import indicators as ind
from jamasp.ingest.bars import Bar

FIXTURE = Path(__file__).parent / "fixtures" / "tv_oracle.json"


@pytest.fixture(scope="module")
def oracle():
    if not FIXTURE.exists():
        pytest.skip("run scripts/capture-tv-oracle.py to record the fixture")
    raw = json.loads(FIXTURE.read_text())
    return raw["tv"], [Bar(*b) for b in raw["bars"]]


def test_our_close_tracks_tradingviews(oracle):
    tv, bars = oracle
    assert bars[-1].close == pytest.approx(tv["close"], rel=0.02)


def test_rsi14_agrees_with_tradingview(oracle):
    tv, bars = oracle
    ours = ind.rsi(bars, 14)[-1]
    # RSI is bounded 0-100. 8 points is roughly the spread two different
    # front-month series produce; a wrong smoother moves it by 20+.
    assert ours == pytest.approx(tv["RSI"], abs=8.0)


def test_sma50_and_sma200_agree_with_tradingview(oracle):
    tv, bars = oracle
    closes = [b.close for b in bars]
    assert ind.sma(closes, 50)[-1] == pytest.approx(tv["SMA50"], rel=0.02)
    assert ind.sma(closes, 200)[-1] == pytest.approx(tv["SMA200"], rel=0.02)


def test_atr14_agrees_with_tradingview(oracle):
    tv, bars = oracle
    # ATR is the loosest of the four: it reads highs and lows, which is where
    # two different contracts' session definitions diverge most.
    assert ind.atr(bars, 14)[-1] == pytest.approx(tv["ATR"], rel=0.35)
