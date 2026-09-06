"use client";

import { useMemo, useState, type ReactNode } from "react";
import { TvWidget } from "@/components/tv-widget";
import {
  TV_TICKER_TAPE_SCRIPT,
  TV_TICKER_TAPE_TAG,
  tickerTapeAttributes,
} from "@/lib/tradingview";
import { cls } from "@/lib/format";

/**
 * The overview's running band, upgraded from Jamasp's stored readings to
 * TradingView's live tape.
 *
 * Same shape as the Drivers card's per-tile upgrade
 * (components/driver-live-tile.tsx): `children` is the server-rendered strip,
 * passed in rather than built here, so this file is the only part of the band
 * that ships to the browser. It is hidden with `invisible` rather than
 * unmounted once the widget arrives, so it goes on reserving exactly the
 * height it always did.
 *
 * WHAT IS DIFFERENT, AND WHY IT MATTERS HERE MORE THAN ANYWHERE ELSE
 * ------------------------------------------------------------------
 * This band is the only TradingView embed on the panel that sits ABOVE THE
 * FOLD. Two consequences the Drivers card never had to face:
 *
 *   1. The viewport gate buys nothing — the host is on screen at first paint,
 *      so an IntersectionObserver would fire immediately and the tape's script
 *      would be fetched and evaluated while React is still hydrating the rest
 *      of the page. It is gated on the main thread going quiet instead
 *      (tv-widget.tsx#TvGate "idle"), so the overview's own content is never
 *      waiting behind a third party's module.
 *   2. A box that grows when the embed lands would shove the entire page down
 *      under the reader. So the strip is a FIXED height from the server render
 *      onward — the widget's own row height at this item size, named once in
 *      lib/tradingview.ts#TV_TICKER_TAPE_HEIGHT — and the widget is positioned
 *      into that reserved box rather than adding to it.
 *
 * If the embed never loads — offline, blocked, a CDN timeout — `live` stays
 * false and the reader keeps Jamasp's own readings in the same band. There is
 * no state in which this renders an empty strip.
 */
export function TickerTape({ symbols, children }: {
  symbols: readonly string[];
  children: ReactNode;
}) {
  const [live, setLive] = useState(false);
  // The page auto-refreshes every 30s, so this re-renders with a fresh
  // `symbols` array identity on a timer. Memoising on the joined value keeps
  // the widget from being torn down and rebuilt for a list that did not
  // actually change.
  const key = symbols.join(",");
  const attributes = useMemo(() => tickerTapeAttributes(key.split(",")), [key]);

  return (
    <div className="relative h-full overflow-hidden">
      <div className={cls("h-full", live && "invisible")}>{children}</div>
      <TvWidget tag={TV_TICKER_TAPE_TAG} script={TV_TICKER_TAPE_SCRIPT}
        attributes={attributes} gate="idle" onReady={setLive}
        className={cls("absolute inset-0", !live && "pointer-events-none opacity-0")} />
    </div>
  );
}
