"use client";

import { Languages } from "lucide-react";
import { setLocale } from "@/lib/actions";
import { t, type Locale, type Messages } from "@/lib/i18n";

/**
 * Switches the panel's language.
 *
 * Unlike ThemeToggle this is a server action rather than localStorage: the
 * locale decides server-rendered output — every headline and label — so the
 * server has to know it before the first byte. A client-only store would
 * paint English and then swap.
 *
 * Two states, not a cycle: with one alternative a toggle is clearer than a
 * menu, and the button always names the language it will switch TO.
 */
export function LangToggle({ locale, messages }: { locale: Locale; messages: Messages }) {
  const next: Locale = locale === "fa" ? "en" : "fa";
  const glyph = t(messages, next === "fa" ? "lang.fa" : "lang.en");
  const actionLabel = t(messages, next === "fa" ? "lang.switchToFa" : "lang.switchToEn");
  // WCAG 2.5.3 Label in Name: the visible text on the button is the glyph
  // ("EN"/"فا"), not the action phrase. A voice-control user speaks what
  // they SEE, so the accessible name has to contain that glyph verbatim or
  // "click فا" has nothing to match. Leading with the glyph satisfies that;
  // the action phrase that follows is what a screen-reader user needs to
  // hear, since two letters alone don't say what the button does.
  const label = `${glyph} — ${actionLabel}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => setLocale(next)}
      className="inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-md
                 px-2 text-body text-muted-foreground hover:bg-secondary hover:text-foreground
                 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <Languages aria-hidden className="h-4 w-4" />
      <span>{glyph}</span>
    </button>
  );
}
