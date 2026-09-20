import en from "@/messages/en.json";
import fa from "@/messages/fa.json";

export type Locale = "en" | "fa";
export type Messages = Record<string, string>;

export const LOCALES: readonly Locale[] = ["en", "fa"] as const;

/**
 * The locale a visitor with no cookie gets.
 *
 * PR 3 flips this to "fa" and that is the whole of PR 3. Nothing else in the
 * panel may hard-code a default, or the flip would be partial and the
 * difference would show up as one page in the wrong language.
 */
export const DEFAULT_LOCALE: Locale = "en";

export const LANG_COOKIE = "lang";

const DICTIONARIES: Record<Locale, Messages> = { en, fa };

/** A cookie value is untrusted input; anything unrecognised is the default. */
export function resolveLocale(cookieValue: string | undefined): Locale {
  return LOCALES.includes(cookieValue as Locale)
    ? (cookieValue as Locale)
    : DEFAULT_LOCALE;
}

export function getMessages(locale: Locale): Messages {
  return DICTIONARIES[locale];
}

/**
 * Persian, then English, then the key itself.
 *
 * The last step is deliberate: a missing label must never render as blank
 * space on a dense dashboard, and a visible `nav.overview` gets reported and
 * fixed where a gap would not. The key-parity test is what stops it
 * happening in the first place.
 */
export function t(messages: Messages, key: string): string {
  const value = messages[key];
  if (value && value.trim()) return value;
  const fallback = (en as Messages)[key];
  return fallback && fallback.trim() ? fallback : key;
}
