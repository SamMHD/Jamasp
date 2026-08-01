"use client";
import { useState } from "react";
import useSWR from "swr";
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { TooltipContentProps } from "recharts";
import { Button } from "@/components/ui/button";
import type { PricePoint } from "@/lib/db";
import { fmtUtc } from "@/lib/format";

const fetcher = (url: string) => fetch(url).then(r => {
  if (!r.ok) throw new Error(`price fetch failed (${r.status})`);
  return r.json();
});
const RANGES = ["24h", "7d", "30d"] as const;

function fmtValue(v: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Value leads, timestamp follows — the reader has the series already (the chart
 * title), so the number is what they came for. */
function ChartTooltip({ active, payload, label }: TooltipContentProps) {
  if (!active || !payload || payload.length === 0) return null;
  const value = payload[0]?.value;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-1.5 text-xs shadow-sm">
      <div className="font-semibold tabular-nums text-popover-foreground">
        {typeof value === "number" ? fmtValue(value) : String(value)}
      </div>
      <div className="text-muted-foreground">{fmtUtc(String(label))}</div>
    </div>
  );
}

export function PriceChart({ symbol }: { symbol: string }) {
  const [range, setRange] = useState<(typeof RANGES)[number]>("7d");
  const url = `/api/prices?symbol=${encodeURIComponent(symbol)}&range=${range}`;
  const { data, error, isLoading } = useSWR<{ points: PricePoint[] }>(url, fetcher, {
    refreshInterval: 60_000,
  });
  const points = data?.points ?? [];

  return (
    <div className="rounded border border-border p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium">{symbol}</h2>
        <div className="flex gap-1">
          {RANGES.map(r => (
            <Button key={r} size="sm" variant={r === range ? "secondary" : "ghost"}
              onClick={() => setRange(r)}>{r}</Button>
          ))}
        </div>
      </div>
      {error ? (
        <p className="rounded border border-destructive py-10 text-center text-sm text-destructive">
          failed to load price data — {error instanceof Error ? error.message : "unknown error"}
        </p>
      ) : isLoading ? (
        <p className="py-10 text-center text-sm text-muted-foreground">loading…</p>
      ) : points.length < 2 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">not enough data in range</p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={points} margin={{ left: 8, right: 8, top: 4, bottom: 4 }}>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis dataKey="ts" tickFormatter={fmtUtc} minTickGap={60}
                stroke="var(--border)" tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
              <YAxis domain={["auto", "auto"]} width={64} stroke="var(--border)"
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                tickFormatter={fmtValue} />
              <Tooltip content={ChartTooltip}
                cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }} />
              <Line type="monotone" dataKey="value" dot={false} strokeWidth={2}
                stroke="var(--chart-1)" isAnimationActive={false}
                activeDot={{ r: 5, stroke: "var(--popover)", strokeWidth: 2, fill: "var(--chart-1)" }} />
            </LineChart>
          </ResponsiveContainer>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              view as table
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
                      <td>{fmtValue(p.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
