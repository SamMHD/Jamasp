import Link from "next/link";
import { QuoteTile } from "@/components/quote-tile";
import type { DriverRead } from "@/lib/drivers";

/**
 * The cross-asset complex that moves gold: one QuoteTile per driver.
 * Every honest-absence behaviour lives in the tile — a symbol with no
 * rows says "no data", a frozen feed says "24h —", a single print draws
 * no trend line — so this panel stays a dumb grid on purpose.
 */
export function DriverPanel({ drivers, now }: { drivers: DriverRead[]; now: Date }) {
  return (
    <section aria-label="Drivers" className="rounded border border-border p-4">
      <h2 className="mb-3 font-medium">
        Drivers
        <Link className="ml-2 text-xs font-normal text-primary" href="/prices">→ prices</Link>
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {drivers.map(d => (
          <QuoteTile key={d.symbol} label={d.label} value={d.quote?.value ?? null}
            digits={d.digits} ts={d.quote?.ts ?? null} delta={d.delta24h}
            series={d.series} now={now} />
        ))}
      </div>
    </section>
  );
}
