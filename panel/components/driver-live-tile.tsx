"use client";

import { useState, type ReactNode } from "react";
import { TradingViewMiniChart } from "@/components/tradingview-mini-chart";
import type { TvEmbed } from "@/lib/tradingview";
import { cls } from "@/lib/format";

/**
 * A driver cell that upgrades from Jamasp's stored reading to a live embed.
 *
 * `children` is the server-rendered QuoteTile — passed in rather than built
 * here, so this is the only part of the Drivers card that ships to the
 * browser. It is hidden with `invisible` rather than unmounted once the
 * widget loads, so it goes on reserving exactly the height it always did:
 * the embed is positioned into that same box, and the upgrade shifts nothing
 * else on the page.
 *
 * If the embed never loads — offline, blocked, a CDN timeout — `live` stays
 * false and the reader keeps the tile they had. There is no state in which
 * this renders an empty rectangle.
 */
export function DriverLiveTile({ embed, reading, children }: {
  embed: TvEmbed;
  /** Jamasp's own reading and age, pre-formatted on the server. */
  reading: string;
  children: ReactNode;
}) {
  const [live, setLive] = useState(false);
  return (
    <div className="relative h-full">
      <div className={cls("h-full", live && "invisible")}>{children}</div>
      <div aria-hidden={!live}
        className={cls(
          "absolute inset-0 flex flex-col overflow-hidden rounded-md border border-border/60 px-2 pt-1 pb-1.5",
          !live && "pointer-events-none opacity-0")}>
        <TradingViewMiniChart embed={embed} onReady={setLive} className="min-h-0 flex-1" />
        {live && <div className="truncate text-meta text-ink-dim">{reading}</div>}
      </div>
    </div>
  );
}
