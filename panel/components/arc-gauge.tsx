import { cls } from "@/lib/format";

/**
 * Server-rendered semicircular gauge, for a measure with a *genuinely*
 * bounded scale (RSI's 0–100). Unbounded measures (ATR, GVZ, positioning)
 * must not use this — a meter against an invented ceiling misstates the
 * scale; give them a QuoteTile instead.
 *
 * Honest empty state: with a null value there is no value arc and no
 * marker — only the track. Zero is a value, and a needle parked at zero
 * would assert it. The figure slot shows an em dash and the label line
 * says "no data" outright.
 *
 * Deliberately no verdict semantics: one accent hue for the value, a
 * lighter step of the same hue for the track, neutral hairline ticks.
 * Threshold ticks (30/70 for RSI) are reference marks, not a
 * red-and-green scale — technicals annotate the macro read, they must
 * not originate calls.
 */

const CX = 60;
const CY = 60;
const R = 46;

/** Point on the arc at fraction f of the semicircle (0 = left, 1 = right). */
function at(f: number, r: number = R): { x: number; y: number } {
  const a = Math.PI * (1 - f);
  return { x: CX + r * Math.cos(a), y: CY - r * Math.sin(a) };
}

function arcPath(f: number): string {
  const start = at(0);
  const end = at(f);
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${R} ${R} 0 0 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

function num(v: number, digits: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function ArcGauge({ label, value, min, max, digits = 1, ticks = [], className }: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  digits?: number;
  ticks?: { at: number; text: string }[];
  className?: string;
}) {
  const span = max - min;
  const f = value === null || span <= 0
    ? null
    : Math.min(1, Math.max(0, (value - min) / span));
  const marker = f === null ? null : at(f);
  const display = value === null ? "—" : num(value, digits);
  return (
    <svg viewBox="0 0 120 70" role="img"
      aria-label={value === null ? `${label}: no data` : `${label} ${display}`}
      className={cls("w-full max-w-44", className)}>
      {/* track: a lighter step of the same hue, never a foreign gray */}
      <path d={arcPath(1)} fill="none" strokeWidth="7" strokeLinecap="round"
        stroke="color-mix(in oklab, var(--viz-spot) 25%, transparent)" />
      {ticks.map(t => {
        const tf = Math.min(1, Math.max(0, (t.at - min) / span));
        const a = at(tf, R - 6.5);
        const b = at(tf, R + 6.5);
        const lab = at(tf, R + 13);
        return (
          <g key={t.at}>
            <line x1={a.x.toFixed(2)} y1={a.y.toFixed(2)}
              x2={b.x.toFixed(2)} y2={b.y.toFixed(2)}
              stroke="var(--border)" strokeWidth="1" />
            <text x={lab.x.toFixed(2)} y={lab.y.toFixed(2)} fontSize="6.5"
              textAnchor="middle" dominantBaseline="middle"
              fill="var(--muted-foreground)">{t.text}</text>
          </g>
        );
      })}
      {f !== null && f > 0 && (
        <path d={arcPath(f)} fill="none" strokeWidth="7" strokeLinecap="round"
          stroke="var(--viz-spot)" />
      )}
      {marker && (
        /* end marker with a surface ring, present even at f=0 so a true
           zero still shows as a mark rather than as nothing */
        <circle cx={marker.x.toFixed(2)} cy={marker.y.toFixed(2)} r="5"
          fill="var(--viz-spot)" stroke="var(--background)" strokeWidth="2" />
      )}
      <text x={CX} y={50} textAnchor="middle" fontSize="17" fontWeight="600"
        fill="var(--foreground)">{display}</text>
      <text x={CX} y={64} textAnchor="middle" fontSize="7"
        style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}
        fill="var(--muted-foreground)">
        {value === null ? `${label} · no data` : label}
      </text>
    </svg>
  );
}
