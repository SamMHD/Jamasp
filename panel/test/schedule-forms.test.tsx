import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AddWakeupDialog, CancelButton, RunNowButtons } from "@/components/schedule-forms";
import { getMessages } from "@/lib/i18n";
import en from "@/messages/en.json";
import fa from "@/messages/fa.json";

// useAct() calls useRouter() unconditionally (see components/calendar-i18n.test.tsx
// / test/calendar-i18n.test.tsx's identical mock) — this project has no
// @testing-library/react, so every assertion here is against the
// renderToStaticMarkup string, the house convention (see test/lang-toggle.test.tsx).
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const messages = { en: getMessages("en"), fa: getMessages("fa") };

// Task 11's explicit carry-forward: this file renders raw run-type slugs
// through interpolation ({t}, <option key={t}>{t}</option>) rather than the
// runType.* dictionary — a shape the brief's own literal-JSX-text grep
// cannot see. Asserted against the real dictionaries, never a hand-typed
// guess, so a wording edit there cannot silently desync these tests.
describe("RunNowButtons — Persian", () => {
  it("renders each run-type button through the dictionary, not the raw slug", () => {
    const html = renderToStaticMarkup(<RunNowButtons capped={false} messages={messages.fa} />);
    for (const rt of ["brief", "scan", "deepdive"] as const) {
      expect(html).toContain(fa[`runType.${rt}` as keyof typeof fa]);
    }
    // "retro" is deliberately excluded from this control (RUN_TYPES.filter),
    // so its absence here is not itself informative — the real guard is that
    // no OTHER raw English slug leaked through instead of its label.
    expect(html).not.toContain(">brief<");
    expect(html).not.toContain(">deepdive<");
  });

  it("keeps the English labels in the English locale", () => {
    const html = renderToStaticMarkup(<RunNowButtons capped={false} messages={messages.en} />);
    expect(html).toContain("Run Brief now");
    expect(html).toContain("Run Deepdive now");
  });
});

describe("AddWakeupDialog — Persian", () => {
  // Radix's Dialog only mounts DialogContent's Portal once `open` is true,
  // and `open` here is internal component state (useState(false)) with no
  // prop to force it — unlike components/shell/more-sheet.tsx, which takes
  // `open` from its caller and IS tested that way. renderToStaticMarkup on
  // the closed dialog therefore renders only the trigger button; verified
  // empirically (the initial version of this test asserted on dialog-content
  // text and failed with the trigger's markup alone in the diff). The
  // translated <option value={rt}>{label}</option> shape (Persian text, the
  // Latin run_type slug still as `value`) is exercised for real by
  // e2e/i18n.spec.ts instead, which can actually click the trigger open.
  it("translates the trigger button", () => {
    const html = renderToStaticMarkup(<AddWakeupDialog messages={messages.fa} />);
    expect(html).toContain(fa["schedule.scheduleWakeupBtn"]);
    expect(html).not.toContain(">Schedule wakeup<");
  });

  it("keeps the English trigger text in the English locale", () => {
    const html = renderToStaticMarkup(<AddWakeupDialog messages={messages.en} />);
    expect(html).toContain("Schedule wakeup");
  });
});

describe("CancelButton — Persian", () => {
  it("translates the cancel label", () => {
    const html = renderToStaticMarkup(<CancelButton id={7} messages={messages.fa} />);
    expect(html).toContain(fa["common.cancel"]);
    expect(html).not.toContain(">cancel<");
  });
});

// Dictionary-parity guard for this file specifically: every runType.* value
// used above must be non-empty in both locales, or the interpolation this
// test exists to catch could silently render blank instead of failing loud.
describe("schedule-forms — dictionary sanity", () => {
  it("has a non-empty Persian runType.* label for every run type this file renders", () => {
    for (const rt of ["brief", "scan", "deepdive", "retro"]) {
      expect(fa[`runType.${rt}` as keyof typeof fa]?.trim()).toBeTruthy();
      expect(en[`runType.${rt}` as keyof typeof en]?.trim()).toBeTruthy();
    }
  });
});
