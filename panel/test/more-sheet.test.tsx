import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OVERFLOW } from "@/lib/nav";
import { getMessages } from "@/lib/i18n";
import en from "@/messages/en.json";
import fa from "@/messages/fa.json";

/**
 * The mobile overflow sheet — the one nav surface nobody would notice going
 * English, because it lives behind a tap on a phone while every other nav
 * label on the same screen is already translated.
 *
 * Asserted through the exported MoreSheetNav rather than MoreSheet itself:
 * DialogContent sits inside a Radix Portal, which renders nothing under
 * renderToStaticMarkup (no document, and this project has no jsdom), so a
 * static render of the sheet is an empty string however `open` is set.
 * Verified empirically — the first version of this file rendered MoreSheet
 * and every assertion failed against "". Same escape hatch, and same
 * reason, as components/inbox-table.tsx's ItemHeadline.
 */
const pathname = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

const { MoreSheetNav } = await import("@/components/shell/more-sheet");

const messages = { en: getMessages("en"), fa: getMessages("fa") };

const render = (locale: "en" | "fa", path = "/") =>
  renderToStaticMarkup(
    <MoreSheetNav path={path} messages={messages[locale]} onNavigate={() => {}} />);

describe("MoreSheetNav", () => {
  it("translates every overflow label, not just the first", () => {
    const html = render("fa");
    for (const { labelKey } of OVERFLOW) {
      const label = fa[labelKey as keyof typeof fa];
      expect(label?.trim(), `${labelKey} is missing from fa.json`).toBeTruthy();
      expect(html, `${labelKey} did not render in Persian`).toContain(label);
    }
  });

  it("leaves no English nav label behind in Persian", () => {
    // The real regression shape: one row still reading its en.json string
    // while the other five are Persian. Asserted per key, because a single
    // "does this contain English anywhere" check passes on five of six.
    const html = render("fa");
    for (const { labelKey } of OVERFLOW) {
      expect(html, `${labelKey} rendered the English label`)
        .not.toContain(`>${en[labelKey as keyof typeof en]}<`);
    }
  });

  it("renders all six destinations, not a subset", () => {
    const html = render("fa");
    expect(OVERFLOW).toHaveLength(6);
    for (const { href } of OVERFLOW) {
      expect(html, `${href} is missing from the sheet`).toContain(`href="${href}"`);
    }
  });

  it("translates the nav's own aria-label", () => {
    // It was a raw English "More sections" — invisible on screen, and the
    // only thing a Persian screen-reader user hears naming this list.
    const html = render("fa");
    expect(html).toContain(`aria-label="${fa["nav.moreSections"]}"`);
    expect(html).not.toContain('aria-label="More sections"');
  });

  it("renders the same six through the English dictionary", () => {
    const html = render("en");
    for (const { labelKey } of OVERFLOW) {
      expect(html).toContain(en[labelKey as keyof typeof en]);
    }
    expect(html).toContain(`aria-label="${en["nav.moreSections"]}"`);
  });

  it("marks the current route and only the current route", () => {
    // Also guards the label assertions above against passing on a tree that
    // never actually rendered its rows.
    const html = render("fa", "/calendar");
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1);
  });
});

/**
 * The dialog TITLE cannot be rendered here for the portal reason above, and
 * DialogTitle is a Radix primitive that throws outside a Dialog context, so
 * it is asserted at the dictionary instead — the same treatment
 * test/schedule-forms.test.tsx gives its runType.* labels. This is a
 * narrower claim than the row assertions above, and deliberately stated as
 * such rather than dressed up as a render test.
 */
describe("MoreSheet — dictionary sanity", () => {
  it("has a non-empty Persian nav.more for the sheet's title", () => {
    expect(fa["nav.more"]?.trim()).toBeTruthy();
    expect(en["nav.more"]?.trim()).toBeTruthy();
    expect(fa["nav.more"]).not.toBe(en["nav.more"]);
  });
});
