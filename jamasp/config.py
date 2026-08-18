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
    return tuple(weights["themes"])
