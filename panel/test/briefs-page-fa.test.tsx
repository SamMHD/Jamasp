import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import fa from "@/messages/fa.json";

// Same stubbing shape as test/state-page-fa.test.tsx: BriefPage is an async
// server component reading the locale cookie and the reports/ files
// directly, so both are replaced with bare module mocks rather than a real
// request or filesystem.
const cookieLocale = vi.hoisted(() => ({ value: "en" as "en" | "fa" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: cookieLocale.value }) }),
}));

const mockFiles = vi.hoisted(() => ({
  report: null as string | null,
  reportFa: null as string | null,
}));
vi.mock("@/lib/files", () => ({
  readReport: () => mockFiles.report,
  readReportFa: () => mockFiles.reportFa,
}));

const { default: BriefPage } = await import("@/app/briefs/[...slug]/page");

async function renderPage(locale: "en" | "fa"): Promise<string> {
  cookieLocale.value = locale;
  const stream = await renderToReadableStream(
    <BriefPage params={Promise.resolve({ slug: ["2026", "08", "2026-08-01-brief"] })} />);
  await stream.allReady;
  return new Response(stream).text();
}

const english = "# Morning Brief — 2026-08-01\n\nGold constructive on soft CPI.\n";
const persian = "گزارش صبحگاهی — طلا رو به رشد.\n";

describe("brief page (report Persian sidecar)", () => {
  it("renders the Persian body with no EN marker when the sidecar's hash matches", async () => {
    mockFiles.report = english;
    mockFiles.reportFa = persian;
    const html = await renderPage("fa");
    expect(html).toContain("گزارش صبحگاهی");
    expect(html).not.toContain("Gold constructive");
    expect(html).not.toContain('lang="en"');
  });

  it("falls back to the English report with one EN marker when the sidecar is absent", async () => {
    mockFiles.report = english;
    mockFiles.reportFa = null; // readReportFa itself returns null on a hash mismatch too
    const html = await renderPage("fa");
    expect(html).toContain("Gold constructive on soft CPI");
    expect((html.match(/lang="en"/g) ?? []).length).toBe(1);
    expect(html).toContain(fa["content.sourceEnglishTitle" as keyof typeof fa]);
  });

  it("leaves the English locale unaffected even when a Persian sidecar exists", async () => {
    mockFiles.report = english;
    mockFiles.reportFa = persian;
    const html = await renderPage("en");
    expect(html).toContain("Gold constructive on soft CPI");
    expect(html).not.toContain("گزارش صبحگاهی");
    expect(html).not.toContain('lang="en"');
  });

  it("translates the back-to-briefs link", async () => {
    mockFiles.report = english;
    mockFiles.reportFa = null;
    const html = await renderPage("fa");
    expect(html).toContain(fa["briefs.backToAllBriefs"]);
  });
});
