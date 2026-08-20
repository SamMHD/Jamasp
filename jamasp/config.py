"""Load declarative source and settings config."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass(frozen=True)
class Source:
    name: str
    type: str  # rss | price_api | technicals_api | calendar
    url: str
    interval_minutes: int
    topic: str
    parser: str | None = None
    # overrides the parser-derived series symbol; needed where the payload's
    # own symbol is unstable (Yahoo FX pairs)
    symbol: str | None = None
    # human-readable label for Telegram flash "منابع:" lines
    display: str | None = None


def load_sources(path: Path = Path("config/sources.yaml")) -> list[Source]:
    raw = yaml.safe_load(path.read_text())
    return [
        Source(
            name=e["name"],
            type=e["type"],
            url=e["url"],
            interval_minutes=e["interval_minutes"],
            topic=e["topic"],
            parser=e.get("parser"),
            symbol=e.get("symbol"),
            display=e.get("display"),
        )
        for e in raw["sources"]
    ]


def load_settings(path: Path = Path("config/settings.yaml")) -> dict:
    return yaml.safe_load(path.read_text())


def display_names(sources: list[Source]) -> dict[str, str]:
    """Map source name to the label shown to humans."""
    return {
        s.name: s.display or s.name.replace("_", " ").title() for s in sources
    }


def load_weights(path: Path = Path("config/weights.yaml")) -> dict:
    return yaml.safe_load(path.read_text())


def themes(weights: dict) -> tuple[str, ...]:
    """The fundamental map's theme slots, in configured order.

    Order is data, not presentation: Plan 2's fit indexes its feature columns
    by position, so sorting or de-duplicating here would permute fitted
    coefficients against their labels.
    """
    slots = tuple(weights["themes"])
    # jamasp/flashtext.py's _theme() falls back to the literal "other" for any
    # theme the model doesn't name, and Plan 2 indexes theme columns
    # positionally — so a retro that drops or misspells this slot must fail
    # loudly here, not let the fallback silently write a value outside the
    # configured set and corrupt every score from that point on.
    if "other" not in slots:
        raise ValueError(f'config/weights.yaml themes must include "other", got {slots!r}')
    return slots


VALID_SIGNAL_SOURCES = ("bars", "price_series")


@dataclass(frozen=True)
class SignalSpec:
    name: str
    family: str
    timeframes: tuple[str, ...]
    source: str
    symbol: str | None = None


def tier_weights(weights: dict) -> dict[int, float]:
    """Materiality tier -> area weight, mirroring panel/lib/marketmap.ts."""
    return {int(k): float(v) for k, v in weights["tier_weight"].items()}


def signal_specs(weights: dict) -> tuple[SignalSpec, ...]:
    """The technical taxonomy, in declared order.

    Order is data, exactly as it is for `themes`: the fit indexes its feature
    columns by position, so sorting here would permute fitted coefficients
    against their labels. Duplicates and unknown sources raise rather than
    silently collapsing two columns into one or reaching for a reader that
    does not exist.
    """
    specs: list[SignalSpec] = []
    seen: set[str] = set()
    for e in weights.get("signals") or []:
        name = e["name"]
        if name in seen:
            raise ValueError(f"duplicate signal name in config/weights.yaml: {name!r}")
        seen.add(name)
        source = e.get("source", "bars")
        if source not in VALID_SIGNAL_SOURCES:
            raise ValueError(
                f"signal {name!r} has source {source!r};"
                f" expected one of {VALID_SIGNAL_SOURCES}"
            )
        if source == "price_series" and not e.get("symbol"):
            raise ValueError(f"signal {name!r} reads a price series but names no symbol")
        specs.append(SignalSpec(
            name=name, family=e["family"],
            timeframes=tuple(e["timeframes"]), source=source,
            symbol=e.get("symbol"),
        ))
    return tuple(specs)


def signal_columns(weights: dict) -> tuple[str, ...]:
    """Ordered feature-column keys, "<signal>@<timeframe>"."""
    return tuple(
        f"{s.name}@{tf}" for s in signal_specs(weights) for tf in s.timeframes
    )


def fit_config(weights: dict) -> dict:
    return weights["fit"]


def active_pins(weights: dict, today: str) -> dict[str, float]:
    """Retro overrides still in force on `today` (an ISO date, YYYY-MM-DD).

    Every pin must carry a reason and an expiry. An un-expiring pin is how a
    fit quietly stops mattering — the number keeps looking measured while
    nothing ever revisits the judgement that froze it — so this refuses one
    rather than honouring it.
    """
    out: dict[str, float] = {}
    for p in weights.get("pins") or []:
        key = p.get("key")
        if not p.get("reason"):
            raise ValueError(f"pin {key!r} has no reason")
        if not p.get("expires"):
            raise ValueError(f"pin {key!r} has no expires date")
        if str(p["expires"]) > today:
            out[key] = float(p["value"])
    return out
