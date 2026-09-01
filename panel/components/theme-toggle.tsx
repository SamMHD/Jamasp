"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { nextPref, readPref, resolveAppearance, writePref, type ThemePref } from "@/lib/theme";

const ICON = { system: Monitor, light: Sun, dark: Moon };
const LABEL: Record<ThemePref, string> = {
  system: "Appearance: following system",
  light: "Appearance: light",
  dark: "Appearance: dark",
};

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
  const [pref, setPref] = useState<ThemePref>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setPref(readPref(window.localStorage));
    setMounted(true);
  }, []);

  // Re-apply when the system flips while the preference is "system". Without
  // this, a reader whose laptop switches to dark at sunset keeps the light
  // appearance until they reload.
  useEffect(() => {
    if (!mounted) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const appearance = resolveAppearance(pref, mq.matches);
      const root = document.documentElement;
      root.classList.toggle("dark", appearance === "dark");
      root.classList.toggle("light", appearance === "light");
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [pref, mounted]);

  const Icon = ICON[pref];
  return (
    <button
      type="button"
      onClick={() => {
        const next = nextPref(pref);
        setPref(next);
        writePref(window.localStorage, next);
      }}
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
