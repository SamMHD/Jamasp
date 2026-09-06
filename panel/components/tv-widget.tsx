"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The browser half of every TradingView web-component embed: load the
 * module, mount the element, keep it on the panel's appearance, and never
 * let any of that block or disturb the page around it.
 *
 * lib/tradingview.ts holds the decisions — which symbols, which colours,
 * which attributes — and is pure so it can be tested without a DOM. This
 * file holds the DOM, and is the ONLY place the panel touches `customElements`
 * or injects a script tag. Both consumers (the Drivers card's Mini Charts and
 * the overview's Ticker Tape) go through it, because the interesting parts —
 * one loader per script for the whole page, a timeout so a hung CDN cannot
 * strand a skeleton, a theme bridge onto the `class` the pre-paint script
 * sets — are exactly the parts that rot when they exist twice.
 *
 * NOTHING here renders on the server, and nothing renders until there is a
 * live widget. Every caller supplies its own already-visible fallback and
 * keeps it until `onReady` fires, so a blocked, offline or failed embed
 * leaves the page exactly as it was rather than punching a hole in it.
 */

/**
 * One `<script>` per module URL for the whole page, keyed by src.
 * TradingView's guidance is that repeated identical script tags are
 * deduplicated by the browser, but a single promise also gives every
 * consumer of that module one shared success/failure answer instead of
 * racing six of them.
 */
const loaders = new Map<string, Promise<void>>();

/**
 * How long to wait for a custom element to be defined before giving up.
 * A hung CDN must not leave a caller in a permanent skeleton — failing over
 * to the Jamasp-sourced fallback is the better answer, and it is already on
 * screen.
 */
const DEFINE_TIMEOUT_MS = 10_000;

export function loadTvModule(src: string, tag: string): Promise<void> {
  const cached = loaders.get(src);
  if (cached) return cached;
  const loading = new Promise<void>((resolve, reject) => {
    if (customElements.get(tag)) return resolve();

    // `import()` would be rewritten by the bundler into a chunk request; a
    // script tag keeps the URL literal and is the embedding TradingView
    // documents. type="module" is required — the widgets ship as ES modules.
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (!existing) {
      const script = document.createElement("script");
      script.type = "module";
      script.src = src;
      script.async = true;
      script.onerror = () => reject(new Error(`tradingview script failed: ${src}`));
      document.head.appendChild(script);
    }

    // Resolving on whenDefined rather than on the script's load event: the
    // module registers the element asynchronously, so "loaded" is too early.
    const timer = setTimeout(
      () => reject(new Error(`tradingview widget timed out: ${tag}`)), DEFINE_TIMEOUT_MS);
    customElements.whenDefined(tag).then(() => {
      clearTimeout(timer);
      resolve();
    }, reject);
  });
  // A failed load must not be cached as a permanent verdict for a later
  // navigation, but it must not be retried by five sibling tiles either.
  loading.catch(() => { loaders.delete(src); });
  loaders.set(src, loading);
  return loading;
}

/** The panel's current appearance, read off the class the pre-paint script sets. */
export function currentAppearance(): "dark" | "light" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * When to start paying for the embed.
 *
 * - "viewport": nothing about TradingView — script, chunks, sockets — is
 *   fetched until the reader actually scrolls near the host. Right for
 *   anything below the fold, which on this page is everything but the tape.
 * - "idle": the host is on screen from the first paint, so a viewport gate
 *   would fire immediately and buy nothing. Wait for the main thread to go
 *   quiet instead, so the widget's fetch and module evaluation queue behind
 *   the page's own hydration rather than competing with it. The timeout is
 *   the ceiling: on a busy thread the tape still arrives, just last.
 */
export type TvGate = "viewport" | "idle";

const IDLE_TIMEOUT_MS = 3_000;

/** requestIdleCallback where it exists, a macrotask where it does not (Safari). */
function whenIdle(run: () => void): () => void {
  const ric = (window as typeof window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  }).requestIdleCallback;
  if (typeof ric === "function") {
    const handle = ric(run, { timeout: IDLE_TIMEOUT_MS });
    return () => window.cancelIdleCallback?.(handle);
  }
  const t = window.setTimeout(run, 200);
  return () => window.clearTimeout(t);
}

export function TvWidget({ tag, script, attributes, gate = "viewport", onReady, className }: {
  tag: string;
  script: string;
  /** Static attributes; `theme` is set here and must not appear among them. */
  attributes: Readonly<Record<string, string>>;
  gate?: TvGate;
  /** Fires once the widget element is in the DOM, so the caller can retire its fallback. */
  onReady?: (ready: boolean) => void;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const [ready, setReady] = useState(false);

  // The attribute map is rebuilt on every render by its (pure) factory, so
  // it is a new object identity each time and useless as a dependency.
  // Its CONTENT is what the effect actually depends on.
  const attrKey = JSON.stringify(attributes);

  // `onReady` is a dependency and safe as one: callers pass a useState
  // setter, which React keeps stable across renders, and the `started` guard
  // makes a re-run idempotent regardless.
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let cancelled = false;

    const start = () => {
      if (started.current) return;
      started.current = true;
      loadTvModule(script, tag).then(() => {
        if (cancelled || !node.isConnected) return;
        const el = document.createElement(tag);
        for (const [name, value] of Object.entries(JSON.parse(attrKey) as Record<string, string>)) {
          el.setAttribute(name, value);
        }
        el.setAttribute("theme", currentAppearance());
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

    if (gate === "idle") {
      const cancelIdle = whenIdle(start);
      return () => { cancelled = true; cancelIdle(); };
    }
    if (typeof IntersectionObserver === "undefined") {
      start();
      return () => { cancelled = true; };
    }
    // rootMargin starts the load just before the host arrives, so the swap
    // has usually happened by the time it is read.
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        io.disconnect();
        start();
      }
    }, { rootMargin: "200px" });
    io.observe(node);
    return () => { cancelled = true; io.disconnect(); };
  }, [tag, script, attrKey, gate, onReady]);

  // Theme bridge. The widgets follow the page's `color-scheme` by default,
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
  // empty: callers overlay it on their fallback rather than stacking it, so
  // an empty host costs no layout, and giving the widget its real dimensions
  // up front means its internal ResizeObserver measures the box once instead
  // of laying out at 0px and reflowing.
  return <div ref={host} aria-hidden={!ready} className={className} />;
}
