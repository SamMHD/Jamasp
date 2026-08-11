import Link from "next/link";
import { Markdown } from "@/components/markdown";
import { WeightBar } from "@/components/weight-bar";
import { Badge } from "@/components/ui/badge";
import type { ItemRow } from "@/lib/db";
import type { ParsedStance, StanceSection } from "@/lib/stance";
import { fmtAge } from "@/lib/format";

function Section({ section }: { section: StanceSection }) {
  return (
    <div className="mt-4">
      <h3 className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
        {section.heading}
      </h3>
      <Markdown text={section.body} />
    </div>
  );
}

export function FundamentalPanel({ stance, items, now }: {
  stance: ParsedStance | null; items: ItemRow[]; now: Date;
}) {
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
          {stance.sections.view && <Section section={stance.sections.view} />}
          {stance.sections.whatFlipsMe && <Section section={stance.sections.whatFlipsMe} />}
          {/* Index-qualified: headings in `extra` are free-form agent prose and
              can repeat (two ad-hoc sections with the same title, or a second
              "## View", which parseStance routes here rather than overwriting
              the first). A bare heading key would collide. */}
          {stance.extra.map((s, i) => <Section key={`${i}-${s.heading}`} section={s} />)}
        </>
      )}

      <div className="mt-6 border-t border-border pt-3">
        <h3 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
          Latest headlines
          <Link className="ml-2 normal-case tracking-normal text-primary" href="/inbox">→ inbox</Link>
        </h3>
        <ul className="space-y-1 text-sm">
          {items.length === 0 && <li className="text-muted-foreground">no items</li>}
          {items.map(i => (
            <li key={i.id} className="flex gap-2">
              <span className="w-14 shrink-0 text-xs text-muted-foreground">
                {fmtAge(i.published_at, now)}
              </span>
              <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">
                {i.source}
              </span>
              <a href={i.url} target="_blank" rel="noreferrer"
                className="flex-1 hover:underline">{i.headline}</a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
