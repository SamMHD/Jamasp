"use client";

import * as React from "react";
import { Toaster as Sonner, ToasterProps } from "sonner";

// Sonner's `theme` prop selects its own built-in colour preset — the
// `--normal-*` CSS variables below already track the app's tokens, but the
// preset itself was pinned to "dark", so a toast rendered dark on a light
// page. The DOM class on <html> ("light" or "dark") is the single source of
// truth for the resolved appearance (see lib/theme.ts and the pre-paint
// script in app/layout.tsx); reading it directly here, rather than
// re-deriving preference/system state, is enough — nothing else needs to
// know when a toast is showing.
function subscribeHtmlClass(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function getHtmlThemeSnapshot(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function getServerHtmlThemeSnapshot(): "light" | "dark" {
  return "light";
}

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = React.useSyncExternalStore(
    subscribeHtmlClass, getHtmlThemeSnapshot, getServerHtmlThemeSnapshot);
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
