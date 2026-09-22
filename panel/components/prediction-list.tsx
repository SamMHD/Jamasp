import { Badge } from "@/components/ui/badge";
import { cls, fmtAge, fmtUtc } from "@/lib/format";
import { localized, t, type Locale, type Messages } from "@/lib/i18n";
import { SourceLang } from "@/components/source-lang";
import { directionLabel, type LedgerRow, type PredictionState } from "@/lib/predictions";

/**
 * The forecast ledger as a dense, scannable list — one row per prediction,
 * every state in the same list so "what have I got running" and "how did the
 * last one go" are one read rather than two pages.
 *
 * Colour language is the Forecast-record card's, deliberately: emerald for a
 * hit, the destructive red for a miss, the same amber the card uses for
 * "awaiting score" on a matured-but-unscored claim. A reader who has seen the
 * card's calibration arms should not have to learn a second palette here.
 * Every state also carries its own word in a badge, so colour is never the
 * only carrier — and each row wears a coloured left rule so a state is
 * legible in peripheral vision while scrolling.
 *
 * Direction (up/down/flat) is deliberately NOT coloured, even though the
 * panel has --up/--down tokens for exactly that. On this page green already
 * means "I was right"; letting it also mean "I said gold rises" would make
 * every row's colour ambiguous. Direction gets a glyph and a word instead.
 *
 * Claims run long — the live ledger's longest is over 1,400 characters, since
 * a Jamasp claim carries its own falsification conditions — so the collapsed
 * row clamps to two lines and the whole row is a <details> summary: opening
 * it unclamps the claim and reveals the scoring note and exact timestamps.
 * That is plain HTML disclosure, the same idiom the Forecast-record card's
 * table twin uses, and needs no client JavaScript.
 */

export const STATE_LABEL: Record<PredictionState, string> = {
  due: "due", open: "open", hit: "hit", miss: "miss", unclear: "unclear",
};

/** `PredictionState`'s dictionary keys — chrome, the closed set this whole
 *  page is built on. `stateLabel` is what every render call site uses;
 *  `STATE_LABEL` above stays exported as the raw English, since
 *  app/predictions/page.tsx's `resolveStateFilter` matches against it. */
export const STATE_LABEL_KEY: Record<PredictionState, string> = {
  due: "predictions.wordDue", open: "predictions.wordOpen", hit: "predictions.wordHit",
  miss: "predictions.wordMiss", unclear: "predictions.wordUnclear",
};

export function stateLabel(state: PredictionState, messages: Messages): string {
  return t(messages, STATE_LABEL_KEY[state]);
}

/** Ink per state. Raw palette classes always carry a dark: counterpart. */
export const STATE_INK: Record<PredictionState, string> = {
  due: "text-amber-600 dark:text-amber-400",
  open: "text-primary",
  hit: "text-emerald-700 dark:text-emerald-400",
  miss: "text-destructive",
  unclear: "text-muted-foreground",
};

const STATE_RULE: Record<PredictionState, string> = {
  due: "border-l-amber-600 dark:border-l-amber-400",
  open: "border-l-primary",
  hit: "border-l-emerald-700 dark:border-l-emerald-400",
  miss: "border-l-destructive",
  unclear: "border-l-border",
};

const DIRECTION_GLYPH: Record<string, string> = { up: "↑", down: "↓", flat: "→" };

const iso = (ms: number) => new Date(ms).toISOString();

/** Percent, or "—" when the ledger line carries a malformed confidence. */
function pct(confidence: number): string {
  return typeof confidence === "number" && Number.isFinite(confidence)
    ? `${Math.round(confidence * 100)}%` : "—";
}

/**
 * The one time fact that matters for this row's state: how long a due claim
 * has been waiting, when a live one lands, when a settled one was scored.
 */
function timing(row: LedgerRow, now: Date, messages: Messages): string | null {
  if (!Number.isFinite(row.maturesAt) && !row.resolved) return t(messages, "predictions.maturityUnknown");
  if (row.state === "due") {
    return `${t(messages, "predictions.timingMatured")} ${fmtAge(iso(row.maturesAt), messages, now)}`;
  }
  if (row.state === "open") {
    return `${t(messages, "predictions.timingMatures")} ${fmtAge(iso(row.maturesAt), messages, now)}`;
  }
  return row.pred.scored_at
    ? `${t(messages, "predictions.timingScored")} ${fmtAge(row.pred.scored_at, messages, now)}`
    : t(messages, "predictions.timingScored");
}

function Row({ row, now, locale, messages, claimFa }: {
  row: LedgerRow; now: Date; locale: Locale; messages: Messages; claimFa: string | undefined;
}) {
  const p = row.pred;
  const when = timing(row, now, messages);
  // Same {claim, claim_fa} shaping as app/state/page.tsx's own predictions
  // table, keyed by prediction id — both surfaces read
  // lib/files.ts#readPredictionsFa the same way so they can never disagree
  // about which claims are translated.
  const { text: claim, fallback } = localized({ claim: p.claim, claim_fa: claimFa }, "claim", locale);
  return (
    <li className={cls("border-b border-l-2 border-border", STATE_RULE[row.state])}>
      <details className="group">
        <summary
          className={cls(
            "flex cursor-pointer list-none gap-2 px-3 py-2 hover:bg-secondary/60",
            "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            "[&::-webkit-details-marker]:hidden",
          )}
        >
          <span aria-hidden
            className="mt-0.5 shrink-0 text-ink-dim transition-transform group-open:rotate-90">
            ▸
          </span>
          {/* min-w-0: without it this flex child refuses to shrink below its
              content width, and the clamped claim below would push the row
              wider than the viewport instead of ellipsing. */}
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta">
              <Badge variant="outline"
                className={cls("uppercase", STATE_INK[row.state])}>
                {stateLabel(row.state, messages)}
              </Badge>
              <span className="text-muted-foreground">
                <span aria-hidden>{DIRECTION_GLYPH[p.direction] ?? "·"}</span>{" "}
                {directionLabel(p.direction, messages)}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {pct(p.confidence)} {t(messages, "predictions.confSuffix")}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {p.horizon_days}d {t(messages, "predictions.horizonSuffix")}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {t(messages, "predictions.madePrefix")} {p.date}
              </span>
              {when && (
                <span className={cls("tabular-nums",
                  row.state === "due" ? STATE_INK.due : "text-muted-foreground")}>
                  {when}
                </span>
              )}
              <span className="ml-auto tabular-nums text-ink-dim">{p.id}</span>
            </span>
            <span className="line-clamp-2 text-body group-open:line-clamp-none">
              <SourceLang fallback={fallback} messages={messages}>{claim}</SourceLang>
            </span>
          </span>
        </summary>
        <div className="space-y-2 border-t border-border bg-secondary/40 px-3 py-2 pl-8 text-meta">
          {p.note && (
            <p className="text-body text-muted-foreground">
              <span className={cls("mr-1 uppercase", STATE_INK[row.state])}>
                {stateLabel(row.state, messages)}
              </span>
              {p.note}
            </p>
          )}
          <p className="text-ink-dim tabular-nums">
            {t(messages, "predictions.madePrefix")} {fmtUtc(p.created_at)}
            {Number.isFinite(row.maturesAt) && (
              <> · {t(messages, "predictions.timingMatures")} {fmtUtc(iso(row.maturesAt))}</>
            )}
            {p.scored_at && <> · {t(messages, "predictions.timingScored")} {fmtUtc(p.scored_at)}</>}
            {" · "}<code>jamasp predictions score {p.id}</code>
          </p>
        </div>
      </details>
    </li>
  );
}

export function PredictionList({ rows, now, empty, locale, messages, predictionsFa = {} }: {
  rows: LedgerRow[];
  now: Date;
  empty: string;
  locale: Locale;
  messages: Messages;
  /** Keyed by prediction id — see lib/files.ts#readPredictionsFa. Optional
   *  and defaulting to empty rather than required: several existing call
   *  sites (and the empty-ledger short-circuit above) never read Persian
   *  claims at all, and every entry simply reads as "no translation yet"
   *  when absent, the same as a missing `claim_fa` column would. */
  predictionsFa?: Record<string, string>;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="border-t border-border">
      {rows.map(r => (
        <Row key={r.pred.id} row={r} now={now} locale={locale} messages={messages}
          claimFa={predictionsFa[r.pred.id]} />
      ))}
    </ul>
  );
}
