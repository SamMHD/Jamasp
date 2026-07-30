from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Item:
    id: str
    source: str
    published_at: str  # UTC ISO-8601 Z
    headline: str
    url: str
    topic: str
    lede: str | None = None
