import type { CSSProperties } from "react";
import Link from "next/link";
import { QuoteTile } from "@/components/quote-tile";
import { DriverLiveTile } from "@/components/driver-live-tile";
import type { DriverRead } from "@/lib/drivers";
import { tvEmbedFor, TV_THEME_TOKENS } from "@/lib/tradingview";
import { fmtAge } from "@/lib/format";

/**
 * The cross-asset complex that moves gold.
 *
 * Each cell is a live TradingView Mini Chart laid over the Jamasp tile that
 * used to be the whole story. The Jamasp tile is still what renders on the
 * server and still what a reader sees if the embed never arrives, so every
 * honest-absence behaviour the card was built around survives untouched — a
 * symbol with no rows says "no data", a frozen feed says "24h —", a single
 * print draws no trend line. The widget is an upgrade layered on top, never
 * a replacement for the guarantee.
 *
 * One driver has no widget at all: the 10-year REAL yield is a TIPS series
 * TradingView cannot serve through a free embed, and no nominal yield may be
 * quietly substituted for it. That tile stays Jamasp's. See lib/tradingview.ts
 * for the full symbol resolution and why the mixed card is the correct outcome.
 *
 * This stays a server component: only the thin overlay wrapper is a client
 * component, so QuoteTile and the sparkline never reach the browser bundle.
 */
export function DriverPanel({ drivers, now }: { drivers: DriverRead[]; now: Date }) {
  return (
    <section aria-label="Drivers" className="@container rounded border border-border p-4"
      style={TV_THEME_TOKENS as CSSProperties}>
      <h2 className="mb-3 font-medium">
        Drivers
        <Link className="ml-2 text-xs font-normal text-primary" href="/prices">→ prices</Link>
      </h2>
      {/* Uniform row height, and it is load-bearing rather than cosmetic: a
          "no data" tile is only two lines tall, and an embed positioned into
          a box that short collapses into its own attribution strip. Fixing
          the row sizes every cell for the widget — the height the tiles
          already had — so the Jamasp-sourced cell and the live cells stay the
          same shape and nothing reflows when an embed arrives.

          Column count is a CONTAINER query, not a viewport one, because what
          decides whether a tile fits is the width of this card — it sits in a
          2-of-5 column on the overview — and not the width of the window.
          The breakpoints are measured, not guessed: the Mini Chart drops its
          chart below 200px of tile and starts clipping the change below
          ~150px, so each step is the card width at which the next column
          still leaves every tile over 200px. Three across is the layout on a
          desk monitor, where the card has the room; narrower, the card would
          rather show two tiles with sparklines than three without. */}
      <div className="grid grid-cols-1 gap-3 [grid-auto-rows:9.5rem] @[30rem]:grid-cols-2 @[42rem]:grid-cols-3">
        {drivers.map(d => {
          const tile = (
            <QuoteTile className="h-full" label={d.label} value={d.quote?.value ?? null}
              digits={d.digits} ts={d.quote?.ts ?? null} delta={d.delta24h}
              series={d.series} now={now} />
          );
          const embed = tvEmbedFor(d.symbol);
          if (embed === null) return <div key={d.symbol} className="h-full">{tile}</div>;
          return (
            <DriverLiveTile key={d.symbol} embed={embed} reading={jamaspReading(d, now)}>
              {tile}
            </DriverLiveTile>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Provenance line shown under a live embed.
 *
 * The widget states change as a percent and carries no age, while this card's
 * own deltas are absolute because a percent-of-value is meaningless on a
 * yield (lib/drivers.ts). Keeping Jamasp's own reading and its age on screen
 * preserves both, and makes a stale feed *visible* — a live price sitting
 * above a 25h-old Jamasp number is the honest picture, and staleness hidden
 * behind a confident figure was the reason this card got live data at all.
 *
 * Formatted here, on the server, so the client wrapper takes a plain string
 * and neither `now` nor the number formatting crosses into the bundle.
 */
function jamaspReading(d: DriverRead, now: Date): string {
  const q = d.quote;
  if (!q) return "jamasp: no data";
  const v = q.value.toLocaleString(undefined, { maximumFractionDigits: d.digits });
  return `jamasp ${v} · ${fmtAge(q.ts, now)}`;
}
