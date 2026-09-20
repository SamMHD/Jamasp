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
// against the rendered attribute, not screen.getByRole/toHaveAccessibleName.
describe("LangToggle", () => {
  it("offers Persian when the panel is in English", () => {
    const html = renderToStaticMarkup(<LangToggle locale="en" messages={messages} />);
    const button = html.match(/<button\b[^>]*>/)![0];
    expect(button).toContain(`aria-label="${messages["lang.switchToFa"]}"`);
    expect(html).toContain(messages["lang.fa"]);
  });

  it("offers English when the panel is in Persian", () => {
    const html = renderToStaticMarkup(<LangToggle locale="fa" messages={messages} />);
    const button = html.match(/<button\b[^>]*>/)![0];
    expect(button).toContain(`aria-label="${messages["lang.switchToEn"]}"`);
    expect(html).toContain(messages["lang.en"]);
  });

  it("labels the control for screen readers rather than relying on the glyph", () => {
    // Two letters are not a label. The accessible name says what the
    // button DOES, which is also what a voice-control user has to say.
    const html = renderToStaticMarkup(<LangToggle locale="en" messages={messages} />);
    const button = html.match(/<button\b[^>]*>/)![0];
    expect(button).toContain("aria-label=");
  });
});
