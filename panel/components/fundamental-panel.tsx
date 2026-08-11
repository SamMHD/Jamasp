import Link from "next/link";
import { Markdown } from "@/components/markdown";
import { SLOT_VARS, WeightBar } from "@/components/weight-bar";
import { Badge } from "@/components/ui/badge";
import type { WatchlistEntry } from "@/lib/files";
import type { ParsedStance, StanceSection, StanceWeight } from "@/lib/stance";
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
 */

const H3 = "mb-1 text-xs uppercase tracking-wide text-muted-foreground";

function Section({ section }: { section: StanceSection }) {
  return (
    <div className="mt-4">
      <h3 className={H3}>{section.heading}</h3>
      <Markdown text={section.body} />
    </div>
  );
}

/** View, with each scenario bullet tied to its weight-bar slot. */
function ViewSection({ section, weights }: {
  section: StanceSection; weights: StanceWeight[] | null;
}) {
  const { intro, bullets, after } = extractBullets(section.body);
  if (!weights || bullets.length === 0) return <Section section={section} />;
  return (
    <div className="mt-4">
      <h3 className={H3}>{section.heading}</h3>
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
    </div>
  );
}

/** What flips me: falsifiers as condition → consequence rows. */
function FlipsSection({ section }: { section: StanceSection }) {
  const { intro, bullets, after } = extractBullets(section.body);
  if (bullets.length === 0) return <Section section={section} />;
  return (
    <div className="mt-4">
      <h3 className={H3}>{section.heading}</h3>
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
    </div>
  );
}

function Watching({ watchlist, now }: { watchlist: WatchlistEntry[]; now: Date }) {
  return (
    <div className="mt-6 border-t border-border pt-3">
      <h3 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
        Watching
        <Link className="ml-2 normal-case tracking-normal text-primary" href="/state">→ state</Link>
      </h3>
      {watchlist.length === 0 ? (
        <p className="text-sm text-muted-foreground">watchlist empty</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {watchlist.map(w => (
            <span key={w.theme} title={w.why}
              className="rounded-full border border-border px-2.5 py-0.5 text-xs">
              {w.theme}
              {w.since && (
                <span className="text-muted-foreground"> · {fmtAge(w.since, now)}</span>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function FundamentalPanel({ stance, watchlist, now }: {
  stance: ParsedStance | null; watchlist: WatchlistEntry[]; now: Date;
}) {
  const age = stance?.asOf ? stanceAgeDays(stance.asOf, now) : null;
  return (
    <section aria-label="Fundamental" className="rounded border border-border p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="font-medium">
          Fundamental
          <Link className="ml-2 text-xs font-normal text-primary" href="/state">→ state</Link>
        </h2>
        {stance?.asOf && (
          <span className="text-xs text-muted-foreground">
            stance {stance.asOf}{stance.updatedNote ? ` · ${stance.updatedNote}` : ""}
            {age !== null && age >= 2 && (
              <span className="text-amber-600 dark:text-amber-400"> · {age}d old</span>
            )}
          </span>
        )}
      </div>

      {stance === null ? (
        <p className="text-sm text-muted-foreground">no stance yet</p>
      ) : stance.degraded ? (
        <>
          <Badge variant="outline" className="mb-2">unrecognised format</Badge>
          <Markdown text={stance.raw} />
        </>
      ) : (
        <>
          {stance.weights && (
            <div className="mb-4">
              <WeightBar weights={stance.weights} />
            </div>
          )}
          {stance.preamble && <Markdown text={stance.preamble} />}
          {stance.sections.view && (
            <ViewSection section={stance.sections.view} weights={stance.weights} />
          )}
          {stance.sections.whatFlipsMe && (
            <FlipsSection section={stance.sections.whatFlipsMe} />
          )}
          {/* Index-qualified: headings in `extra` are free-form agent prose and
              can repeat (two ad-hoc sections with the same title, or a second
              "## View", which parseStance routes here rather than overwriting
              the first). A bare heading key would collide. */}
          {stance.extra.map((s, i) => <Section key={`${i}-${s.heading}`} section={s} />)}
        </>
      )}

      <Watching watchlist={watchlist} now={now} />
    </section>
  );
}
