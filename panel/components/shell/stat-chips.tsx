import Link from "next/link";
import { cls } from "@/lib/format";

export type Chip = {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "bad";
  href?: string;
};

const TONE = {
  ok: "text-up",
  warn: "text-primary",
  bad: "text-destructive",
} as const;

const SHELL = "inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border " +
  "px-3 text-meta focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * Machine health, demoted. Every chip names what it measures, so the tone
 * colour is emphasis rather than the carrier of meaning.
 *
 * docs/todo/010: chips below key on `chip.label`, which collides if this
 * ever renders StatusStrip's four structurally-identical run-type chips
 * (its planned call site) with a reused label. Read that todo before wiring
 * that migration up.
 */
export function StatChips({ chips }: { chips: Chip[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {chips.map(chip => {
        const body = (
          <>
            <span className="text-ink-dim">{chip.label}</span>
            <span className={cls("tabular-nums", chip.tone ? TONE[chip.tone] : "text-foreground")}>
              {chip.value}
            </span>
          </>
        );
        return chip.href
          ? <Link key={chip.label} href={chip.href} className={cls(SHELL, "hover:bg-secondary")}>{body}</Link>
          : <span key={chip.label} className={SHELL}>{body}</span>;
      })}
    </div>
  );
}
