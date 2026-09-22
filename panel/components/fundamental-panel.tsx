import Link from "next/link";
import { Markdown } from "@/components/markdown";
import { SourceLang } from "@/components/source-lang";
import { SLOT_VARS, WeightBar } from "@/components/weight-bar";
import { Badge } from "@/components/ui/badge";
import type { StanceFaSection, WatchlistEntry } from "@/lib/files";
import { localized, t, type Locale, type Messages } from "@/lib/i18n";
import type { ParsedStance, StanceKey, StanceSection, StanceWeight } from "@/lib/stance";
import { extractBullets, scenarioSlot, splitFalsifier, stanceAgeDays } from "@/lib/stance";
import { cls, fmtAge } from "@/lib/format";

/**
 * The analyst's read, given the same instrument treatment its price
 * levels got:
 *
 * - View bullets wear the swatch of the weight-bar slot they argue for
 *   (matched by the scenario label the analyst wrote, never guessed —
 *   an unmatched bullet gets a hollow marker), so the 70/5/25 bar and
 *   the reasoning beneath it stop being unrelated blocks of pixels.
 * - "What flips me" renders as falsifier rows: condition set off from
 *   consequence at the analyst's own arrow. That section is the most
 *   operationally useful prose on the page and must not look like
 *   narrative.
 * - The watchlist themes appear as chips with their age — a theme
 *   watched for months is a different claim from one adopted yesterday.
 * - The header states the stance's age in amber once it is ≥2 days old:
 *   briefs rewrite it daily, so a two-day-old stance means a missed run,
 *   not a quiet market.
 *
 * The preamble stays verbatim by design — it is the analyst's lead
 * paragraph, and the sections' full text always renders: bullets are
 * restyled, never dropped or truncated.
 *
 * Degraded path unchanged and load-bearing: an unparseable stance
 * renders raw under a badge, and the watchlist (a separate file) still
 * renders beneath it.
 *
 * Persian, when `locale` is "fa": every structural decision above —
 * which sections exist, the weight triplet, which slot a bullet argues
 * for, where a falsifier's arrow sits — still comes from the ENGLISH
 * stance exactly as today (parseStance never sees Persian). Only the
 * BODY text rendered for the preamble, View, "What flips me" and each
 * `extra` section swaps to its Persian sidecar counterpart, matched by
 * where that section sits in the document, never by its heading text —
 * see `sectionPositions` below. `scenarioSlot`/`splitFalsifier` are then
 * run again on WHICHEVER text ends up on screen: markdown syntax (list
 * markers, the → arrow) survives translation by the job's own contract,
 * so this still finds the right shape in Persian, and simply degrades to
 * a hollow/unmatched marker on a scenario label the translation reworded
 * — never a wrong guess.
 */

const H3 = "mb-1 text-xs uppercase tracking-wide text-muted-foreground";

/**
 * Dictionary keys for the six canonical stance sections. StanceKey is a
 * closed enum, so these headings are chrome — hand-translated and
 * complete by construction, never routed through the translate job the
 * way section BODIES are (see jamasp/translatetext.py's own note that the
 * sidecar's heading line is "an anchor, never rendered"). Only two of the
 * six are actually rendered by this panel today (view, whatFlipsMe); the
 * rest exist so the dictionary carries the whole enum, not just the part
 * this component currently uses.
 */
export const STANCE_HEADING_KEYS: Record<StanceKey, string> = {
  view: "stance.view",
  whatFlipsMe: "stance.whatFlipsMe",
  openPredictions: "stance.openPredictions",
  wakeups: "stance.wakeups",
  deskLocal: "stance.deskLocal",
  sourcingHealth: "stance.sourcingHealth",
};

/**
 * Where each already-classified section sits in the raw `## `-delimited
 * split of the English stance — position 0 is the preamble (everything
 * before the first "## " line), position N is the N-th "## " heading in
 * document order. This is what lets a Persian sidecar's sections (written
 * and read in that same order — see lib/files.ts#readStanceFa, which
 * mirrors jamasp/translatetext.py's split_sections) be matched back to the
 * right place: BY POSITION, never by heading text. Heading text is not a
 * safe key here — an ad hoc "extra" heading is rarely worded the same way
 * twice (it usually carries a run-specific date or wakeup number), and a
 * canonical heading CAN repeat, in which case parseStance already routes
 * the second occurrence to `extra` rather than overwriting the first; this
 * loop has to agree, hence `consumed`.
 *
 * Reimplemented here rather than exported from lib/stance.ts: parseStance's
 * job is English structure only, and this is Persian-matching plumbing
 * that belongs with the component rendering both languages.
 */
function sectionPositions(stance: ParsedStance): {
  byKey: Partial<Record<StanceKey, number>>;
  byExtra: number[];
} {
  const byKey: Partial<Record<StanceKey, number>> = {};
  const byExtra: number[] = [];
  const headingToKey = new Map<string, StanceKey>(
    (Object.entries(stance.sections) as [StanceKey, StanceSection][])
      .map(([key, s]) => [s.heading, key]));
  const consumed = new Set<StanceKey>();

  let position = 0;
  for (const line of stance.raw.split("\n")) {
    const m = /^##\s+(.*)$/.exec(line);
    if (!m) continue;
    position++;
    const key = headingToKey.get(m[1].trim());
    if (key !== undefined && !consumed.has(key)) {
      byKey[key] = position;
      consumed.add(key);
    } else {
      byExtra.push(position);
    }
  }
  return { byKey, byExtra };
}

type Localized = { text: string; fallback: boolean };
type BodyAt = (english: string, position: number | undefined) => Localized;

/**
 * `english` in, `{text, fallback}` out — Persian when the sidecar's
 * section at `position` has a real (non-empty) hash, English with the
 * fallback flag set otherwise. Delegates to `localized` (the same helper
 * every other content field on the panel uses) by shaping a one-off
 * `{body, body_fa}` "row": that keeps this in the established
 * localized+SourceLang pattern rather than inventing a parallel one.
 *
 * Built once per render and reused for every section: `usable` folds in
 * the section-COUNT check up front, because a sidecar whose section count
 * disagrees with the source's must not be trusted for ANY section — the
 * two files disagree about structure, and zipping them section-by-section
 * would put one section's Persian under another's heading.
 */
function buildBodyAt(
  stance: ParsedStance, stanceFa: { sections: StanceFaSection[] } | null, locale: Locale,
): BodyAt {
  if (stance.degraded) return english => ({ text: english, fallback: false });
  const totalPositions = 1 + Object.keys(stance.sections).length + stance.extra.length;
  const usable = stanceFa !== null && stanceFa.sections.length === totalPositions;
  return (english, position) => {
    const fa = usable && position !== undefined ? stanceFa!.sections[position] : undefined;
    return localized(
      { body: english, body_fa: fa && fa.hash !== "" ? fa.body : undefined }, "body", locale);
  };
}

function Section({ heading, body, fallback, messages }: {
  heading: string; body: string; fallback: boolean; messages: Messages;
}) {
  return (
    <div className="mt-4">
      <h3 className={H3}>{heading}</h3>
      <SourceLang fallback={fallback} messages={messages} block>
        <Markdown text={body} />
      </SourceLang>
    </div>
  );
}

/** View, with each scenario bullet tied to its weight-bar slot. */
function ViewSection({ heading, body, weights, fallback, messages }: {
  heading: string; body: string; weights: StanceWeight[] | null;
  fallback: boolean; messages: Messages;
}) {
  const { intro, bullets, after } = extractBullets(body);
  if (!weights || bullets.length === 0) {
    return <Section heading={heading} body={body} fallback={fallback} messages={messages} />;
  }
  return (
    <div className="mt-4">
      <h3 className={H3}>{heading}</h3>
      <SourceLang fallback={fallback} messages={messages} block>
        <>
          {intro && <Markdown text={intro} />}
          <ul className="mt-2 space-y-1.5">
            {bullets.map((b, i) => {
              const slot = scenarioSlot(b, weights);
              const known = slot !== null && slot < SLOT_VARS.length;
              return (
                <li key={`${i}-${b.slice(0, 24)}`} className="flex gap-2 text-sm">
                  <span aria-hidden
                    className={cls("mt-1.5 h-2 w-2 shrink-0 rounded-[3px]",
                      !known && "border border-muted-foreground/50")}
                    style={known ? { background: SLOT_VARS[slot] } : undefined} />
                  <Markdown text={b} className="min-w-0 flex-1 max-w-none [&_p]:my-0" />
                </li>
              );
            })}
          </ul>
          {after && <Markdown text={after} />}
        </>
      </SourceLang>
    </div>
  );
}

/** What flips me: falsifiers as condition → consequence rows. */
function FlipsSection({ heading, body, fallback, messages }: {
  heading: string; body: string; fallback: boolean; messages: Messages;
}) {
  const { intro, bullets, after } = extractBullets(body);
  if (bullets.length === 0) {
    return <Section heading={heading} body={body} fallback={fallback} messages={messages} />;
  }
  return (
    <div className="mt-4">
      <h3 className={H3}>{heading}</h3>
      <SourceLang fallback={fallback} messages={messages} block>
        <>
          {intro && <Markdown text={intro} />}
          <ul className="mt-2 space-y-2">
            {bullets.map((b, i) => {
              const f = splitFalsifier(b);
              return (
                <li key={`${i}-${b.slice(0, 24)}`}
                  className="border-l-2 border-muted-foreground/40 pl-3 text-sm">
                  <Markdown text={f.condition}
                    className="max-w-none [&_p]:my-0 [&_p]:font-medium" />
                  {f.consequence && (
                    <div className="mt-0.5 flex gap-1.5">
                      <span aria-hidden className="text-muted-foreground">→</span>
                      <Markdown text={f.consequence}
                        className="min-w-0 flex-1 max-w-none [&_p]:my-0 [&_p]:text-muted-foreground" />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {after && <Markdown text={after} />}
        </>
      </SourceLang>
    </div>
  );
}

/**
 * `watchlistFa` is keyed by theme, per lib/files.ts#readWatchlistFa: a theme
 * missing from it (untranslated, or stale against the current `why`) is
 * simply absent, which `localized` reads as "no Persian" — the same shape
 * app/state/page.tsx uses for the same field.
 *
 * The tooltip is a `title` attribute, a plain string, so it cannot hold a
 * <SourceLang> element. An untranslated one appends
 * content.sourceEnglishTitle instead — exactly what
 * components/market-map.tsx#tileTitle does for the same problem, so the
 * panel has one convention for marking English inside an attribute.
 */
function Watching({ watchlist, watchlistFa, now, locale, messages }: {
  watchlist: WatchlistEntry[]; watchlistFa: Record<string, string>;
  now: Date; locale: Locale; messages: Messages;
}) {
  return (
    <div className="mt-6 border-t border-border pt-3">
      <h3 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
        {t(messages, "fundamental.watchingHeading")}
        <Link className="ml-2 normal-case tracking-normal text-primary" href="/state">
          → {t(messages, "nav.state").toLowerCase()}
        </Link>
      </h3>
      {watchlist.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(messages, "fundamental.watchlistEmpty")}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {watchlist.map(w => {
            const { text, fallback } = localized(
              { why: w.why, why_fa: watchlistFa[w.theme] }, "why", locale);
            const title = fallback
              ? `${text} — ${t(messages, "content.sourceEnglishTitle")}` : text;
            return (
              <span key={w.theme} title={title}
                className="rounded-full border border-border px-2.5 py-0.5 text-xs">
                {w.theme}
                {w.since && (
                  <span className="text-muted-foreground"> · {fmtAge(w.since, messages, now)}</span>
                )}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function FundamentalPanel({
  stance, watchlist, now, locale, messages, stanceFa = null, watchlistFa = {},
}: {
  stance: ParsedStance | null; watchlist: WatchlistEntry[]; now: Date;
  locale: Locale; messages: Messages;
  stanceFa?: { sections: StanceFaSection[] } | null;
  // Defaults to "no Persian for any theme", which is what an absent sidecar
  // means — and `localized` turns that into a MARKED English fallback, so
  // unlike an English `messages` default this one cannot hide anything.
  watchlistFa?: Record<string, string>;
}) {
  const age = stance?.asOf ? stanceAgeDays(stance.asOf, now) : null;

  // Both no-ops (English text, fallback false, nothing rendered) whenever
  // there is no stance to localize — a null or degraded stance never
  // reaches ViewSection/FlipsSection/Section below, so `bodyAt` is only
  // ever actually called against a healthy one.
  const positions = stance ? sectionPositions(stance) : { byKey: {}, byExtra: [] };
  const bodyAt: BodyAt = stance
    ? buildBodyAt(stance, stanceFa, locale)
    : english => ({ text: english, fallback: false });

  const preamble = stance?.preamble ? bodyAt(stance.preamble, 0) : null;
  const view = stance?.sections.view
    ? bodyAt(stance.sections.view.body, positions.byKey.view) : null;
  const flips = stance?.sections.whatFlipsMe
    ? bodyAt(stance.sections.whatFlipsMe.body, positions.byKey.whatFlipsMe) : null;

  return (
    <section aria-label={t(messages, "fundamental.heading")} className="rounded border border-border p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="font-medium">
          {t(messages, "fundamental.heading")}
          <Link className="ml-2 text-xs font-normal text-primary" href="/state">
            → {t(messages, "nav.state").toLowerCase()}
          </Link>
        </h2>
        {stance?.asOf && (
          <span className="text-xs text-muted-foreground">
            {t(messages, "fundamental.stancePrefix")} {stance.asOf}
            {stance.updatedNote ? ` · ${stance.updatedNote}` : ""}
            {age !== null && age >= 2 && (
              <span className="text-amber-600 dark:text-amber-400">
                {" "}· {age}{t(messages, "fundamental.daysOldSuffix")}
              </span>
            )}
          </span>
        )}
      </div>

      {stance === null ? (
        <p className="text-sm text-muted-foreground">{t(messages, "common.noStanceYet")}</p>
      ) : stance.degraded ? (
        <>
          <Badge variant="outline" className="mb-2">{t(messages, "fundamental.unrecognisedFormat")}</Badge>
          <Markdown text={stance.raw} />
        </>
      ) : (
        <>
          {stance.weights && (
            <div className="mb-4">
              <WeightBar weights={stance.weights} />
            </div>
          )}
          {preamble && (
            <SourceLang fallback={preamble.fallback} messages={messages} block>
              <Markdown text={preamble.text} />
            </SourceLang>
          )}
          {stance.sections.view && view && (
            <ViewSection heading={t(messages, STANCE_HEADING_KEYS.view)}
              body={view.text} weights={stance.weights}
              fallback={view.fallback} messages={messages} />
          )}
          {stance.sections.whatFlipsMe && flips && (
            <FlipsSection heading={t(messages, STANCE_HEADING_KEYS.whatFlipsMe)}
              body={flips.text} fallback={flips.fallback} messages={messages} />
          )}
          {/* Index-qualified: headings in `extra` are free-form agent prose and
              can repeat (two ad-hoc sections with the same title, or a second
              "## View", which parseStance routes here rather than overwriting
              the first). A bare heading key would collide. */}
          {stance.extra.map((s, i) => {
            const body = bodyAt(s.body, positions.byExtra[i]);
            return (
              <Section key={`${i}-${s.heading}`} heading={s.heading}
                body={body.text} fallback={body.fallback} messages={messages} />
            );
          })}
        </>
      )}

      <Watching watchlist={watchlist} watchlistFa={watchlistFa} now={now}
        locale={locale} messages={messages} />
    </section>
  );
}
