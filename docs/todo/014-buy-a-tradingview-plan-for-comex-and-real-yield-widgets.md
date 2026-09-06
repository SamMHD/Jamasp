---
id: 014
title: Buy a TradingView plan so the panel's widgets can show the instruments Jamasp actually prices off
status: open
opened: 2026-09-06
owner: unassigned
closed:
---

## Problem

The panel embeds two keyless TradingView widgets — the Advanced Chart on the
overview's Technical card (`panel/components/live-chart.tsx`) and the Mini
Charts on the Drivers card (`panel/components/tradingview-mini-chart.tsx`).
Keyless embeds get no data entitlement, so three of the instruments the desk
actually reads cannot be shown and are standing in with substitutes:

| Wanted | Shipping instead | Why |
|---|---|---|
| `COMEX:GC1!` — the front-month gold future Jamasp prices off | `FX_IDC:XAUUSD` — spot | "Permission denied" in a keyless widget |
| `FRED:DFII10` — US 10y **real** yield | no widget; the tile stays Jamasp-sourced | the FRED "economic" symbol class cannot render at any interval |
| `^GSPC`, `BTC-USD` | `SPREADEX:SPX` (a CFD), `BITSTAMP:BTCUSD` (one venue) | the index/aggregate symbols are gated or absent |

This is a **purchasing decision, not a code gap** — the code already handles
every case correctly and says out loud what it is showing. The item is here so
the decision is on the record rather than rediscovered by the next person who
notices the chart says "spot".

## Why it matters

- **A standing basis gap on the hero chart.** Front-month gold trades above
  spot by the carry — tens of dollars at current levels. The Technical card
  therefore shows a live chart that will never agree with the reading beside
  it, and has to spend a line of caption explaining that the gap is basis and
  not staleness. That caption is correct, but it is a permanent tax on the
  most-read card in the panel, and a reader who skims it draws the wrong
  conclusion about feed health.
- **The single most important gold driver has no live tile.** Real yields are
  a primary driver of gold; the 10y real tile is the one cell of the Drivers
  card that cannot show a live price, so the card is mixed and the staleness
  of exactly that reading stays invisible. Substituting a nominal yield was
  considered and refused — it would silently corrupt the analysis (see
  `panel/lib/tradingview.ts`, and the test that pins `DFII10` to null).
- **Two tiles quote a different number than the brief.** SPREADEX:SPX ran
  −0.13% against Jamasp's `^GSPC` and BITSTAMP:BTCUSD −0.31% against Yahoo's
  cross-venue `BTC-USD`. Small, but the panel and the Telegram brief are
  supposed to quote the same market.

## Evidence

Probed first-hand on **2026-09-06**, mounting `<tv-mini-chart>` from
`https://widgets.tradingview-widget.com/w/en/tv-mini-chart.js` in headless
Chromium served from a real http origin, one card per symbol:

| Symbol | Rendered |
|---|---|
| `COMEX:GC1!` | **"Permission denied — This symbol is only available on TradingView"**, with a "Visit TradingView" button |
| `FRED:DFII10` | **"Unsupported interval — Unsupported interval for symbol"**, with a "Change time frame" button |
| `FX_IDC:XAUUSD` | renders: XAUUSD 4,427.900 USD −1.00%, with sparkline |
| `PEPPERSTONE:USDX` | renders: USDX 99.169 USD +0.15%, with sparkline |

Negatives already checked, so nobody re-probes them:

- Every CME-group spelling of the gold future is refused the same way:
  `COMEX:GC1!`, `COMEX_MINI:GC1!`, `CME:GC1!`, `NYMEX:GC1!`.
- Also "Permission denied" in a keyless widget: `TVC:DXY`, `TVC:VIX`,
  `SP:SPX`, `CBOE:SPX`, `CBOE:GVZ`, and the whole `ECONOMICS:*` class
  (`ECONOMICS:USINTR`, so no policy-rate row either).
  **Corrected 2026-09-06:** this line previously read "all of `TVC:*`". That
  is wrong — entitlement is per SYMBOL, not per namespace. Re-probed while
  building the /markets reference desk, `TVC:GOLD` and `TVC:UKOIL` both
  render live prices keyless, and `TVC:UKOIL` is what the watchlist now uses
  for Brent. Never infer a symbol's entitlement from its prefix; mount it.
- `INDEX:DXY` resolves but refuses every range except 6M ("Unsupported
  interval"), which is why the dollar tile is a broker feed.
- The whole FRED "economic" class is dead in the widget, not just DFII10:
  `FRED:DFII5/7/20/30` behave identically. The only quotable 10y symbols are
  **nominal** (`TVC:US10Y`, `PYTH:US10Y`, `OANDA:USB10YUSD`) and must not be
  substituted.
- Probe gotcha for whoever repeats this: the widget renders into a **closed**
  shadow root, so `shadowRoot` is null and reading text out of the DOM returns
  empty for working and broken symbols alike. Screenshot it instead — the
  first run of this probe reported all four symbols "empty" and was wrong.

Two things that are true and easy to get backwards:

- **The scanner API is not affected.** `config/sources.yaml:341` already pulls
  `COMEX:GC1!` technicals from `scanner.tradingview.com` and that endpoint
  serves them fine, keyless. The entitlement wall is specific to the *widget*
  embeds; ingest is unaffected, and buying a plan is not needed to keep the
  technicals flowing.
- **The escape hatch exists in code but is unset in config.**
  `panel/lib/tradingview.ts#liveGoldSymbol` reads
  `settings.panel.tradingview_symbol` and validates it against
  `EXCHANGE:TICKER`, falling back to the working default on anything
  unparseable. But `config/settings.yaml` has **no `panel:` key at all** today
  — the hatch is code-ready and config-absent, so repointing the chart is a
  two-line config edit and no code change.

## Fix

1. Buy a TradingView plan carrying **CME Group real-time (or delayed) data**
   and confirm the entitlement covers *widget embeds*, not only the tradingview.com
   site — that is the distinction this whole item turns on, and it should be
   confirmed before paying. Re-run the probe above while signed in.
2. Wire whatever the plan requires into the embeds. Both components load
   TradingView's public loaders today with no key
   (`panel/lib/tradingview.ts#TV_SCRIPT_SRC`, `#TV_MINI_CHART_SCRIPT`); an
   entitled embed may need an account-bound script URL or a customer id, so
   expect a small change in both components, not only in config.
3. Repoint the symbols. Exactly these:
   - `config/settings.yaml`, new top-level key — the gold chart, no code change:
     ```yaml
     panel:
       tradingview_symbol: "COMEX:GC1!"
     ```
   - `panel/lib/tradingview.ts#DRIVER_TV_EMBEDS` — the driver tiles:
     - `^GSPC`: `SPREADEX:SPX` → `SP:SPX` (the index itself, not a CFD)
     - `BTC-USD`: `BITSTAMP:BTCUSD` → a cross-venue aggregate matching Yahoo's
     - `DX-Y.NYB`: `PEPPERSTONE:USDX` → `TVC:DXY` if it renders once entitled
     - `DFII10`: add `FRED:DFII10` **only if it actually renders** — verify by
       mounting it, not by symbol search. If it still refuses, leave the tile
       Jamasp-sourced and say so in the file; the null mapping is deliberate.
4. Update the prose the substitutes forced: the Technical card's basis caption
   (`panel/components/technical-panel.tsx`), `TV_LIVE_LABEL`, and the proxy
   notes in `panel/lib/tradingview.ts`. The e2e assertions pin some of that
   text — `panel/e2e/smoke.spec.ts` and `panel/e2e/tradingview-live.spec.ts`
   will need to move with it.

## Done when

Either:

- the overview's Technical chart renders `COMEX:GC1!` and its caption no
  longer needs a carry-premium disclaimer, and the Drivers card shows a live
  tile for every driver it can (with `DFII10` either live or still explicitly
  null with the refusal re-verified under the paid plan); or
- **abandoned**, with the plan's actual price recorded here against the three
  consequences above. A legitimate outcome: the substitutes are labelled and
  honest, the analysis is not wrong, and the only real cost is a caption and
  two tiles that are ~0.2% off. This should be abandoned rather than left open
  if the entitlement turns out not to cover widget embeds.

## Related

- `panel/lib/tradingview.ts` — every symbol decision and why, for both widgets.
- `panel/test/tradingview.test.ts` — pins `DFII10` to null, and the gold
  symbol out of the drivers table.
- `docs/todo/003-tradingview-weekly-4h-fields-return-null-for-gold.md` — a
  different TradingView gap, on the scanner side, which a plan would **not**
  fix.
- `config/sources.yaml:341` — the scanner pull that already reads `COMEX:GC1!`.
