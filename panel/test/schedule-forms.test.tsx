import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AddWakeupDialog, CancelButton, RunNowButtons, RunTypeOptions,
} from "@/components/schedule-forms";
import { getMessages } from "@/lib/i18n";
import { RUN_TYPES } from "@/lib/validate";
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
  // text and failed with the trigger's markup alone in the diff).
  //
  // The <option> list inside that dialog is therefore covered by rendering
  // the exported RunTypeOptions directly — the same escape hatch
  // components/inbox-table.tsx's ItemHeadline uses, and for the same reason.
  // An earlier version of this comment claimed e2e/i18n.spec.ts exercised
  // the open dialog: it does not, and never did. No e2e spec in this repo
  // opens it, so that path had no coverage at all.
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

describe("RunTypeOptions (the wakeup dialog's <select>)", () => {
  it("renders the translated label as the option's text", () => {
    const html = renderToStaticMarkup(<RunTypeOptions messages={messages.fa} />);
    for (const rt of ["brief", "scan", "deepdive", "retro"] as const) {
      expect(html).toContain(`>${fa[`runType.${rt}` as keyof typeof fa]}</option>`);
    }
  });

  /**
   * The load-bearing half. A <select> with no explicit `value` submits its
   * option's TEXT CONTENT — so once the text became Persian, a missing
   * `value` would schedule a wakeup with a Persian string where addWakeup
   * expects the Latin run_type slug, and the failure would surface in the
   * CLI, not here.
   */
  it("keeps the Latin run_type slug as the option's value", () => {
    const html = renderToStaticMarkup(<RunTypeOptions messages={messages.fa} />);
    for (const rt of ["brief", "scan", "deepdive", "retro"] as const) {
      expect(html).toContain(`value="${rt}"`);
    }
    // Persian text AND the Latin value on the same element, not one or the
    // other: this is the exact shape the dialog needs.
    expect(html).toContain(`value="deepdive">${fa["runType.deepdive"]}</option>`);
  });

  it("renders every run type the CLI accepts, not a hand-picked subset", () => {
    // Unlike RunNowButtons, which filters "retro" out, the dialog offers all
    // of RUN_TYPES — a missing one is a wakeup the desk cannot schedule.
    const html = renderToStaticMarkup(<RunTypeOptions messages={messages.fa} />);
    expect((html.match(/<option/g) ?? []).length).toBe(RUN_TYPES.length);
  });

  it("keeps the English labels in the English locale", () => {
    const html = renderToStaticMarkup(<RunTypeOptions messages={messages.en} />);
    expect(html).toContain(`>${en["runType.deepdive"]}</option>`);
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
