"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { nextPref, readPref, resolveAppearance, writePref, type ThemePref } from "@/lib/theme";

const ICON = { system: Monitor, light: Sun, dark: Moon };
const LABEL: Record<ThemePref, string> = {
  system: "Appearance: following system",
  light: "Appearance: light",
  dark: "Appearance: dark",
};

// The stored preference is state React doesn't own — it lives in
// localStorage and is written by the click handler below. useSyncExternalStore
// is the primitive for exactly this: it supplies a server snapshot ("system",
// matching the pre-paint script's fallback) for the render that must match
// SSR output, then swaps to the real stored value right after mount, with no
// setState call in an effect body. The listener set lets every mounted
// ThemeToggle (desktop sidebar, mobile top bar) react to a click on either.
const prefListeners = new Set<() => void>();

function subscribePref(onChange: () => void) {
  prefListeners.add(onChange);
  return () => prefListeners.delete(onChange);
}

function getPrefSnapshot(): ThemePref {
  return readPref(window.localStorage);
}

function getServerPrefSnapshot(): ThemePref {
  return "system";
}

function choosePref(next: ThemePref) {
  writePref(window.localStorage, next);
  prefListeners.forEach(listener => listener());
}

// The OS-level scheme, subscribed once and independent of `pref` — unlike
// the old effect, cycling the preference never tears down and re-subscribes
// this listener.
function subscribeSystemScheme(onChange: () => void) {
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSystemSchemeSnapshot(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getServerSystemSchemeSnapshot(): boolean {
  return false;
}

// Standard useSyncExternalStore "isClient" idiom: the value never changes
// after the first client render, so subscribing is a no-op — it exists only
// to give a different answer server-side (false) vs client-side (true).
function subscribeMounted() {
  return () => {};
}

/**
 * Three-state appearance control. The DOM class is the single source of
 * truth for what is rendered; this component only decides what to put there.
 *
 * Mounted-gated because the server cannot know the reader's stored
 * preference — rendering the wrong icon and correcting it after hydration is
 * a visible flicker, so the icon slot holds its size and stays blank until
 * the preference is known.
 */
export function ThemeToggle() {
  const pref = useSyncExternalStore(subscribePref, getPrefSnapshot, getServerPrefSnapshot);
  const systemPrefersDark = useSyncExternalStore(
    subscribeSystemScheme, getSystemSchemeSnapshot, getServerSystemSchemeSnapshot);
  const mounted = useSyncExternalStore(subscribeMounted, () => true, () => false);

  const appearance = resolveAppearance(pref, systemPrefersDark);

  // Applies the resolved appearance to <html>, which is outside this
  // component's own render output. Guarded on `mounted` so the very first
  // client render — which, like the server render, resolves from the
  // placeholder "system"/false snapshots — never clobbers the class the
  // pre-paint script already set from the reader's real preference. Once
  // mounted, this re-runs whenever the reader's choice or the system's
  // scheme changes — including a laptop switching to dark at sunset while
  // the preference is "system".
  useEffect(() => {
    if (!mounted) return;
    const root = document.documentElement;
    root.classList.toggle("dark", appearance === "dark");
    root.classList.toggle("light", appearance === "light");
  }, [appearance, mounted]);

  const Icon = ICON[pref];
  return (
    <button
      type="button"
      onClick={() => choosePref(nextPref(pref))}
      aria-label={LABEL[pref]}
      title={LABEL[pref]}
      className="inline-flex h-11 w-11 items-center justify-center rounded-md
                 text-muted-foreground hover:bg-secondary hover:text-foreground
                 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {mounted ? <Icon className="h-4 w-4" aria-hidden="true" /> : <span className="h-4 w-4" />}
    </button>
  );
}
