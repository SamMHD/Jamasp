"""Load declarative source and settings config."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass(frozen=True)
class Source:
    name: str
    type: str  # rss | price_api  (calendar arrives in phase 2)
    url: str
    interval_minutes: int
    topic: str
    parser: str | None = None


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
        )
        for e in raw["sources"]
    ]


def load_settings(path: Path = Path("config/settings.yaml")) -> dict:
    return yaml.safe_load(path.read_text())
