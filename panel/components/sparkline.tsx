import type { PricePoint } from "@/lib/db";
import { cls } from "@/lib/format";

/**
 * Server-rendered inline SVG. Deliberately not recharts: this is decoration
 * beneath the ladder, and pulling in a client component for it would make
 * the whole panel client-side.
 */
export function Sparkline({ points, className, stroke = "var(--chart-1)" }: {
  points: PricePoint[]; className?: string; stroke?: string;
}) {
  if (points.length < 2) return null;
  const values = points.map(p => p.value);
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * 100;
      const y = 100 - ((p.value - min) / span) * 100;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    // `direction`, not `dir`: the UA stylesheet rule that turns a `dir`
    // attribute into the `direction` property (`[dir=ltr i] {...}`) carries
    // an implied HTML-namespace universal selector, so it never matches an
    // SVG root — `dir="ltr"` here would be silently inert. SVG's own
    // mechanism is the `direction` CSS property directly.
    <svg viewBox="0 0 100 100" preserveAspectRatio="none"
      style={{ direction: "ltr" }}
      className={cls("h-10 w-full", className)} role="img"
      aria-label={`gold price trend, ${points.length} points`}>
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.5"
        vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
