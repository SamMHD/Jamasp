import type { CSSProperties } from "react";
import { TickerTape } from "@/components/ticker-tape";
import { Delta } from "@/components/quote-tile";
import type { DriverRead } from "@/lib/drivers";
import {
  TV_THEME_TOKENS, TV_TICKER_TAPE_HEIGHT, tickerTapeSymbols, tvEmbedFor,
} from "@/lib/tradingview";

/**
 * The band across the top of the overview: the driver complex as a glance.
 *
 * Same instruments as the Drivers card further down, in the same order, from
 * the same list — components/driver-panel.tsx renders them as tiles you read,
 * this renders them as a line you scan on the way past. lib/tradingview.ts
 * #tickerTapeSymbols derives both the membership and the order from the
 * driver specs, so the two can never disagree about what "the complex" is.
 *
 * WHAT IS IN THE BAND, AND WHAT IS NOT
 * ------------------------------------
 * The five drivers TradingView can actually quote. The 10-year REAL yield is
 * absent for the reason it is absent from the Mini Charts — no free-widget
 * symbol exists and no nominal yield may stand in for it — and it is absent
 * from the fallback below too, deliberately: a strip that carried six
 * readings and then silently dropped to five when the embed landed would
 * make gold's most important driver look like something that flickers. It
 * gets a tile in the Drivers card, which is where it can be labelled.
 *
 * Gold itself is also absent, which is less obvious. The panel's live gold
 * chart carries SPOT while Jamasp prices the front-month FUTURE, and the
 * standing carry premium between them is stated in three places on the
 * technical card so it can never be misread as staleness. A bare spot figure
 * at the very top of the page, with no room for that sentence and the futures
 * hero a screen below it, would re-manufacture exactly the confusion that
 * disclosure exists to prevent.
 *
 * This stays a server component: only the thin upgrade wrapper is a client
 * component, so the readings below are in the HTML at first paint.
 */
export function DriverTape({ drivers }: { drivers: DriverRead[] }) {
  const quoted = drivers.filter(d => tvEmbedFor(d.symbol) !== null);
  const symbols = tickerTapeSymbols(quoted.map(d => d.symbol));
  // No mapped drivers at all means no tape and no reserved band — an empty
  // 48px rule across the top of the page would be worse than nothing.
  if (symbols.length === 0) return null;

  return (
    <section aria-label="Driver tape"
      className="mb-4 rounded border border-border"
      style={{ ...(TV_THEME_TOKENS as CSSProperties), height: TV_TICKER_TAPE_HEIGHT }}>
      <TickerTape symbols={symbols}>
        {/* The fallback, and the first paint. Horizontal scroll rather than a
            wrap or a clip: the band's height is fixed (the widget lands in
            it), so a second row is not available, and silently cutting the
            last two drivers off the edge of a phone would be a worse answer
            than letting the reader push them into view. */}
        <div className="flex h-full items-center gap-4 overflow-x-auto whitespace-nowrap px-3">
          {quoted.map(d => (
            <div key={d.symbol} className="flex shrink-0 items-baseline gap-1.5">
              <span className="text-meta uppercase text-ink-dim">{d.label}</span>
              <span className="text-sm font-medium tabular-nums">
                {d.quote === null
                  ? "—"
                  : d.quote.value.toLocaleString(undefined, { maximumFractionDigits: d.digits })}
              </span>
              {d.quote !== null && (
                <span className="text-xs">
                  <Delta delta={d.delta24h} digits={d.digits} label="" />
                </span>
              )}
            </div>
          ))}
        </div>
      </TickerTape>
    </section>
  );
}
