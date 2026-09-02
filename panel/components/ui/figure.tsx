import * as React from "react";
import { cn } from "@/lib/utils";

const SIZE = {
  display: "text-display",
  title: "text-title font-semibold",
  body: "text-body font-medium",
} as const;

/**
 * A reading. Tabular figures throughout so stacked numbers align on the
 * decimal.
 *
 * `value === null` means no honest reading exists and renders `empty` — it
 * must never fall through to a zero. That is the same contract QuoteTile's
 * Delta already keeps, and the reason spot-delta.test.tsx exists.
 */
export function Figure({
  value, digits = 2, size = "display", label, sub, empty = "—", className, ...props
}: React.ComponentProps<"div"> & {
  value: number | null;
  digits?: number;
  size?: keyof typeof SIZE;
  label?: React.ReactNode;
  sub?: React.ReactNode;
  empty?: string;
}) {
  return (
    <div className={className} {...props}>
      {label && <div className="text-label uppercase text-ink-dim">{label}</div>}
      <div className={cn("tabular-nums", SIZE[size])}>
        {value === null
          ? <span className="text-muted-foreground">{empty}</span>
          : value.toLocaleString(undefined, {
              minimumFractionDigits: digits, maximumFractionDigits: digits,
            })}
      </div>
      {sub && <div className="mt-1 text-meta text-ink-dim">{sub}</div>}
    </div>
  );
}
