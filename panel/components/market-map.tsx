import { fmtAge } from "@/lib/format";
import { layoutMap, tone, type MapRange, type ScoredItem } from "@/lib/marketmap";
import { FullscreenButton } from "@/components/fullscreen-button";
import {
  MapGroupHeader, MapHatchDefs, MapLegend, MapTile, GROUP_HEADER_H, fitLabel,
  fallbackMarkerBand, importanceInsets, tierFate,
  type ImportanceTreatment, type TierGates,
} from "@/components/map-tiles";
import { localized, t, type Locale, type Messages } from "@/lib/i18n";

/**
 * Fundamental market map: a two-level treemap of scored news, drawn as
 * server-rendered inline SVG for the reasons `sparkline.tsx` gives — no
 * client component, no charting library. Hover is a native SVG <title>,
 * which is a free tooltip that costs no JavaScript.
 *
 * AREA is materiality (tier), COLOUR is direction scaled by conviction —
 * see `lib/marketmap.ts` for why those are two different channels. This
 * component only positions and paints what `layoutMap` already computed.
 *
 * Area is `tierWeight(tier)` and nothing else. The theme's learned multiplier
 * rides along on `ThemeBox.multiplier` for a header to report, and is
 * deliberately not an area term — `lib/marketmap.ts#layoutMap` gives the full
 * argument, including the day the two-factor area inverted tier order on the
 * live panel. So a bigger tile is a higher-or-equal tier, always.
 *
 * Area is still a RELATIVE channel, though, and that is a different gap: a
 * tile's size is its tier's share of whatever else landed in the window, and
 * the five tier weights are only 1.7x-3.3x apart, so "bigger than that one"
 * reads off the map but "tier 4, not tier 3" does not. The optional
 * `importance` channel exists for that gap — it reports `tier` absolutely, at
 * the same size on every tile. It is off ("none") unless a caller asks.
 *
 * A treemap is an all-pairs surface — any two tiles can end up adjacent — so
 * every one of the ramp's ten step-pairs was measured (see the palette
 * comment in globals.css), not just the poles. Two pairs fail outright:
 * bear/bull-mid at dE 2.8 for protanopes (effectively the same colour) and
 * bear-mid/bull-mid at dE 3.1 for deuteranopes; the pole pair bear/bull
 * (dE 6.9) is only the third worst. Hatching BOTH bearish tones — `bear`
 * and `bear-mid`, not just the pole — gives every failing pair exactly one
 * hatched member, which is what makes them separable without colour. Do
 * not "tidy" the hatch predicate down to the pole: that silently
 * reintroduces the bear-mid/bull-mid and bear/bull-mid failures. The
 * diagonal hatch is the required second encoding, not decoration, and it
 * must survive at any tile size, which rules out a signed number label.
 *
 * The tile primitives themselves (fill/ink tables, hatch, label wrapping)
 * live in `components/map-tiles.tsx`, shared with the technical map.
 */

const THEME_HEADER_H = GROUP_HEADER_H;

/** Shared between the section and the button that fullscreens it. */
export const MAP_ELEMENT_ID = "market-map";

/**
 * `theme` is the fixed taxonomy config/weights.yaml#themes defines — chrome,
 * not content, so it renders through the dictionary (`theme.*`) rather than
 * the raw slug the fit and the DB pass around. Unrecognised slugs (there
 * shouldn't be any: "other" is the fallback slot the config itself reserves)
 * degrade to a readable label rather than the literal `theme.foo` key `t()`
 * would otherwise return, or a crash.
 */
function themeLabel(theme: string, messages: Messages): string {
  const key = `theme.${theme}`;
  const label = t(messages, key);
  return label !== key ? label
    : theme.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

const WINDOW_LABEL_KEY: Record<MapRange, string> = {
  "24h": "map.windowLast24h",
  week: "map.windowThisWeek",
};

function windowLabel(range: MapRange, messages: Messages): string {
  return t(messages, WINDOW_LABEL_KEY[range]);
}

/**
 * English-only, deliberately, in both locales: the svg's own aria-label
 * below is a dynamically composed accessibility sentence (item counts
 * folded in), not visible chrome with a Persian rendering to match against
 * — see this task's report for the full reasoning next to the section
 * aria-label just above it, which gets the identical treatment.
 */
const WINDOW_LABEL_EN: Record<MapRange, string> = { "24h": "in the last 24h", week: "this week" };


const FATE_WORD = {
  posted: "posted to the channel",
  held: "held for the rollup",
  quiet: "not sent to the channel",
} as const;

/**
 * `headline` is passed in already resolved for the locale (Persian when
 * available, English otherwise) rather than read off `item` directly — this
 * is the one string on the tile that must agree with what the label itself
 * renders, so there is exactly one place (market-map.tsx's cell loop) that
 * decides it.
 *
 * When Persian fell back to English, the title says so too, in the same
 * dictionary voice `SourceLang`'s chip uses elsewhere (`content.
 * sourceEnglishTitle`) — on top of, not instead of, the visible "EN" mark
 * `MapTile` now draws on the tile itself (see map-tiles.tsx's
 * fallbackMarkerBand). Both exist because the tile's own label is drawn as
 * raw SVG `<text>`/`<tspan>`, not HTML: an HTML element such as
 * `SourceLang` renders is not part of SVG's content model for `<text>`, and
 * a browser parsing that markup breaks it OUT of the SVG tree entirely (the
 * HTML parser's "foreign content" rules pop `span` back into the
 * surrounding HTML content) rather than rendering it in place — silently
 * wrong output, not a crash, and a hydration mismatch besides. The title
 * stays because it is free and still useful on hover; the visible mark
 * exists because a hover-only signal is not enough on the panel's most-
 * scanned, least-hovered surface.
 */
function tileTitle(
  item: ScoredItem, headline: string, fallback: boolean, now: Date,
  messages: Messages, gates?: TierGates,
): string {
  const dirWord = item.direction > 0 ? "bullish" : item.direction < 0 ? "bearish" : "neutral";
  const sign = item.direction > 0 ? "+" : "";
  const base = `${headline} — tier ${item.tier} (${FATE_WORD[tierFate(item.tier, gates)]}), `
    + `${dirWord} ${sign}${item.direction} `
    + `(conviction ${item.conviction.toFixed(2)}), ${item.source}, ${fmtAge(item.publishedAt, now)}`;
  return fallback ? `${base} — ${t(messages, "content.sourceEnglishTitle")}` : base;
}

/**
 * `importance` selects the third channel — see map-tiles.tsx's
 * ImportanceTreatment block for what each one draws and what it costs.
 * "none" is the default and is byte-for-byte the map as it shipped, so the
 * option is opt-in at the call site rather than something a reader has to
 * turn off.
 */
export function MarketMap({ items, width, height, range, coverage,
  themeMultipliers, fittedAt, importance = "none", tierGates, locale, messages }: {
  items: ScoredItem[];
  width: number;
  height: number;
  range: MapRange;
  coverage: { scored: number; unscored: number };
  themeMultipliers?: Record<string, number>;
  fittedAt?: string | null;
  importance?: ImportanceTreatment;
  tierGates?: TierGates;
  locale: Locale;
  messages: Messages;
}) {
  const now = new Date();

  if (items.length === 0) {
    // aria-label deliberately English-only in both locales: it names an
    // SVG-accessibility surface, not visible chrome, and has no visible
    // counterpart elsewhere on the page for a Persian rendering to match
    // against — see this task's report for the full reasoning.
    return (
      <section aria-label="Scored news treemap" className="rounded border border-border p-4">
        <p className="text-sm text-muted-foreground">
          {t(messages, "map.noScoredStoriesTemplate").replace("{window}", windowLabel(range, messages))}
          {coverage.unscored > 0
            ? // English keeps its own singular/plural word ("item"/"items");
              // Persian has no such distinction, so the same word covers both.
              ` — ${coverage.unscored} ${t(messages, "map.unscoredItemWord")}` +
              `${locale === "en" && coverage.unscored !== 1 ? "s" : ""} ${t(messages, "map.notShown")}.`
            : "."}
        </p>
      </section>
    );
  }

  const boxes = layoutMap(
    items, { x: 0, y: 0, w: width, h: height }, THEME_HEADER_H, themeMultipliers);
  // The footer's fit line must not rest on fittedAt alone: weights.json's
  // fitted_at is one top-level timestamp shared by every fit type, so a
  // caller could pass a truthy fittedAt from a technical-only fit run
  // alongside empty themeMultipliers, and the footer would date a theme fit
  // that has never run. Deriving the claim from both inputs here — rather
  // than trusting a caller to keep them in sync — is what keeps a second call
  // site, or a future edit to either this file or the page, from quietly
  // reintroducing that.
  const hasMultipliers = Object.keys(themeMultipliers ?? {}).length > 0;

  return (
    // id is the fullscreen target: FullscreenButton is a client component and
    // resolves it with getElementById, because a server component cannot hold
    // or hand over a ref. bg-background is load-bearing rather than cosmetic —
    // a fullscreened element inherits no background, so the browser paints
    // behind it black and the map would float on it.
    // Pinned LTR: the panel flips to dir="rtl" in Persian, and every
    // instrument here is positioned along a left-to-right time axis.
    // Mirroring them would reverse the axis for no reader's benefit.
    <section id={MAP_ELEMENT_ID} aria-label="Scored news treemap" dir="ltr"
      className="rounded border border-border p-4 bg-background">
      <div className="mb-2 flex items-center justify-end">
        <FullscreenButton targetId={MAP_ELEMENT_ID} />
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img"
        aria-label={`scored news treemap, ${items.length} scored stories ${WINDOW_LABEL_EN[range]}`}>
        <MapHatchDefs />
        {boxes.map(box => (
          <g key={box.theme}>
            <MapGroupHeader x={box.x} y={box.y} w={box.w}
              label={themeLabel(box.theme, messages)} />
            {box.items.map(cell => {
              const tn = tone(cell.node.direction, cell.node.conviction);
              // Persian when the translate pass has filled it, English
              // otherwise — this is the ONE resolution of the headline for
              // the tile, shared by both the wrapped label below and the
              // hover title, so the two can never disagree about which
              // language is on screen.
              const { text: headline, fallback } =
                localized(cell.node, "headline", locale);
              // The headline is sized to its own tile rather than to one
              // map-wide constant — see map-tiles.tsx#fitLabel. When an
              // importance treatment reserves a band, the label is fitted to
              // what is LEFT of the tile, not to the whole of it: fitting it
              // to the whole tile and then sliding it down is exactly how a
              // reserved band turns into an overflow at the other edge.
              const inset = importanceInsets(importance, cell.w, cell.h);
              // Reserved the same way importanceInsets' own bands are: out
              // of the label's box before fitLabel runs, never appended
              // into the headline text itself — see map-tiles.tsx's
              // fallbackMarkerBand for why, and for why market-map.tsx
              // (sizing the label) and MapTile (positioning the marker)
              // both call this one function rather than each computing
              // their own answer.
              const fbBand = fallbackMarkerBand(importance, cell.w, cell.h, fallback);
              const label = fitLabel(headline, cell.w,
                cell.h - inset.top - inset.bottom - fbBand);
              return (
                <MapTile key={cell.node.itemId}
                  x={cell.x} y={cell.y} w={cell.w} h={cell.h}
                  tone={tn}
                  title={tileTitle(cell.node, headline, fallback, now, messages, tierGates)}
                  lines={label.lines} fontSize={label.fontSize}
                  importance={importance} tier={cell.node.tier} gates={tierGates}
                  fallback={fallback} />
              );
            })}
          </g>
        ))}
      </svg>
      <MapLegend importance={importance} messages={messages} />
      <p className="mt-2 text-xs text-muted-foreground">
        {/* English keeps "scored story"/"scored stories" (adjective-noun,
            pluralized); Persian's natural order is noun-then-adjective, and
            has no plural to carry, so the two locales compose the same three
            dictionary words in a different order rather than forcing one
            template to read naturally in both. */}
        {locale === "fa"
          ? <>{coverage.scored} {t(messages, "map.storyWord")} {t(messages, "map.scoredWord")}</>
          : <>{coverage.scored} {t(messages, "map.scoredWord")}{" "}
              {t(messages, coverage.scored === 1 ? "map.storyWord" : "map.storiesWord")}</>}
        {" "}{windowLabel(range, messages)}
        {" "}· {coverage.unscored} {t(messages, "map.unscoredNotShownFooter")}
        {/* Area is the triage tier, full stop — see the header comment. The
            theme fit is still worth dating here because it is the other
            number this map is built from and the desk has no other view of
            its freshness; it is named as NOT an area term so the line cannot
            be read as the rescale claim it replaced. */}
        {fittedAt && hasMultipliers
          ? <> · {t(messages, "map.areaIsTier")} · {t(messages, "map.themeFit")}{" "}
              {fmtAge(fittedAt, now)}, {t(messages, "map.notAppliedToArea")}</>
          : <> · {t(messages, "map.areaIsTier")} · {t(messages, "map.themeFitNotRun")}</>}
      </p>
    </section>
  );
}
