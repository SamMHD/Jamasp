"""Indicator math over an OHLC bar series. Pure: no I/O, no config.

TradingView serves these values at one instant and cannot backfill, so the
fit — which needs a history of states — has to compute them itself.
tests/test_indicators_oracle.py cross-checks the daily set against
TradingView's own numbers, which is what makes "we compute them ourselves"
a checkable claim rather than a second implementation nobody can compare.

Two smoothing conventions appear below and must not be conflated. `ema` is
the classic alpha = 2/(n+1) exponential average, used by MACD. `_wilder` is
alpha = 1/n seeded with a simple average of the first n values, which is what
RSI, ATR and ADX are defined against. Substituting one for the other produces
curves that look entirely plausible and disagree with every chart.
"""
from __future__ import annotations

from statistics import pstdev

from jamasp.ingest.bars import Bar

INDICATOR_KEYS = (
    "close", "sma50", "sma200", "rsi14", "atr14", "macd", "macd_signal",
    "adx", "stoch_k", "stoch_d", "willr", "bb_upper", "bb_lower",
    "fib618", "fib50", "pivot_r1", "pivot_s1",
)


def sma(values: list[float], n: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if n <= 0:
        return out
    running = 0.0
    for i, v in enumerate(values):
        running += v
        if i >= n:
            running -= values[i - n]
        if i >= n - 1:
            out[i] = running / n
    return out


def ema(values: list[float], n: int) -> list[float | None]:
    """alpha = 2/(n+1), seeded with the simple average of the first n values."""
    out: list[float | None] = [None] * len(values)
    if n <= 0 or len(values) < n:
        return out
    alpha = 2.0 / (n + 1)
    prev = sum(values[:n]) / n
    out[n - 1] = prev
    for i in range(n, len(values)):
        prev = alpha * values[i] + (1 - alpha) * prev
        out[i] = prev
    return out


def _wilder(values: list[float], n: int) -> list[float | None]:
    """alpha = 1/n, seeded with the simple average of the first n values."""
    out: list[float | None] = [None] * len(values)
    if n <= 0 or len(values) < n:
        return out
    prev = sum(values[:n]) / n
    out[n - 1] = prev
    for i in range(n, len(values)):
        prev = prev + (values[i] - prev) / n
        out[i] = prev
    return out


def stdev(values: list[float], n: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    for i in range(n - 1, len(values)):
        out[i] = pstdev(values[i - n + 1 : i + 1])
    return out


def rsi(bars: list[Bar], n: int = 14) -> list[float | None]:
    closes = [b.close for b in bars]
    gains = [0.0] + [max(0.0, closes[i] - closes[i - 1]) for i in range(1, len(closes))]
    losses = [0.0] + [max(0.0, closes[i - 1] - closes[i]) for i in range(1, len(closes))]
    # Skip index 0: it has no prior close, so its 0.0 is padding rather than a
    # measurement, and averaging it in would bias the first real reading.
    avg_gain = _wilder(gains[1:], n)
    avg_loss = _wilder(losses[1:], n)
    out: list[float | None] = [None] * len(bars)
    for i in range(1, len(bars)):
        g, loss = avg_gain[i - 1], avg_loss[i - 1]
        if g is None or loss is None:
            continue
        if g == 0 and loss == 0:
            # A flat tape has no momentum either way. 100 would be the
            # unbroken-rise answer applied to a series that never rose.
            out[i] = 50.0
        elif loss == 0:
            # Unbroken rise: RS is unbounded and RSI pins at 100, which is
            # the definition, not a divide-by-zero to dodge.
            out[i] = 100.0
        else:
            out[i] = 100.0 - 100.0 / (1 + g / loss)
    return out


def _true_ranges(bars: list[Bar]) -> list[float]:
    tr = [bars[0].high - bars[0].low] if bars else []
    for i in range(1, len(bars)):
        prev_close = bars[i - 1].close
        tr.append(max(bars[i].high - bars[i].low,
                      abs(bars[i].high - prev_close),
                      abs(bars[i].low - prev_close)))
    return tr


def atr(bars: list[Bar], n: int = 14) -> list[float | None]:
    return _wilder(_true_ranges(bars), n)


def macd(bars: list[Bar], fast: int = 12, slow: int = 26, signal: int = 9
         ) -> tuple[list[float | None], list[float | None]]:
    closes = [b.close for b in bars]
    f, s = ema(closes, fast), ema(closes, slow)
    line: list[float | None] = [
        None if f[i] is None or s[i] is None else f[i] - s[i]
        for i in range(len(closes))
    ]
    # The signal line is an EMA of the MACD line, which only exists from the
    # slow EMA's warm-up onward; feeding the Nones in as zeros would drag it
    # toward zero for the first `signal` bars of real data.
    live = [v for v in line if v is not None]
    sig_live = ema(live, signal)
    sig: list[float | None] = [None] * len(closes)
    offset = len(closes) - len(live)
    for i, v in enumerate(sig_live):
        sig[offset + i] = v
    return line, sig


def adx(bars: list[Bar], n: int = 14) -> list[float | None]:
    out: list[float | None] = [None] * len(bars)
    if len(bars) < 2:
        return out
    plus_dm, minus_dm = [0.0], [0.0]
    for i in range(1, len(bars)):
        up = bars[i].high - bars[i - 1].high
        down = bars[i - 1].low - bars[i].low
        plus_dm.append(up if up > down and up > 0 else 0.0)
        minus_dm.append(down if down > up and down > 0 else 0.0)
    tr = _true_ranges(bars)
    atr_s = _wilder(tr[1:], n)
    plus_s = _wilder(plus_dm[1:], n)
    minus_s = _wilder(minus_dm[1:], n)

    dx: list[float] = []
    dx_index: list[int] = []
    for i in range(1, len(bars)):
        a, p, m = atr_s[i - 1], plus_s[i - 1], minus_s[i - 1]
        if a is None or p is None or m is None or a == 0:
            continue
        pdi, mdi = 100 * p / a, 100 * m / a
        total = pdi + mdi
        dx.append(0.0 if total == 0 else 100 * abs(pdi - mdi) / total)
        dx_index.append(i)

    smoothed = _wilder(dx, n)
    for k, v in enumerate(smoothed):
        if v is not None:
            out[dx_index[k]] = v
    return out


def stochastic(bars: list[Bar], k: int = 14, d: int = 3
               ) -> tuple[list[float | None], list[float | None]]:
    k_line: list[float | None] = [None] * len(bars)
    for i in range(k - 1, len(bars)):
        window = bars[i - k + 1 : i + 1]
        hi = max(b.high for b in window)
        lo = min(b.low for b in window)
        # A flat window has no range to place the close within; 50 is the
        # honest "neither" rather than a division by zero.
        k_line[i] = 50.0 if hi == lo else 100 * (bars[i].close - lo) / (hi - lo)
    live = [v for v in k_line if v is not None]
    d_live = sma(live, d)
    d_line: list[float | None] = [None] * len(bars)
    offset = len(bars) - len(live)
    for i, v in enumerate(d_live):
        d_line[offset + i] = v
    return k_line, d_line


def williams_r(bars: list[Bar], n: int = 14) -> list[float | None]:
    out: list[float | None] = [None] * len(bars)
    for i in range(n - 1, len(bars)):
        window = bars[i - n + 1 : i + 1]
        hi = max(b.high for b in window)
        lo = min(b.low for b in window)
        out[i] = -50.0 if hi == lo else -100 * (hi - bars[i].close) / (hi - lo)
    return out


def bollinger(bars: list[Bar], n: int = 20, k: float = 2.0
              ) -> tuple[list[float | None], list[float | None]]:
    closes = [b.close for b in bars]
    mid, sd = sma(closes, n), stdev(closes, n)
    upper = [None if mid[i] is None else mid[i] + k * sd[i] for i in range(len(closes))]
    lower = [None if mid[i] is None else mid[i] - k * sd[i] for i in range(len(closes))]
    return upper, lower


def fib_levels(bars: list[Bar], lookback: int = 100
               ) -> tuple[list[float | None], list[float | None]]:
    """Retracements of the lookback range, measured DOWN from its high."""
    f618: list[float | None] = [None] * len(bars)
    f50: list[float | None] = [None] * len(bars)
    for i in range(lookback - 1, len(bars)):
        window = bars[i - lookback + 1 : i + 1]
        hi = max(b.high for b in window)
        lo = min(b.low for b in window)
        f618[i] = hi - 0.618 * (hi - lo)
        f50[i] = hi - 0.5 * (hi - lo)
    return f618, f50


def pivots(bars: list[Bar]) -> tuple[list[float | None], list[float | None]]:
    """Classic R1/S1 from the PREVIOUS bar.

    Reading the current bar would be lookahead: a pivot is a level you trade
    the next session against, not one you knew while the session was forming.
    """
    r1: list[float | None] = [None] * len(bars)
    s1: list[float | None] = [None] * len(bars)
    for i in range(1, len(bars)):
        prev = bars[i - 1]
        p = (prev.high + prev.low + prev.close) / 3
        r1[i] = 2 * p - prev.low
        s1[i] = 2 * p - prev.high
    return r1, s1


def compute_all(bars: list[Bar]) -> list[dict[str, float | None]]:
    """One dict per bar, every INDICATOR_KEYS key present (None during warm-up)."""
    if not bars:
        return []
    closes = [b.close for b in bars]
    macd_line, macd_sig = macd(bars)
    k_line, d_line = stochastic(bars)
    bb_u, bb_l = bollinger(bars)
    f618, f50 = fib_levels(bars)
    r1, s1 = pivots(bars)
    cols = {
        "close": list(closes), "sma50": sma(closes, 50), "sma200": sma(closes, 200),
        "rsi14": rsi(bars), "atr14": atr(bars), "macd": macd_line,
        "macd_signal": macd_sig, "adx": adx(bars), "stoch_k": k_line,
        "stoch_d": d_line, "willr": williams_r(bars), "bb_upper": bb_u,
        "bb_lower": bb_l, "fib618": f618, "fib50": f50,
        "pivot_r1": r1, "pivot_s1": s1,
    }
    return [{key: cols[key][i] for key in INDICATOR_KEYS} for i in range(len(bars))]
