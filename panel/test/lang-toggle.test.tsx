import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LangToggle } from "@/components/lang-toggle";
import en from "@/messages/en.json";

vi.mock("@/lib/actions", () => ({ setLocale: vi.fn() }));

const messages = en as Record<string, string>;

// This project has no @testing-library/react (see top-bar.test.tsx and
// side-nav.test.tsx) and no jest-dom matchers, so the render + accessible
// name assertions from the plan are expressed the same way every other
// shell component test does it: renderToStaticMarkup plus a string check
// against the rendered markup, not screen.getByRole/toHaveAccessibleName.

function renderButton(locale: "en" | "fa"): string {
  const html = renderToStaticMarkup(<LangToggle locale={locale} messages={messages} />);
  return html.match(/<button\b[^]*?<\/button>/)![0];
}

function ariaLabel(buttonHtml: string): string {
  return buttonHtml.match(/aria-label="([^"]*)"/)![1];
}

function visibleText(buttonHtml: string): string {
  // The icon is aria-hidden, and lucide-react renders it as bare
  // <svg><path .../></svg> markup with no text nodes, so stripping tags
  // leaves exactly the glyph from the trailing <span>.
  return buttonHtml.replace(/<[^>]*>/g, "").trim();
}

describe("LangToggle", () => {
  it("offers Persian when the panel is in English", () => {
    const button = renderButton("en");
    expect(ariaLabel(button)).toBe(`${messages["lang.fa"]} — ${messages["lang.switchToFa"]}`);
    expect(button).toContain(messages["lang.fa"]);
  });

  it("offers English when the panel is in Persian", () => {
    const button = renderButton("fa");
    expect(ariaLabel(button)).toBe(`${messages["lang.en"]} — ${messages["lang.switchToEn"]}`);
    expect(button).toContain(messages["lang.en"]);
  });

  // WCAG 2.5.3 Label in Name: the visible text on the button is the glyph
  // ("EN"/"فا"), not the action phrase. A voice-control user speaks what
  // they SEE, so "click فا" only works if "فا" literally appears in the
  // accessible name — that's what leading the label with the glyph buys.
  // Pinning the property itself, rather than the exact composed string,
  // means a future edit that "simplifies" the label back to just the
  // action phrase fails this test without anyone needing to remember why.
  it("contains its own visible text in the accessible name (WCAG 2.5.3 Label in Name)", () => {
    for (const locale of ["en", "fa"] as const) {
      const button = renderButton(locale);
      expect(ariaLabel(button)).toContain(visibleText(button));
    }
  });

  // The glyph alone doesn't say what the button DOES, so a screen-reader
  // user — who never sees "فا" to begin with — still needs the action
  // phrase spoken after it.
  it("also names the action, for screen-reader users who can't see the glyph", () => {
    expect(ariaLabel(renderButton("en"))).toContain(messages["lang.switchToFa"]);
    expect(ariaLabel(renderButton("fa"))).toContain(messages["lang.switchToEn"]);
  });
});
