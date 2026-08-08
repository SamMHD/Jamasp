"""Pure text layer for news flashes: prompts, response parsing, message render.

Nothing here touches the database, the network, or a subprocess, so every
function is testable in isolation.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Sequence

# Dubai observes no DST, so a fixed offset is exact — same choice as runner.DUBAI,
# and it keeps us off a tzdata dependency.
DUBAI = timezone(timedelta(hours=4))

# Telegram's hard limit is 4096; leave headroom for the truncation marker.
MAX_CHARS = 4000

DECIDE_HEADER = """You are the news triage desk for a physical gold trading company.

POSTED lists stories already published in the last 24 hours, as id<TAB>headline.
NEW lists candidate items, as id<TAB>source<TAB>headline<TAB>lede.

For every NEW id decide two things:

1. "gold": true if the item plausibly bears on the gold market at all — gold
   prices, mining, central-bank reserves or purchases, interest rates, the
   dollar, inflation data, geopolitical risk, ETF or physical flows. false for
   single-name equity news unrelated to gold, crypto-only stories, and general
   corporate news.
2. "dup_of": the id of the story this item repeats, or null.
   - It may name a POSTED id, or the id of an EARLIER-LISTED NEW item.
   - When several NEW items cover the same story, point every one of them at
     the id of the first of those items in the NEW list.
   - A duplicate is the same underlying event, not merely the same subject.
     "Gold hits record" and "Gold pulls back from record" are two stories.
   - When unsure, use null. A duplicate message is a smaller failure than a
     suppressed story.

Respond with ONLY a JSON object mapping each NEW id to
{"gold": bool, "dup_of": id or null}. No other text.

"""

WRITE_HEADER = """You are a market analyst at a physical gold trading company in Dubai,
writing a wire flash in Persian for the trading desk.

Return ONLY a JSON object with exactly these keys:
  "title_fa"   - Persian headline, at most 10 words, no trailing punctuation.
  "summary_fa" - ONE Persian paragraph, 3-5 sentences, stating only facts
                 present in the source text below.
  "impact_fa"  - ONE Persian paragraph naming the transmission channel to the
                 gold market and the conditions that would confirm or
                 invalidate it.

Rules:
- Numbers, tickers, currencies and instrument names stay in Latin script:
  write 3,420 and CPI, never Persian-Indic digits.
- Never state a number, date, or name that does not appear in the source text.
- Do not begin impact_fa with "اثر احتمالی" — that label is added afterwards.
- No trading instructions. Describe mechanisms and conditions; never tell the
  desk to buy or sell.

"""


def _json_object(text: str) -> dict[str, Any]:
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object in response")
    parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("no JSON object in response")
    return parsed


def build_decide_prompt(
    posted: Sequence[Mapping], candidates: Sequence[Mapping]
) -> str:
    posted_block = (
        "\n".join(f"{p['id']}\t{p['title_en']}" for p in posted) or "(none)"
    )
    new_block = "\n".join(
        f"{c['id']}\t{c['source']}\t{c['headline']}\t{c['lede'] or ''}"
        for c in candidates
    )
    return f"{DECIDE_HEADER}POSTED:\n{posted_block}\n\nNEW:\n{new_block}\n"


def parse_decide_response(text: str) -> dict[str, dict]:
    verdicts = {}
    for item_id, raw in _json_object(text).items():
        if not isinstance(raw, dict):
            continue
        dup = raw.get("dup_of")
        verdicts[str(item_id)] = {
            "gold": bool(raw.get("gold")),
            "dup_of": str(dup) if dup else None,
        }
    return verdicts


def build_write_prompt(
    headline: str,
    source_label: str,
    published_at: str,
    body: str,
    lede: str | None = None,
) -> str:
    if body:
        source_block = f"ARTICLE TEXT:\n{body}"
    else:
        source_block = (
            "ARTICLE TEXT UNAVAILABLE — write from the headline and lede alone.\n"
            "Keep summary_fa to two hedged sentences and introduce no specifics.\n"
            f"LEDE: {lede or '(none)'}"
        )
    return (
        f"{WRITE_HEADER}HEADLINE: {headline}\n"
        f"SOURCE: {source_label}\n"
        f"PUBLISHED: {published_at}\n\n{source_block}\n"
    )


def parse_write_response(text: str) -> dict[str, str]:
    parsed = _json_object(text)
    fields = {}
    for key in ("title_fa", "summary_fa", "impact_fa"):
        value = parsed.get(key)
        if not value or not str(value).strip():
            raise ValueError(f"write response missing {key}")
        fields[key] = str(value).strip()
    return fields


def _dubai_hhmm(published_at: str) -> str:
    dt = datetime.strptime(published_at, "%Y-%m-%dT%H:%M:%SZ")
    return dt.replace(tzinfo=timezone.utc).astimezone(DUBAI).strftime("%H:%M")


def render_message(
    title_fa: str,
    summary_fa: str,
    impact_fa: str,
    url: str,
    published_at: str,
    source_labels: Sequence[str],
) -> str:
    text = "\n".join(
        [
            f"🟡 {title_fa}",
            "",
            summary_fa,
            "",
            f"اثر احتمالی: {impact_fa}",
            "",
            f"منابع: {' • '.join(source_labels)}",
            url,
            f"⏱ {_dubai_hhmm(published_at)} دبی",
        ]
    )
    if len(text) > MAX_CHARS:
        text = text[: MAX_CHARS - 1] + "…"
    return text
