import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import fa from "@/messages/fa.json";

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
}));
vi.mock("@/lib/files", () => ({
  readStance: () => mockFiles.stance,
  readStanceFa: () => mockFiles.stanceFa,
  readPlaybook: () => mockFiles.playbook,
  readPlaybookFa: () => mockFiles.playbookFa,
  readWatchlist: () => [],
  readPredictions: () => [],
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
