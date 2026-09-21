import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PredictionList } from "@/components/prediction-list";
import type { Prediction } from "@/lib/files";
import { buildLedger } from "@/lib/predictions";
import { getMessages } from "@/lib/i18n";
import fa from "@/messages/fa.json";

const NOW = new Date("2026-08-10T00:00:00Z");
const messages = { en: getMessages("en"), fa: getMessages("fa") };

function pred(over: Partial<Prediction> = {}): Prediction {
  return {
    id: "abc12345", date: "2026-08-01", claim: "GC holds 3300 through the week",
    direction: "up", horizon_days: 5, confidence: 0.7,
    created_at: "2026-08-01T00:00:00Z", outcome: null, scored_at: null, note: null,
    ...over,
  };
}

const render = (
  preds: Prediction[],
  locale: "en" | "fa" = "en",
  predictionsFa: Record<string, string> = {},
) => renderToStaticMarkup(
  <PredictionList rows={buildLedger(preds, NOW)} now={NOW} empty="nothing here"
    locale={locale} messages={messages[locale]} predictionsFa={predictionsFa} />);

describe("PredictionList", () => {
  it("renders the claim, direction, confidence, horizon and made-date of a row", () => {
    const html = render([pred({ direction: "down", confidence: 0.65, horizon_days: 3 })]);
    expect(html).toContain("GC holds 3300 through the week");
    expect(html).toContain("down");
    expect(html).toContain("65% conf");
    expect(html).toContain("3d horizon");
    expect(html).toContain("made 2026-08-01");
    expect(html).toContain("abc12345");
  });

  it("names every state in words, never colour alone", () => {
    const html = render([
      pred({ id: "h1", outcome: "hit", scored_at: "2026-08-06T00:00:00Z" }),
      pred({ id: "m1", outcome: "miss", scored_at: "2026-08-06T00:00:00Z" }),
      pred({ id: "u1", outcome: "unclear", scored_at: "2026-08-06T00:00:00Z" }),
      pred({ id: "o1", horizon_days: 30 }),
      pred({ id: "d1", horizon_days: 2 }),
    ]);
    for (const word of ["hit", "miss", "unclear", "open", "due"]) {
      expect(html).toContain(`>${word}</span>`);
    }
  });

  it("uses the Forecast-record card's own hit/miss colours", () => {
    // Same classes the calibration chart's arms wear — see
    // components/prediction-panel.tsx. Two pages, one colour language.
    const html = render([
      pred({ id: "h1", outcome: "hit", scored_at: "2026-08-06T00:00:00Z" }),
      pred({ id: "m1", outcome: "miss", scored_at: "2026-08-06T00:00:00Z" }),
    ]);
    expect(html).toContain("text-emerald-700 dark:text-emerald-400");
    expect(html).toContain("text-destructive");
  });

  it("flags a matured-but-unscored claim in the card's amber, with how long it has waited", () => {
    const html = render([pred({ created_at: "2026-08-05T00:00:00Z", horizon_days: 2 })]);
    expect(html).toContain("text-amber-600 dark:text-amber-400");
    expect(html).toContain("matured 3d ago");
  });

  it("says when a live claim lands, and when a scored one was settled", () => {
    const open = render([pred({ created_at: "2026-08-09T00:00:00Z", horizon_days: 3 })]);
    expect(open).toContain("matures in 2d");
    const done = render([pred({ outcome: "hit", scored_at: "2026-08-08T00:00:00Z" })]);
    expect(done).toContain("scored 2d ago");
  });

  it("clamps a long claim but keeps the whole thing in the DOM for the disclosure", () => {
    const long = "x".repeat(1400);
    const html = render([pred({ claim: long })]);
    expect(html).toContain("line-clamp-2");
    expect(html).toContain("group-open:line-clamp-none");
    expect(html).toContain(long);   // never truncated server-side
  });

  it("shows the scoring note only in the expanded body", () => {
    const html = render([pred({
      outcome: "miss", scored_at: "2026-08-06T00:00:00Z", note: "settled below on Friday",
    })]);
    expect(html).toContain("settled below on Friday");
    expect(html).toContain("jamasp predictions score abc12345");
  });

  it("renders a malformed confidence as a dash rather than NaN%", () => {
    const html = render([pred({ confidence: Number.NaN })]);
    expect(html).toContain("— conf");
    expect(html).not.toContain("NaN");
  });

  it("says so when there is nothing to list", () => {
    expect(render([])).toContain("nothing here");
  });
});

// /predictions is one of the two surfaces the brief names explicitly for
// readPredictionsFa() wiring (the other, app/state/page.tsx, is covered by
// test/state-page-fa.test.tsx). Asserted against the real fa.json rather
// than a hand-typed guess, so a wording edit there cannot silently desync
// this test — per lib/i18n.ts#localized's own warning (carried since Task
// 5), a mistyped field here would render blank with no marker, so every
// case below asserts the actual Persian text, never just "did not crash".
describe("PredictionList — Persian", () => {
  it("renders the Persian claim with no EN marker when the sidecar has it", () => {
    const html = render(
      [pred({ id: "p1", claim: "Gold clears 3400 before the next FOMC." })],
      "fa",
      { p1: "طلا قبل از نشست بعدی FOMC از ۳۴۰۰ عبور می‌کند." },
    );
    expect(html).toContain("طلا قبل از نشست بعدی FOMC از ۳۴۰۰ عبور می‌کند.");
    expect(html).not.toContain("Gold clears 3400 before the next FOMC.");
    expect(html).not.toContain(fa["content.sourceEnglish"]);
  });

  it("falls back to the English claim with the EN marker when untranslated", () => {
    const html = render([pred({ id: "p2", claim: "DXY breaks below 100." })], "fa", {});
    expect(html).toContain("DXY breaks below 100.");
    expect(html).toContain(fa["content.sourceEnglish"]);
  });

  it("translates the state badge and direction word from the dictionary", () => {
    // created_at + horizon_days must land after NOW (2026-08-10) for this
    // row to classify as "open" rather than "due" (lib/predictions.ts).
    const html = render(
      [pred({ direction: "down", created_at: "2026-08-09T00:00:00Z", horizon_days: 5 })], "fa");
    expect(html).toContain(fa["predictions.wordOpen"]);
    expect(html).toContain(fa["direction.down"]);
    expect(html).not.toContain(">open<");
    expect(html).not.toContain(">down<");
  });

  it("translates the conf/horizon/made words and timing verbs, keeping numbers and units Latin", () => {
    const html = render([pred({
      id: "d1", created_at: "2026-08-05T00:00:00Z", horizon_days: 2, confidence: 0.65,
    })], "fa");
    expect(html).toContain(fa["predictions.confSuffix"]);
    expect(html).toContain(fa["predictions.horizonSuffix"]);
    expect(html).toContain(fa["predictions.madePrefix"]);
    expect(html).toContain(fa["predictions.timingMatured"]);
    expect(html).toContain("65%"); // confidence stays a Latin number
    expect(html).toContain("2d");  // horizon unit stays Latin
    expect(html).not.toMatch(/[۰-۹]/); // no Persian-Indic digits anywhere
  });

  it("keeps English rendering unaffected when a Persian sidecar exists", () => {
    const html = render(
      [pred({ id: "p1", claim: "Gold clears 3400 before the next FOMC." })],
      "en",
      { p1: "طلا قبل از نشست بعدی FOMC از ۳۴۰۰ عبور می‌کند." },
    );
    expect(html).toContain("Gold clears 3400 before the next FOMC.");
    expect(html).not.toContain("طلا");
  });
});
