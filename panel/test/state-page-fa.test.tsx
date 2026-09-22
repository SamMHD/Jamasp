import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import fa from "@/messages/fa.json";
import type { Prediction, WatchlistEntry } from "@/lib/files";

// Same stubbing shape as test/calendar-i18n.test.tsx's "Full page wiring"
// section: StatePage is an async server component reading the locale
// cookie and the state/ files directly, so both are replaced with bare
// module mocks rather than a real request or filesystem.
const cookieLocale = vi.hoisted(() => ({ value: "en" as "en" | "fa" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: cookieLocale.value }) }),
}));

// AutoRefresh calls useRouter() during render — see test/calendar-i18n.test.tsx's
// identical mock for the same reason.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const mockFiles = vi.hoisted(() => ({
  stance: null as string | null,
  stanceFa: null as { sections: { heading: string; hash: string; body: string }[] } | null,
  playbook: null as string | null,
  playbookFa: null as string | null,
  watchlist: [] as WatchlistEntry[],
  watchlistFa: {} as Record<string, string>,
  predictions: [] as Prediction[],
  predictionsFa: {} as Record<string, string>,
}));
vi.mock("@/lib/files", () => ({
  readStance: () => mockFiles.stance,
  readStanceFa: () => mockFiles.stanceFa,
  readPlaybook: () => mockFiles.playbook,
  readPlaybookFa: () => mockFiles.playbookFa,
  readWatchlist: () => mockFiles.watchlist,
  readWatchlistFa: () => mockFiles.watchlistFa,
  readPredictions: () => mockFiles.predictions,
  readPredictionsFa: () => mockFiles.predictionsFa,
  predictionStats: () => ({ open: 0, maturedUnscored: 0, scored: 0,
    hits: 0, misses: 0, unclear: 0, hitRate: null }),
}));

const { default: StatePage } = await import("@/app/state/page");

async function renderPage(locale: "en" | "fa"): Promise<string> {
  cookieLocale.value = locale;
  const stream = await renderToReadableStream(<StatePage />);
  await stream.allReady;
  return new Response(stream).text();
}

const englishStance = "# Stance — 2026-08-01\n\nGold constructive on soft CPI.\n";
const englishPlaybook = "# Playbook\n\nHold the line on real yields.\n";

describe("state page (stance/playbook Persian sidecars)", () => {
  it("renders the sidecar's body when the hash matches, with no marker", async () => {
    mockFiles.stance = englishStance;
    mockFiles.stanceFa = { sections: [
      { heading: "", hash: "h0", body: "طلا رو به رشد بر اساس شاخص قیمت مصرف‌کننده ملایم.\n" },
    ] };
    mockFiles.playbook = null;
    mockFiles.playbookFa = null;

    const html = await renderPage("fa");
    expect(html).toContain("طلا رو به رشد");
    expect(html).not.toContain("Gold constructive");
    expect(html).not.toContain('lang="en"');
  });

  it("falls back to the English stance with one marker when the sidecar is absent", async () => {
    mockFiles.stance = englishStance;
    mockFiles.stanceFa = null;
    mockFiles.playbook = null;
    mockFiles.playbookFa = null;

    const html = await renderPage("fa");
    expect(html).toContain("Gold constructive on soft CPI");
    expect((html.match(/lang="en"/g) ?? []).length).toBe(1);
    expect(html).toContain(fa["content.sourceEnglishTitle" as keyof typeof fa]);
  });

  it("leaves the English locale unaffected even when a Persian sidecar exists", async () => {
    mockFiles.stance = englishStance;
    mockFiles.stanceFa = { sections: [{ heading: "", hash: "h0", body: "متن فارسی\n" }] };
    mockFiles.playbook = null;
    mockFiles.playbookFa = null;

    const html = await renderPage("en");
    expect(html).toContain("Gold constructive on soft CPI");
    expect(html).not.toContain("متن فارسی");
    expect(html).not.toContain('lang="en"');
  });

  // Fix round 1: the writer can leave the sidecar's TOP-LEVEL hash matching
  // while one section still carries the empty-hash hazard (a failed or
  // budget-skipped section with no prior Persian — see
  // lib/files.ts#readStanceFa's doc comment). This page has no per-section
  // marker to hang on just that section, so it must discard the WHOLE
  // sidecar rather than splice that section's literal English into an
  // otherwise-Persian block with no marker at all.
  it("falls back to the whole English stance, marked, when any section has an empty hash", async () => {
    mockFiles.stance = englishStance;
    mockFiles.stanceFa = { sections: [
      { heading: "", hash: "h0", body: "طلا رو به رشد بر اساس شاخص قیمت مصرف‌کننده ملایم.\n" },
      // The hazard: hash is empty even though this "sidecar" otherwise
      // looks usable (readStanceFa is mocked here, so this stands in for a
      // sidecar whose top-level src_hash already matched the source).
      { heading: "", hash: "", body: "some other stale or English body\n" },
    ] };
    mockFiles.playbook = null;
    mockFiles.playbookFa = null;

    const html = await renderPage("fa");
    // The real English stance, verbatim — not a half-Persian splice.
    expect(html).toContain("Gold constructive on soft CPI");
    expect(html).not.toContain("طلا رو به رشد");
    expect(html).not.toContain("some other stale or English body");
    expect((html.match(/lang="en"/g) ?? []).length).toBe(1);
    expect(html).toContain(fa["content.sourceEnglishTitle" as keyof typeof fa]);
  });

  /**
   * The per-section twin of readWholeDocumentFa's blank-body hazard: every
   * section can carry a real hash and still have an empty body, and joining
   * them produced "" — which LocalizedDocument's `=== null` gate read as
   * "translation present" and rendered as a blank stance with no EN marker.
   * A blank stance on a trading desk is the worst failure this feature has,
   * and nothing on screen says anything is wrong.
   */
  it("falls back to the marked English stance when every section body is blank", async () => {
    mockFiles.stance = englishStance;
    mockFiles.stanceFa = { sections: [{ heading: "", hash: "h0", body: "" }] };
    mockFiles.playbook = null;
    mockFiles.playbookFa = null;

    const html = await renderPage("fa");
    expect(html).toContain("Gold constructive on soft CPI");
    expect((html.match(/lang="en"/g) ?? []).length).toBe(1);
    expect(html).toContain(fa["content.sourceEnglishTitle" as keyof typeof fa]);
  });

  it("falls back to the marked English stance when the joined sections are only whitespace", async () => {
    mockFiles.stance = englishStance;
    mockFiles.stanceFa = { sections: [
      { heading: "", hash: "h0", body: "\n" }, { heading: "", hash: "h1", body: "  \n" },
    ] };
    mockFiles.playbook = null;
    mockFiles.playbookFa = null;

    const html = await renderPage("fa");
    expect(html).toContain("Gold constructive on soft CPI");
    expect((html.match(/lang="en"/g) ?? []).length).toBe(1);
  });

  /**
   * A blank PLAYBOOK sidecar reaches the page as null already, because
   * readPlaybookFa now collapses blank to absent (see lib/files.ts). This
   * asserts the page's own behaviour given that null, so the two halves of
   * the blank-body fix are both pinned.
   */
  it("falls back to the marked English playbook when its sidecar body is blank", async () => {
    mockFiles.stance = null;
    mockFiles.stanceFa = null;
    mockFiles.playbook = englishPlaybook;
    mockFiles.playbookFa = "   \n";

    const html = await renderPage("fa");
    expect(html).toContain("Hold the line on real yields");
    expect((html.match(/lang="en"/g) ?? []).length).toBe(1);
  });

  /**
   * The page concatenated section BODIES and dropped every heading anchor,
   * so Persian was one flat blob where English has "## View" and
   * "## What flips me". The old code comment said the page "has no
   * dictionary to render a canonical heading through" — but
   * STANCE_HEADING_KEYS in fundamental-panel.tsx is exactly that dictionary.
   */
  it("renders canonical Persian headings for the stance's sections", async () => {
    mockFiles.stance = [
      "# Stance — 2026-08-01", "", "Preamble line.", "",
      "## View", "", "Gold constructive.", "",
      "## What flips me", "", "A hot CPI print.", "",
    ].join("\n");
    mockFiles.stanceFa = { sections: [
      { heading: "", hash: "h0", body: "خط آغازین.\n" },
      { heading: "View", hash: "h1", body: "طلا رو به رشد.\n" },
      { heading: "What flips me", hash: "h2", body: "یک شاخص قیمت داغ.\n" },
    ] };
    mockFiles.playbook = null;
    mockFiles.playbookFa = null;

    const html = await renderPage("fa");
    // The Persian bodies are all there...
    expect(html).toContain("خط آغازین.");
    expect(html).toContain("طلا رو به رشد.");
    expect(html).toContain("یک شاخص قیمت داغ.");
    // ...each under its canonical Persian heading, rendered as a real
    // heading element rather than swallowed into the prose.
    expect(html).toContain(`>${fa["stance.view"]}<`);
    expect(html).toContain(`>${fa["stance.whatFlipsMe"]}<`);
    // The English anchors never reach the screen.
    expect(html).not.toContain(">View<");
    expect(html).not.toContain(">What flips me<");
    // Still no marker: this is a complete translation.
    expect(html).not.toContain('lang="en"');
  });

  it("keeps an ad-hoc section's own heading, which has no canonical key", async () => {
    mockFiles.stance = [
      "# Stance — 2026-08-01", "", "Preamble.", "",
      "## View", "", "Gold constructive.", "",
      "## Watching the Strait", "", "Tanker traffic thinning.", "",
    ].join("\n");
    mockFiles.stanceFa = { sections: [
      { heading: "", hash: "h0", body: "پیش‌درآمد.\n" },
      { heading: "View", hash: "h1", body: "طلا رو به رشد.\n" },
      { heading: "Watching the Strait", hash: "h2", body: "ترافیک نفتکش‌ها کم شده.\n" },
    ] };
    mockFiles.playbook = null;
    mockFiles.playbookFa = null;

    const html = await renderPage("fa");
    expect(html).toContain(fa["stance.view"]);
    // Free-form agent prose, not a closed enum — there is no dictionary key
    // for it, so the anchor the job wrote is the only heading available.
    expect(html).toContain("Watching the Strait");
    expect(html).toContain("ترافیک نفتکش‌ها کم شده.");
  });

  it("leaves the English stance's own headings alone in the English locale", async () => {
    mockFiles.stance = [
      "# Stance — 2026-08-01", "", "Preamble.", "", "## View", "", "Gold constructive.", "",
    ].join("\n");
    mockFiles.stanceFa = { sections: [
      { heading: "", hash: "h0", body: "پیش‌درآمد.\n" },
      { heading: "View", hash: "h1", body: "طلا رو به رشد.\n" },
    ] };
    mockFiles.playbook = null;
    mockFiles.playbookFa = null;

    const html = await renderPage("en");
    expect(html).toContain("View");
    expect(html).toContain("Gold constructive.");
    expect(html).not.toContain("طلا رو به رشد.");
  });

  it("renders the playbook sidecar independently of the stance sidecar", async () => {
    mockFiles.stance = null;
    mockFiles.stanceFa = null;
    mockFiles.playbook = englishPlaybook;
    mockFiles.playbookFa = "نگه‌داشتن خط در بازده واقعی.\n";

    const html = await renderPage("fa");
    expect(html).toContain("نگه‌داشتن خط در بازده واقعی");
    expect(html).not.toContain("Hold the line on real yields");
  });
});

// Task 11's own required wiring: the watchlist's `why` and each prediction's
// `claim`, through readWatchlistFa()/readPredictionsFa() keyed by
// theme/id respectively — the part of this page Task 9 explicitly left for
// this task (see the plan's pre-flight scan: "T9 stance section; T11
// watchlist section").
describe("state page — watchlist and predictions Persian wiring", () => {
  it("renders the watchlist's Persian why with no EN marker when the sidecar matches, keeping the theme slug Latin", async () => {
    mockFiles.stance = null; mockFiles.stanceFa = null;
    mockFiles.playbook = null; mockFiles.playbookFa = null;
    mockFiles.watchlist = [
      { theme: "fed-rate-path", why: "dominant driver of real yields", since: "2026-07-31" },
    ];
    mockFiles.watchlistFa = { "fed-rate-path": "محرک اصلی بازده واقعی" };
    mockFiles.predictions = [];
    mockFiles.predictionsFa = {};

    const html = await renderPage("fa");
    expect(html).toContain("fed-rate-path"); // the theme slug stays Latin
    expect(html).toContain("محرک اصلی بازده واقعی");
    expect(html).not.toContain("dominant driver of real yields");
    expect(html).not.toContain(fa["content.sourceEnglish"]);
  });

  it("falls back to the watchlist's English why with the EN marker when the theme has no sidecar entry", async () => {
    mockFiles.stance = null; mockFiles.stanceFa = null;
    mockFiles.playbook = null; mockFiles.playbookFa = null;
    mockFiles.watchlist = [
      { theme: "mecca-pact", why: "Gulf supply-side risk", since: "2026-08-01" },
    ];
    mockFiles.watchlistFa = {}; // still queued behind the translate job's budget
    mockFiles.predictions = [];
    mockFiles.predictionsFa = {};

    const html = await renderPage("fa");
    expect(html).toContain("Gulf supply-side risk");
    expect(html).toContain(fa["content.sourceEnglish"]);
  });

  it("renders a prediction's Persian claim with no EN marker when the sidecar matches", async () => {
    mockFiles.stance = null; mockFiles.stanceFa = null;
    mockFiles.playbook = null; mockFiles.playbookFa = null;
    mockFiles.watchlist = []; mockFiles.watchlistFa = {};
    mockFiles.predictions = [{
      id: "p1", date: "2026-08-01", claim: "Gold clears 3400 before the next FOMC.",
      direction: "up", horizon_days: 5, confidence: 0.7,
      created_at: "2026-08-01T00:00:00Z", outcome: null, scored_at: null, note: null,
    }];
    mockFiles.predictionsFa = { p1: "طلا قبل از نشست بعدی FOMC از ۳۴۰۰ عبور می‌کند." };

    const html = await renderPage("fa");
    expect(html).toContain("طلا قبل از نشست بعدی FOMC از ۳۴۰۰ عبور می‌کند.");
    expect(html).not.toContain("Gold clears 3400 before the next FOMC.");
    expect(html).not.toContain(fa["content.sourceEnglish"]);
  });

  it("falls back to a prediction's English claim with the EN marker when untranslated", async () => {
    mockFiles.stance = null; mockFiles.stanceFa = null;
    mockFiles.playbook = null; mockFiles.playbookFa = null;
    mockFiles.watchlist = []; mockFiles.watchlistFa = {};
    mockFiles.predictions = [{
      id: "p2", date: "2026-08-01", claim: "DXY breaks below 100.",
      direction: "down", horizon_days: 5, confidence: 0.6,
      created_at: "2026-08-01T00:00:00Z", outcome: null, scored_at: null, note: null,
    }];
    mockFiles.predictionsFa = {};

    const html = await renderPage("fa");
    expect(html).toContain("DXY breaks below 100.");
    expect(html).toContain(fa["content.sourceEnglish"]);
  });

  it("translates the direction and outcome enums, and the page/section chrome", async () => {
    mockFiles.stance = null; mockFiles.stanceFa = null;
    mockFiles.playbook = null; mockFiles.playbookFa = null;
    mockFiles.watchlist = []; mockFiles.watchlistFa = {};
    mockFiles.predictions = [{
      id: "p3", date: "2026-08-01", claim: "c", direction: "down", horizon_days: 5,
      confidence: 0.6, created_at: "2026-08-01T00:00:00Z",
      outcome: "hit", scored_at: "2026-08-06T00:00:00Z", note: null,
    }];
    mockFiles.predictionsFa = {};

    const html = await renderPage("fa");
    expect(html).toContain(fa["nav.state"]);
    expect(html).toContain(fa["state.stanceHeading"]);
    expect(html).toContain(fa["state.watchlistHeading"]);
    expect(html).toContain(fa["nav.predictions"]);
    expect(html).toContain(fa["state.playbookHeading"]);
    expect(html).toContain(fa["direction.down"]);
    expect(html).toContain(fa["predictions.wordHit"]);
    expect(html).not.toContain(">down<");
    expect(html).not.toMatch(/[۰-۹]/); // confidence/horizon/date stay Latin
  });
});
