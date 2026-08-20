"use client";

import { useEffect, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";

/**
 * Puts the market map on the whole screen.
 *
 * A client component, unlike the map it sits on — the Fullscreen API has to be
 * called from a user gesture, so there is no server-rendered equivalent. It is
 * kept as a leaf for that reason: the map, its data path and its layout stay
 * server-rendered, and only this control ships JavaScript. Same shape as
 * `auto-refresh.tsx`.
 *
 * It targets an element by id rather than taking a ref, so the map can remain
 * a server component — a server component cannot hold or pass a ref.
 *
 * The button always renders and guards the call instead of hiding itself when
 * the API is unavailable: detecting support means waiting for hydration, which
 * makes the control pop in after paint. A button that does nothing on a
 * browser this panel is never opened in is the cheaper failure.
 */
export function FullscreenButton({ targetId }: { targetId: string }) {
  const [isFull, setIsFull] = useState(false);

  useEffect(() => {
    const onChange = () => setIsFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggle = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
      return;
    }
    const el = document.getElementById(targetId);
    void el?.requestFullscreen?.();
  };

  const label = isFull ? "Exit full screen" : "Full screen";
  const Icon = isFull ? Minimize2 : Maximize2;

  return (
    <button type="button" onClick={toggle} aria-label={label} title={label}
      className="flex items-center gap-1 rounded border border-border px-2 py-1
                 text-xs text-muted-foreground hover:text-foreground
                 hover:bg-muted focus-visible:outline focus-visible:outline-2
                 focus-visible:outline-offset-2">
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </button>
  );
}
