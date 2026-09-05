import type { PricePoint } from "@/lib/db";
import { fmtUtc } from "@/lib/format";

/**
 * The value-exact twin of whatever chart sits above it: every stored reading,
 * time and value, behind a disclosure.
 *
 * Lifted out of components/spot-chart.tsx when the live TradingView widget
 * took over the chart slot. The widget is a cross-origin iframe — its numbers
 * cannot be read, copied or audited from this page — so the desk's only route
 * to Jamasp's own figures is this table, and it must stay on screen in the
 * live case rather than travelling with the fallback chart.
 *
 * Renders nothing with no points: an empty disclosure inviting a click that
 * reveals an empty table is worse than silence.
 */
export function SeriesTable({ points, label = "view as table" }: {
  points: PricePoint[];
  label?: string;
}) {
  if (points.length === 0) return null;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-muted-foreground">
        {label}
      </summary>
      <div className="mt-2 max-h-40 overflow-y-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="font-normal">time (UTC)</th>
              <th className="font-normal">value</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {points.map(p => (
              <tr key={p.ts}>
                <td className="pr-4">{fmtUtc(p.ts)}</td>
                <td>{p.value.toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
