#!/usr/bin/env python3
"""Record a TradingView / Yahoo pair for tests/test_indicators_oracle.py.

Run once, commit the fixture. The test then runs offline forever, and
re-running this refreshes it against a newer market instant.

    uv run python scripts/capture-tv-oracle.py

Both endpoints are ones Jamasp already polls: the TradingView scanner behind
`tv_gc_technicals` and the Yahoo chart API behind `gold_spot`.
"""
import json
from pathlib import Path

from jamasp.ingest.bars import DAILY_URL, parse_yahoo_bars
from jamasp.net import get_with_fallback

TV_URL = (
    "https://scanner.tradingview.com/symbol?symbol=COMEX%3AGC1!"
    "&fields=close,RSI,SMA50,SMA200,ATR&no_404=true"
)
OUT = Path("tests/fixtures/tv_oracle.json")

tv = json.loads(get_with_fallback(TV_URL).text)
bars = parse_yahoo_bars(get_with_fallback(DAILY_URL).text)

OUT.write_text(json.dumps({
    "captured_at": bars[-1].ts,
    "tv": {k: tv[k] for k in ("close", "RSI", "SMA50", "SMA200", "ATR")},
    "bars": [list(b) for b in bars],
}, indent=1))
print(f"wrote {OUT} — {len(bars)} bars, TV close {tv['close']}")
