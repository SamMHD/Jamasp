"use client";

import { useEffect, useRef, useState } from "react";
import {
  TV_MINI_CHART_SCRIPT,
  TV_MINI_CHART_TAG,
  type TvEmbed,
} from "@/lib/tradingview";

/**
 * One TradingView Mini Chart web component, mounted lazily.
 *
 * Self-contained on purpose: everything this needs — the loader singleton,
 * the viewport gate, the theme bridge — lives in this file, so it can be
 * merged with any other TradingView embed helper in the panel without
 * untangling shared state.
 *
 * This component renders NOTHING on the server and nothing until it has a
 * live widget. The caller supplies its own fallback and keeps it visible
 * until `onReady` fires, so a blocked, offline or failed embed leaves the
 * page exactly as it was rather than punching a hole in it.
 */

/**
 * Module-level singleton: one <script> for every instance on the page.
 * TradingView's guidance is that repeated identical script tags are
 * deduplicated by the browser, but a single promise also gives every tile one
 * shared success/failure answer instead of racing six of them.
 */
let loader: Promise<void> | null = null;

/**
 * How long to wait for the custom element to be defined before giving up.
 * A hung CDN must not leave the tile in a permanent skeleton — failing over
 * to the Jamasp reading is the better answer, and it is already on screen.
 */
const DEFINE_TIMEOUT_MS = 10_000;

function loadMiniChart(): Promise<void> {
  if (loader) return loader;
  loader = new Promise<void>((resolve, reject) => {
    if (customElements.get(TV_MINI_CHART_TAG)) return resolve();

    // `import()` would be rewritten by the bundler into a chunk request; a
    // script tag keeps the URL literal and is the embedding TradingView
    // documents. type="module" is required — the widget ships as an ES module.
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${TV_MINI_CHART_SCRIPT}"]`);
    if (!existing) {
      const script = document.createElement("script");
      script.type = "module";
      script.src = TV_MINI_CHART_SCRIPT;
      script.async = true;
      script.onerror = () => reject(new Error("tradingview script failed"));
      document.head.appendChild(script);
    }

    // Resolving on whenDefined rather than on the script's load event: the
    // module registers the element asynchronously, so "loaded" is too early.
    const timer = setTimeout(
      () => reject(new Error("tradingview widget timed out")), DEFINE_TIMEOUT_MS);
    customElements.whenDefined(TV_MINI_CHART_TAG).then(() => {
      clearTimeout(timer);
      resolve();
    }, reject);
  });
  // A failed load must not be cached as a permanent verdict for a later
  // navigation, but it must not be retried by five sibling tiles either.
  loader.catch(() => { loader = null; });
  return loader;
}

/** The panel's current appearance, read off the class the pre-paint script sets. */
function currentAppearance(): "dark" | "light" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function TradingViewMiniChart({ embed, onReady, className }: {
  embed: TvEmbed;
  /** Fires once the widget element is in the DOM, so the caller can retire its fallback. */
  onReady?: (ready: boolean) => void;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const [ready, setReady] = useState(false);

  // Viewport gate, then load. The Drivers card sits well below the fold on
  // the overview, so nothing about TradingView — script, chunks, sockets — is
  // fetched until the reader actually scrolls to it; rootMargin starts the
  // load just before the card arrives so the swap has usually happened by the
  // time it is read.
  //
  // `onReady` is a dependency and safe as one: callers pass a useState setter,
  // which React keeps stable across renders, and the `started` guard makes a
  // re-run idempotent regardless.
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let cancelled = false;

    const start = () => {
      if (started.current) return;
      started.current = true;
      loadMiniChart().then(() => {
        if (cancelled || !node.isConnected) return;
        const el = document.createElement(TV_MINI_CHART_TAG);
        el.setAttribute("symbol", embed.symbol);
        el.setAttribute("time-frame", embed.timeFrame);
        el.setAttribute("theme", currentAppearance());
        // Lets the tile's own background show through, so the widget cells
        // and the Jamasp-sourced cell share one surface.
        el.setAttribute("transparent", "");
        el.style.display = "block";
        el.style.height = "100%";
        node.replaceChildren(el);
        setReady(true);
        onReady?.(true);
      }).catch(() => {
        if (cancelled) return;
        // Leave the host empty: the caller's fallback is still on screen and
        // stays there. A failed embed costs the reader nothing.
        started.current = false;
        onReady?.(false);
      });
    };

    if (typeof IntersectionObserver === "undefined") {
      start();
      return () => { cancelled = true; };
    }
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        io.disconnect();
        start();
      }
    }, { rootMargin: "200px" });
    io.observe(node);
    return () => { cancelled = true; io.disconnect(); };
  }, [embed.symbol, embed.timeFrame, onReady]);

  // Theme bridge. The widget follows the page's `color-scheme` by default,
  // but this panel signals appearance with a class on <html>, so the theme
  // attribute is mirrored across explicitly and kept in sync when the reader
  // uses the appearance toggle.
  useEffect(() => {
    if (!ready) return;
    const sync = () => {
      const el = host.current?.firstElementChild;
      el?.setAttribute("theme", currentAppearance());
    };
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    mql.addEventListener("change", sync);
    return () => { mo.disconnect(); mql.removeEventListener("change", sync); };
  }, [ready]);

  // The host keeps its full size from the first render even though it is
  // empty: the caller overlays it on the fallback rather than stacking it, so
  // an empty host costs no layout, and giving the widget its real dimensions
  // up front means its internal ResizeObserver measures the box once instead
  // of laying out at 0px and reflowing.
  return <div ref={host} aria-hidden={!ready} className={className} />;
}
