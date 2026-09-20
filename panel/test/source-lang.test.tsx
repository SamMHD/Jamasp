import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SourceLang } from "@/components/source-lang";
import en from "@/messages/en.json";

const messages = en as Record<string, string>;

// This project has no @testing-library/react (see top-bar.test.tsx and
// lang-toggle.test.tsx), so — same as every other component test here —
// this renders with renderToStaticMarkup and asserts against the markup
// string rather than screen.getByText/queryByText.

describe("SourceLang", () => {
  it("marks fallback content", () => {
    const html = renderToStaticMarkup(
      <SourceLang fallback messages={messages}>Gold climbs</SourceLang>);
    expect(html).toContain("Gold climbs");
    expect(html).toContain(messages["content.sourceEnglish"]);
  });

  it("adds no marker when the content is translated", () => {
    const html = renderToStaticMarkup(
      <SourceLang fallback={false} messages={messages}>طلا بالا رفت</SourceLang>);
    expect(html).toContain("طلا بالا رفت");
    expect(html).not.toContain(messages["content.sourceEnglish"]);
  });

  it("marks the fallback text as English for screen readers and typography", () => {
    // Without lang="en" the Persian font applies to Latin text and a screen
    // reader announces English words with a Persian voice.
    const html = renderToStaticMarkup(
      <SourceLang fallback messages={messages}>Gold climbs</SourceLang>);
    expect(html).toContain('lang="en"');
  });
});
