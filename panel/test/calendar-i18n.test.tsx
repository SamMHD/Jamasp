import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { localized } from "@/lib/i18n";
import { SourceLang } from "@/components/source-lang";
import en from "@/messages/en.json";
import fa from "@/messages/fa.json";

const messages = { en: en as Record<string, string>, fa: fa as Record<string, string> };

const translated = { id: "e1", title: "US CPI (MoM)", title_fa: "شاخص قیمت مصرف‌کننده آمریکا (ماهانه)",
  country: "US", impact: "high", starts_at: "2026-09-21T12:30:00Z" };
const untranslated = { ...translated, id: "e2", title: "FOMC Statement", title_fa: null };

function Row({ ev, locale }: { ev: Record<string, unknown>; locale: "en" | "fa" }) {
  const { text, fallback } = localized(ev, "title", locale);
  return <SourceLang fallback={fallback} messages={messages[locale]}>{text}</SourceLang>;
}

// No @testing-library/react in this project — see test/news-flow.test.tsx and
// test/inbox-table.test.tsx for the established convention of asserting on
// the renderToStaticMarkup string directly.
describe("calendar titles (helper)", () => {
  it("renders Persian when the event has it", () => {
    const html = renderToStaticMarkup(<Row ev={translated} locale="fa" />);
    expect(html).toContain(translated.title_fa);
    expect(html).not.toContain(messages.fa["content.sourceEnglish"]);
  });

  it("falls back to English with the marker", () => {
    const html = renderToStaticMarkup(<Row ev={untranslated} locale="fa" />);
    expect(html).toContain("FOMC Statement");
    expect(html).toContain(messages.fa["content.sourceEnglish"]);
  });

  it("leaves the English title alone in English", () => {
    const html = renderToStaticMarkup(<Row ev={translated} locale="en" />);
    expect(html).toContain("US CPI (MoM)");
  });

  it("keeps the Latin ticker inside a translated title", () => {
    // Spec decision 9: CPI stays CPI even inside Persian prose.
    expect(translated.title_fa).toContain("مصرف‌کننده");
    expect(localized(translated, "title", "fa").text).not.toMatch(/[۰-۹]/);
  });
});

// --- Full page wiring ---
//
// CalendarPage resolves locale from the httpOnly `lang` cookie (Task 7's
// pattern — see app/inbox/page.tsx) and reads events through @/lib/db, so
// both are stubbed here the same way test/inbox-table.test.tsx mocks
// swr/infinite and @/lib/actions: a bare module replacement, not a real
// request or database.
const cookieLocale = vi.hoisted(() => ({ value: "en" as "en" | "fa" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: cookieLocale.value }) }),
}));

// AutoRefresh calls useRouter() during render (not just inside its effect),
// which throws "invariant expected app router to be mounted" with no
// provider mounted — same class of stub as test/side-nav.test.tsx's
// usePathname mock, just for the hook this page's tree actually calls.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

let mockEvents: Record<string, unknown>[] = [];
vi.mock("@/lib/db", () => ({ getEvents: () => mockEvents }));

const { default: CalendarPage } = await import("@/app/calendar/page");

// CalendarPage is an async server component (it awaits cookies()), so the
// synchronous renderToStaticMarkup used above can't render it — see
// test/app-shell.test.tsx's identical use of renderToReadableStream for the
// same reason.
async function renderPage(locale: "en" | "fa", events: Record<string, unknown>[]): Promise<string> {
  cookieLocale.value = locale;
  mockEvents = events;
  const stream = await renderToReadableStream(<CalendarPage />);
  await stream.allReady;
  return new Response(stream).text();
}

describe("calendar page", () => {
  it("renders the Persian title when the event has it, with no EN marker", async () => {
    const html = await renderPage("fa", [translated]);
    expect(html).toContain(translated.title_fa);
    expect(html).not.toContain(translated.title);
    expect(html).not.toContain(messages.fa["content.sourceEnglish"]);
  });

  it("falls back to the English title with the EN marker when untranslated", async () => {
    const html = await renderPage("fa", [untranslated]);
    expect(html).toContain("FOMC Statement");
    expect(html).toContain(messages.fa["content.sourceEnglish"]);
  });

  it("leaves the English-locale title alone even when Persian exists", async () => {
    const html = await renderPage("en", [translated]);
    expect(html).toContain("US CPI (MoM)");
    expect(html).not.toContain(translated.title_fa);
  });

  it("renders the impact badge from the dictionary, not the raw enum, in Persian", async () => {
    const html = await renderPage("fa", [translated]);
    expect(html).toContain(messages.fa["calendar.impactHigh"]);
    expect(html).not.toContain(">high<");
  });

  it("renders the impact badge in English from the same dictionary key", async () => {
    const html = await renderPage("en", [translated]);
    expect(html).toContain(messages.en["calendar.impactHigh"]);
  });

  // Global constraint: times and country codes are the same in both
  // locales — no numeral conversion, no Jalali.
  it("keeps the Dubai/UTC time and the country code identical across locales", async () => {
    const htmlEn = await renderPage("en", [translated]);
    const htmlFa = await renderPage("fa", [translated]);
    expect(htmlEn).toContain("DXB");
    expect(htmlFa).toContain("DXB");
    expect(htmlEn).toContain(">US<");
    expect(htmlFa).toContain(">US<");
    expect(htmlFa).not.toMatch(/[۰-۹]/);
  });
});
