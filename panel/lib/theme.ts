/**
 * Theme preference resolution. Pure — no DOM, no window — so it is testable
 * and so the pre-paint script in app/layout.tsx can mirror it in three lines
 * without importing anything.
 */
export type ThemePref = "system" | "light" | "dark";
export type Appearance = "light" | "dark";

export const THEME_STORAGE_KEY = "jamasp.theme";

const PREFS: ThemePref[] = ["system", "light", "dark"];

export function resolveAppearance(pref: ThemePref, systemPrefersDark: boolean): Appearance {
  if (pref === "system") return systemPrefersDark ? "dark" : "light";
  return pref;
}

/** System -> Light -> Dark -> System. System leads because it is the default
 *  and the appearance the HIG expects an app to respect. */
export function nextPref(current: ThemePref): ThemePref {
  return PREFS[(PREFS.indexOf(current) + 1) % PREFS.length];
}

export function readPref(store: Pick<Storage, "getItem"> | null): ThemePref {
  try {
    const raw = store?.getItem(THEME_STORAGE_KEY);
    return PREFS.includes(raw as ThemePref) ? (raw as ThemePref) : "system";
  } catch {
    // Private browsing: the accessor throws rather than returning null.
    return "system";
  }
}

export function writePref(store: Pick<Storage, "setItem"> | null, pref: ThemePref): void {
  try {
    store?.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // A preference we cannot persist is not worth taking the page down for.
  }
}
