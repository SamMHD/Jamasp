import type { Level } from "@/lib/technicals";
import { cls } from "@/lib/format";
import { t, type Messages } from "@/lib/i18n";

/**
 * Vertical spacing between consecutive ladder rows, proportional to the
 * price gap between them and clamped to [min, max].
 *
 * Spacing the gaps rather than absolutely positioning each row keeps the
 * ladder readable when two levels nearly coincide — absolute positioning
 * would overlap the labels. Distance is conveyed, exact scale is not.
 */
export function ladderGaps(values: number[], opts?: { min?: number; max?: number }): number[] {
  const min = opts?.min ?? 8;
  const max = opts?.max ?? 48;
  if (values.length < 2) return [];
  const diffs = values.slice(0, -1).map((v, i) => Math.abs(v - values[i + 1]));
  const widest = Math.max(...diffs);
  if (widest === 0) return diffs.map(() => min);
  return diffs.map(d => min + (max - min) * (d / widest));
}

function fmt(v: number): string {
  return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/**
 * `label` comes straight from lib/technicals.ts#deriveTechnicals, which is
 * paired byte-for-byte with jamasp/pricesummary.py#_tech_line and asserted
 * exactly by test/technicals.test.ts — so this component translates for
 * DISPLAY only, never by changing what deriveTechnicals returns.
 *
 * Only "spot" gets a dictionary entry. "200DMA"/"50DMA"/"pivot R1"/"pivot
 * S1" are judged ticker-like technical shorthand — the same register as
 * `signal.rsi14: "RSI14"` or `driver.dxy: "DXY"`, which this dictionary
 * already keeps Latin in Persian — and this ladder is a narrow, dense
 * column where a fuller Persian phrase ("میانگین متحرک 200 روزه") would not
 * fit beside the tabular price column. "spot" is different: a plain English
 * common noun for "the current price," not an acronym or ticker, so it
 * translates like any other prose word.
 */
const LEVEL_LABEL_KEY: Record<string, string> = { spot: "tech.levelSpot" };

function levelLabel(label: string, messages: Messages): string {
  const key = LEVEL_LABEL_KEY[label];
  return key ? t(messages, key) : label;
}

/**
 * The level map as a price rail: a vertical axis line with a tick per
 * stored level and a gold dot where spot sits. Above/below is carried by
 * sorted position (levels arrive descending); MA ticks are longer than
 * pivot ticks, and the label disambiguates regardless, so the encoding is
 * never colour- or length-alone. The dot is the only coloured mark — text
 * stays in text tokens.
 */
export function LevelLadder({ levels, messages }: { levels: Level[]; messages: Messages }) {
  if (levels.length === 0) {
    return <p className="text-sm text-muted-foreground">{t(messages, "tech.noLevelsAvailable")}</p>;
  }
  const gaps = ladderGaps(levels.map(l => l.value));
  return (
    <ol dir="ltr" className="relative ml-1 border-l-2 border-border py-1 pl-5 tabular-nums">
      {levels.map((l, i) => (
        <li key={l.label}
          style={i === 0 ? undefined : { marginTop: `${gaps[i - 1]}px` }}
          className={cls(
            "relative flex items-baseline gap-2 text-sm",
            l.kind === "spot" ? "font-semibold text-foreground" : "text-muted-foreground",
          )}>
          {l.kind === "spot" ? (
            <span aria-hidden
              className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-background"
              style={{ left: "-27px", background: "var(--viz-spot)" }} />
          ) : (
            <span aria-hidden
              className={cls("absolute top-1/2 h-px -translate-y-1/2 bg-border",
                l.kind === "ma" ? "w-3.5" : "w-2.5")}
              style={{ left: "-22px" }} />
          )}
          <span className="w-16 shrink-0 text-right">{fmt(l.value)}</span>
          <span className="text-xs">{levelLabel(l.label, messages)}</span>
        </li>
      ))}
    </ol>
  );
}
