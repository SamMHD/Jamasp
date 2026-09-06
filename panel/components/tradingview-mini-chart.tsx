"use client";

import { useMemo } from "react";
import { TvWidget } from "@/components/tv-widget";
import {
  TV_MINI_CHART_SCRIPT,
  TV_MINI_CHART_TAG,
  type TvEmbed,
} from "@/lib/tradingview";

/**
 * One TradingView Mini Chart web component, mounted lazily.
 *
 * All the machinery this used to carry — the loader singleton, the viewport
 * gate, the define timeout, the theme bridge — now lives in
 * components/tv-widget.tsx, because the overview's Ticker Tape needs exactly
 * the same four things and a second copy of them would be a second set of
 * bugs. What is left here is the part that is specific to this widget: which
 * attributes a Mini Chart takes, and that the Drivers card is below the fold
 * and therefore gated on the viewport rather than on the main thread going
 * quiet.
 *
 * This component renders NOTHING on the server and nothing until it has a
 * live widget. The caller supplies its own fallback and keeps it visible
 * until `onReady` fires, so a blocked, offline or failed embed leaves the
 * page exactly as it was rather than punching a hole in it.
 */
export function TradingViewMiniChart({ embed, onReady, className }: {
  embed: TvEmbed;
  /** Fires once the widget element is in the DOM, so the caller can retire its fallback. */
  onReady?: (ready: boolean) => void;
  className?: string;
}) {
  const attributes = useMemo(() => ({
    symbol: embed.symbol,
    "time-frame": embed.timeFrame,
    // Lets the tile's own background show through, so the widget cells and
    // the Jamasp-sourced cell share one surface.
    transparent: "",
  }), [embed.symbol, embed.timeFrame]);

  // The Drivers card sits well below the fold on the overview, so nothing
  // about TradingView — script, chunks, sockets — is fetched until the reader
  // actually scrolls to it.
  return (
    <TvWidget tag={TV_MINI_CHART_TAG} script={TV_MINI_CHART_SCRIPT}
      attributes={attributes} gate="viewport" onReady={onReady} className={className} />
  );
}
