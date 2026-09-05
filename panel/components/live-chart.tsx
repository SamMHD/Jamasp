"use client";

import { useEffect, useRef, useState } from "react";
import {
  advancedChartConfig, TV_LIVE_LABEL, TV_SCRIPT_SRC, type ChartAppearance,
} from "@/lib/tradingview";

/**
 * The live half of the technical panel: TradingView's Advanced Chart for the
 * same COMEX contract Jamasp prices off.
 *
 * Everything else on this panel is a *stored* reading, timestamped when the
 * market printed it. This box is the only thing here that is current, and it
 * exists to be checked against the reading beside it.
 *
 * ---- degradation ----
 *
 * `children` is the fallback, and it is what the SERVER renders: the panel's
 * own inline-SVG chart of Jamasp's stored series. It stays on screen until
 * this component has positively confirmed a widget iframe exists, so every
 * failure path lands on a real chart rather than a blank hole:
 *
 *   - no JavaScript / hydration never completes (this deployment has done
 *     exactly that — see components/spot-chart.tsx) -> the SSR fallback is
 *     simply never replaced;
 *   - script blocked or tradingview.com unreachable -> `onerror`, or the
 *     deadline below when the load fails with no event at all;
 *   - script loads but injects nothing -> the same deadline.
 *
 * The one case it cannot catch is an iframe that mounts and then fails to
 * reach TradingView from inside: that is cross-origin, so the page cannot
 * read it. The widget's own frame shows the error there.
 */

/**
 * How long to keep Jamasp's own chart up before giving the widget a verdict.
 *
 * Generous on purpose: the fallback is a real chart, so waiting costs the
 * reader nothing, while flipping early costs them a blank box. Measured
 * against the live embed, the readiness message lands ~11s after mount on a
 * desktop viewport and appreciably later on a phone.
 */
const MOUNT_DEADLINE_MS = 25_000;

/**
 * The embed's readiness signal — it posts exactly one message,
 * `{name:"tv-widget-load"}`, from this origin once the chart is up.
 * Verified against the live widget, but undocumented, so nothing depends on
 * it arriving: the deadline above resolves the case where it never does.
 */
const TV_ORIGINS = new Set([
  "https://www.tradingview-widget.com",
  "https://s.tradingview.com",
  "https://www.tradingview.com",
]);

type Status = "pending" | "live" | "unavailable";

/**
 * Resolves the appearance the panel is currently painted in. Mirrors the
 * pre-paint script in app/layout.tsx and lib/theme.ts#resolveAppearance: the
 * <html> class is the single source of truth, with the media query standing
 * in before any explicit choice has been made.
 */
function readAppearance(): ChartAppearance {
  const root = document.documentElement;
  const dark = root.classList.contains("dark")
    || (!root.classList.contains("light")
        && window.matchMedia("(prefers-color-scheme: dark)").matches);
  // Read the resolved tokens rather than restating hexes here, so the
  // widget's canvas is literally the panel's own --background/--border and
  // cannot drift when the palette is retuned.
  const style = getComputedStyle(root);
  const token = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    theme: dark ? "dark" : "light",
    backgroundColor: token("--background", dark ? "#0a0b0a" : "#f6f6f3"),
    gridColor: token("--border", dark ? "#333330" : "#dedad2"),
  };
}

export function LiveChart({ symbol, label = TV_LIVE_LABEL, children }: {
  symbol: string;
  /**
   * How to name the instrument in prose. The caption prints this AND the raw
   * ticker: the widget shows spot while Jamasp reads the front-month future
   * (see lib/tradingview.ts), and a caption that named only one of them
   * would let a reader take the two figures for the same instrument.
   */
  label?: string;
  children?: React.ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("pending");
  // null until mounted: the server cannot know the reader's theme, and
  // guessing one would build the widget twice on every load.
  const [look, setLook] = useState<ChartAppearance | null>(null);

  useEffect(() => {
    const apply = () => setLook(readAppearance());
    apply();
    // The theme toggle writes classes onto <html> from outside React's tree
    // (components/theme-toggle.tsx), and a laptop can flip to dark at sunset
    // while the preference is "system" — both reach us only through this.
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement,
      { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = host.current;
    if (el === null || look === null) return;

    // A theme flip has to rebuild the widget — TradingView bakes the palette
    // into the iframe at construction — so the container is cleared first
    // and the fallback comes back until the new frame is up.
    el.replaceChildren();
    setStatus("pending");

    const mount = document.createElement("div");
    mount.style.height = "100%";
    mount.style.width = "100%";
    el.appendChild(mount);

    let settled = false;
    let deadline = 0;
    const settle = (next: Status) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(deadline);
      window.removeEventListener("message", onMessage);
      setStatus(next);
    };

    // Readiness, not mere presence. The iframe element appears within a
    // second or two of the loader running, long before the chart paints — so
    // flipping on `querySelector("iframe")` would swap a real fallback chart
    // for an empty grey rectangle for several seconds. The widget's own
    // load message is the first moment there is anything to look at.
    function onMessage(event: MessageEvent) {
      if (TV_ORIGINS.has(event.origin)) settle("live");
    }
    window.addEventListener("message", onMessage);

    const script = document.createElement("script");
    script.src = TV_SCRIPT_SRC;
    script.async = true;
    script.type = "text/javascript";
    script.innerHTML = JSON.stringify(advancedChartConfig(symbol, look));
    script.onerror = () => settle("unavailable");

    deadline = window.setTimeout(() => {
      // The message never came. An iframe that exists is still far more
      // likely to be a slow chart than a broken one, and hiding a working
      // widget behind a stale chart forever would be the worse error — so
      // presence decides it here. Nothing at all means the loader never ran.
      settle(el.querySelector("iframe") === null ? "unavailable" : "live");
    }, MOUNT_DEADLINE_MS);

    mount.appendChild(script);

    return () => {
      settled = true;
      window.clearTimeout(deadline);
      window.removeEventListener("message", onMessage);
      el.replaceChildren();
    };
  }, [symbol, look]);

  const live = status === "live";
  return (
    <div>
      <div className="relative h-[300px] w-full overflow-hidden rounded-md border border-border/60 md:h-[380px]">
        {/* Always mounted, always sized: TradingView needs a laid-out box to
            autosize into, so it cannot be conditionally rendered. */}
        <div ref={host} className="h-full w-full" aria-hidden={!live} />
        {!live && (
          <div className="absolute inset-0 overflow-auto bg-background p-2">
            {children ?? (
              <p className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
                no stored price history to fall back on
              </p>
            )}
          </div>
        )}
      </div>
      <p className="mt-1 text-meta text-ink-dim">
        {status === "unavailable" ? (
          <span className="text-amber-600 dark:text-amber-400">
            live chart unavailable — TradingView could not be loaded; showing
            Jamasp&rsquo;s stored series instead
          </span>
        ) : live ? (
          <>live · {label} · {symbol} · TradingView · hourly, UTC</>
        ) : (
          <>loading live {label} from TradingView — Jamasp&rsquo;s stored series meanwhile</>
        )}
      </p>
    </div>
  );
}
