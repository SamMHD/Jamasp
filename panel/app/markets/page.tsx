import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/ui/panel";
import {
  HeatmapWidget, NewsWidget, ScreenerWidget, SeasonalChartWidget,
  WatchlistWidget, WorldMarketSummaryWidget,
} from "@/components/tradingview-embed";
import { JAMASP_WATCHLIST } from "@/lib/tradingview";

export const dynamic = "force-dynamic";

/**
 * The reference desk: live third-party market data, kept deliberately apart
 * from Jamasp's own analysis.
 *
 * WHY THIS IS A SEPARATE PAGE
 * ---------------------------
 * Every other route in this panel shows something Jamasp produced — a scored
 * story, a fitted weight, a stance, a prediction with a falsifier. This one
 * shows what other people's screens show. Mixing the two on the overview
 * would have been easier and much worse: a reader who cannot tell whose read
 * they are looking at has lost the thing the panel is for. So the boundary is
 * a route boundary, the header says whose data this is, and every card names
 * what it is FOR rather than just what it is.
 *
 * The rule each card had to pass to be here: does it tell the desk something
 * Jamasp does not already tell them better? Two requested widgets did not.
 * The economic calendar did, but belongs next to Jamasp's own — it is on
 * /calendar. See lib/tradingview.ts#TV_REFUSED_WIDGETS and the sibling
 * comments there for the arguments.
 *
 * There is NO Jamasp data on this page — no database read, no state file — so
 * it is also the cheapest route in the panel to render and the most expensive
 * to paint. Every widget below the first is gated on an IntersectionObserver
 * (components/tradingview-embed.tsx), so a reader who never scrolls pays for
 * one.
 */

/** One reference card: a heading, why it is here, and the widget. */
function Reference({ title, purpose, jamasp, children }: {
  title: string;
  /** What this widget is for on a gold desk. */
  purpose: React.ReactNode;
  /** How it relates to Jamasp's own work — the anti-confusion line. */
  jamasp?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Panel
      title={title}
      aria-label={title}
      footer={
        <>
          <span className="text-ink-dim">Source: TradingView, live.</span>{" "}
          {jamasp}
        </>
      }
    >
      <p className="mb-3 text-body text-muted-foreground">{purpose}</p>
      {children}
    </Panel>
  );
}

export default function MarketsPage() {
  return (
    <div>
      {/* No AutoRefresh: every widget here holds its own live connection and
          streams on its own. A router refresh would tear all six down and
          rebuild them on a timer, which is the opposite of what they need. */}
      <PageHeader
        title="Markets"
        subtitle="Third-party reference data from TradingView — not Jamasp's analysis"
      />

      <Panel tone="warn" className="mb-4">
        <p className="text-body">
          Everything on this page is <strong>TradingView&rsquo;s data and
          TradingView&rsquo;s framing</strong>, mounted for breadth. None of it
          is scored, weighted or fitted by Jamasp, and none of it feeds the
          brief. Jamasp&rsquo;s own read lives on{" "}
          <Link href="/" className="text-primary underline">Overview</Link>{" "}
          (market map, technical map, drivers) and{" "}
          <Link href="/inbox" className="text-primary underline">Inbox</Link>.
        </p>
        <p className="mt-2 text-meta text-ink-dim">
          Keyless embeds carry no data entitlement, so US equity and ETF rows
          are delayed, index rows are broker CFDs rather than the index, and
          three instruments the desk actually reads have no live row at all —
          the 10-year <em>real</em> yield, gold implied vol (GVZ) and the COMEX
          front-month contract. Jamasp reads all three from its own sources;
          they are missing here, not missing everywhere. See docs/todo/014.
        </p>
      </Panel>

      <div className="space-y-4">
        <Reference
          title="Watchlist — gold and its drivers"
          purpose={
            <>
              Live prices for the twenty instruments behind Jamasp&rsquo;s
              analysis, grouped under the same theme headings the market map
              sorts news into. The map says which theme the <em>news</em> is
              moving; this says what the <em>prices</em> in that theme are
              doing.
            </>
          }
          jamasp={
            <>
              The overview&rsquo;s Drivers card carries six of these as{" "}
              <em>stored</em> readings with an age on each — that is
              Jamasp&rsquo;s number. These are live and unattributed.
            </>
          }
        >
          <WatchlistWidget />
          <dl className="mt-3 space-y-1">
            {JAMASP_WATCHLIST.map(g => (
              <div key={g.name} className="text-meta text-ink-dim">
                <dt className="inline font-medium text-muted-foreground">{g.name}</dt>
                <dd className="inline"> — {g.provenance}</dd>
              </div>
            ))}
          </dl>
        </Reference>

        <Reference
          title="Gold seasonality"
          purpose={
            <>
              Five years of spot gold overlaid on a calendar-month axis, with
              the average. Gold&rsquo;s seasonal shape is a physical-demand
              phenomenon — Indian festival and wedding buying, Chinese New Year
              restocking — not a chart artefact, and it is the one thing here
              Jamasp cannot draw: its stored bars do not reach back far enough.
            </>
          }
          jamasp="Context for a position, never a reason for one — a past average is not a forecast."
        >
          <SeasonalChartWidget />
        </Reference>

        <Reference
          title="World market summary"
          purpose={
            <>
              Country-level equity index performance, as a map or a ranked
              list. The risk picture with geography attached: on a risk-off day
              this is where you see whether the selling is broad or local.
            </>
          }
        >
          <WorldMarketSummaryWidget />
        </Reference>

        <Reference
          title="S&P 500 heatmap"
          purpose={
            <>
              The equity market&rsquo;s risk temperature, by sector and weight.
              Jamasp carries the S&amp;P as a single number in its driver
              complex; this is that number decomposed, which is what tells you
              which story a joint gold/equity move actually was.
            </>
          }
          jamasp="A US equity read, not a gold instrument. The dataset selector is live — retuning it breaks nothing."
        >
          <HeatmapWidget />
        </Reference>

        <Reference
          title="FX screener"
          purpose={
            <>
              Majors and minors ranked across seven horizons. Gold is a dollar
              trade, and Jamasp stores exactly one FX cross (USD/JPY) and one
              dollar index — so how the dollar is doing against everything else
              is breadth available nowhere else on this panel.
            </>
          }
          jamasp={
            <>
              Pointed at forex rather than stocks on purpose: the equity
              screener cannot be scoped to gold, and its default columns carry
              TradingView&rsquo;s buy/sell technical rating, which this desk
              does not display.
            </>
          }
        >
          <ScreenerWidget />
        </Reference>

        <Reference
          title="TradingView gold commentary"
          purpose={
            <>
              TradingView&rsquo;s own editorial notes on XAU/USD — roughly
              weekly, a handful of items a month. An outside view: somebody
              else&rsquo;s framing of the same tape, which is worth most
              exactly when Jamasp&rsquo;s stance has gone unchallenged for a
              while.
            </>
          }
          jamasp={
            <>
              <strong>This is not the news feed.</strong> Jamasp runs ~20
              sources through dedupe, five-tier triage and a gold-impact score
              — that is{" "}
              <Link href="/inbox" className="text-primary underline">Inbox</Link>{" "}
              and the market map, and it is both faster and scored. This is a
              second opinion, not a wire.
            </>
          }
        >
          <NewsWidget />
        </Reference>
      </div>

      <Panel className="mt-4" title="Not shown, and why">
        <ul className="space-y-2 text-body text-muted-foreground">
          <li>
            <strong className="text-foreground">
              TradingView&rsquo;s Technical Analysis widget.
            </strong>{" "}
            It renders an aggregate &ldquo;Strong sell / Sell / Neutral / Buy /
            Strong buy&rdquo; gauge. Jamasp&rsquo;s ingest deliberately refuses
            to store TradingView&rsquo;s aggregate recommendation fields —
            technicals annotate the macro read, they must not originate calls —
            and the desk does not take trading instructions from a dial.{" "}
            <Link href="/" className="text-primary underline">
              Jamasp&rsquo;s own technical map
            </Link>{" "}
            shows ridge-fitted signal states instead: a weighted description of
            where the market is, not a verdict on what to do about it.
          </li>
          <li>
            <strong className="text-foreground">
              TradingView&rsquo;s economic calendar
            </strong>{" "}
            is shipped, but on{" "}
            <Link href="/calendar" className="text-primary underline">Calendar</Link>,
            beneath Jamasp&rsquo;s own event list. Jamasp&rsquo;s calendar is
            what it is <em>watching</em> and only reaches the end of the current
            week; TradingView&rsquo;s is reference data that sees past that
            edge. They belong side by side, clearly labelled, rather than on
            separate pages.
          </li>
        </ul>
      </Panel>
    </div>
  );
}
