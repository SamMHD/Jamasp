"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  economicCalendarConfig, heatmapConfig, newsConfig, screenerConfig,
  seasonalChartComponent, tvComponentScript, tvEmbedScript, TV_REFUSED_WIDGETS,
  TV_THEME_TOKENS, watchlistComponent, worldMarketSummaryComponent,
  type TvComponentSpec, type TvTheme,
} from "@/lib/tradingview";

/**
 * The reference desk's mounting shells — one per TradingView widget
 * generation — and the named widgets built on them.
 *
 * This is the panel's THIRD and FOURTH mounting shell, and the first general
 * ones. components/live-chart.tsx and components/tradingview-mini-chart.tsx
 * stay exactly as they are on purpose: each is welded to a specific fallback
 * contract — the Advanced Chart falls back to Jamasp's own stored series, the
 * Mini Chart falls back to a Jamasp-sourced driver tile — and generalising
 * them would mean generalising those contracts, which are the load-bearing
 * part of both.
 *
 * The reference desk has no such contract, and that is exactly what makes two
 * shells enough for all of it: there is no Jamasp reading underneath any of
 * these widgets, because none of them is telling you something Jamasp knows.
 * So the failure state is honest and uniform — say the widget could not be
 * loaded, and take up no more room than the note needs.
 *
 * Every symbol, colour and config decision lives in lib/tradingview.ts. These
 * shells only know how to put a widget in a box and how to tell whether
 * anything came back.
 */

/**
 * How long to wait before calling a widget unavailable.
 *
 * Longer than it looks like it should be. During probing, the economic
 * calendar rendered fully on one load and was still blank at 18s on the next,
 * with identical config — these embeds do a multi-request handshake and one
 * slow leg stalls the whole frame. Since the fallback here is a line of text
 * rather than a chart, waiting costs the reader almost nothing while giving
 * up early costs them the widget.
 */
const MOUNT_DEADLINE_MS = 30_000;

/**
 * How often to look for the injected iframe, and how long to let it paint
 * once it appears.
 *
 * The Advanced Chart announces itself with a postMessage and
 * components/live-chart.tsx waits for it. These widgets do NOT — verified by
 * mounting all six: the iframe lands, the widget paints, and no message ever
 * arrives. Waiting for one meant every classic embed sat under a "loading…"
 * overlay for the full 30s deadline while a perfectly good widget rendered
 * underneath it, which is a worse failure than not having the widget.
 *
 * So presence plus a short grace decides it here. The grace exists because
 * the iframe element appears a beat before anything is drawn inside it, and
 * swapping the overlay for an empty white rectangle is its own small lie.
 */
const IFRAME_POLL_MS = 250;
const IFRAME_GRACE_MS = 1_200;

/** Web components register asynchronously; a hung CDN must still resolve. */
const DEFINE_TIMEOUT_MS = 15_000;

/**
 * The classic embed's readiness signal — one `{name:"tv-widget-load"}`
 * message from a TradingView origin once the frame is up. The same set
 * components/live-chart.tsx listens on, and undocumented in the same way, so
 * nothing depends on it arriving: the deadline resolves the case where it
 * never does.
 */
const TV_ORIGINS = new Set([
  "https://www.tradingview-widget.com",
  "https://s.tradingview.com",
  "https://www.tradingview.com",
]);

/** The panel's current appearance, read off the class the pre-paint script sets. */
function currentTheme(): TvTheme {
  const root = document.documentElement;
  if (root.classList.contains("dark")) return "dark";
  if (root.classList.contains("light")) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

type Status = "pending" | "live" | "unavailable";

/**
 * Watch the panel's appearance, but only once the caller has started.
 *
 * Returns null until `armed` goes true, which is what keeps the viewport gate
 * meaningful: reading the theme early would be harmless, but SETTING it is
 * what triggers a mount, so nothing may look at it before the card is on
 * screen. After that the toggle writes classes onto <html> from outside
 * React's tree (components/theme-toggle.tsx), and a laptop can flip to dark
 * at sunset while the preference is "system" — both reach us only through
 * this.
 */
function usePanelTheme(armed: boolean): TvTheme | null {
  const [theme, setTheme] = useState<TvTheme | null>(null);
  useEffect(() => {
    if (!armed) return;
    const sync = () => setTheme(currentTheme());
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    mql.addEventListener("change", sync);
    return () => { mo.disconnect(); mql.removeEventListener("change", sync); };
  }, [armed]);
  return theme;
}

/**
 * Arm on first intersection, then stay armed.
 *
 * Six third-party widgets is the entire performance budget of this page.
 * Nothing about TradingView — script, chunks, sockets — is fetched until the
 * card is actually scrolled to, with the same 200px rootMargin the Drivers
 * card uses so the swap has usually happened by the time the card is read.
 */
function useInView(ref: React.RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen) return;
    const node = ref.current;
    if (node === null) return;
    if (typeof IntersectionObserver === "undefined") {
      // No viewport gate available — jsdom under vitest, and browsers old
      // enough that the widget would not run either. Arm on the next tick
      // rather than synchronously: an effect that calls setState in its own
      // body cascades a second render before paint, which is what
      // react-hooks/set-state-in-effect exists to catch.
      const id = setTimeout(() => setSeen(true), 0);
      return () => clearTimeout(id);
    }
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        io.disconnect();
        setSeen(true);
      }
    }, { rootMargin: "200px" });
    io.observe(node);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

/** The box every reference widget sits in, plus its pending/failed note. */
function WidgetFrame({ title, status, height, children, style }: {
  title: string;
  status: Status;
  height: number;
  children: React.ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      // A fixed height, always: both generations size themselves to a
      // laid-out box, and a box that grows when the widget lands would shift
      // every card below it. `overflow-hidden` is what keeps a wide widget
      // from pushing the 390px layout sideways — the mobile e2e sweep asserts
      // the document never scrolls horizontally.
      style={{ height, ...style }}
      className="relative w-full overflow-hidden rounded-md border border-border/60"
    >
      {children}
      {status !== "live" && (
        <div className="absolute inset-0 grid place-items-center bg-card p-4 text-center">
          <p className="text-meta text-ink-dim">
            {status === "unavailable" ? (
              <>
                {title} could not be loaded — TradingView is unreachable from
                this browser. Jamasp&rsquo;s own readings are unaffected.
              </>
            ) : (
              <>loading {title} from TradingView…</>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Shell 1 — classic `external-embedding` script + JSON config
 * ------------------------------------------------------------------ */

function TradingViewEmbed({ widget, config, title, height }: {
  /**
   * The SCRIPT name, not the product name — `events` for the economic
   * calendar, `timeline` for news. lib/tradingview.ts#tvEmbedScript explains
   * why the two differ.
   */
  widget: string;
  /**
   * Builder rather than a value: the payload has to be rebuilt whenever the
   * reader flips theme, because TradingView bakes `colorTheme` into the frame
   * at construction and an iframe cannot be re-themed in place.
   */
  config: (theme: TvTheme) => object;
  /** Names the widget in the pending and failure notes. */
  title: string;
  height: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const inView = useInView(host);
  const theme = usePanelTheme(inView);
  const [status, setStatus] = useState<Status>("pending");

  const refusal = TV_REFUSED_WIDGETS[widget];

  useEffect(() => {
    const el = host.current;
    if (el === null || theme === null || refusal !== undefined) return;

    el.replaceChildren();
    setStatus("pending");

    // TradingView's own container structure. The loader looks for the inner
    // `__widget` div and replaces it with the iframe; without it the script
    // injects into <body> and the widget escapes its card.
    const container = document.createElement("div");
    container.className = "tradingview-widget-container";
    container.style.height = "100%";
    container.style.width = "100%";
    const slot = document.createElement("div");
    slot.className = "tradingview-widget-container__widget";
    slot.style.height = "100%";
    slot.style.width = "100%";
    container.appendChild(slot);
    el.appendChild(container);

    let settled = false;
    let deadline = 0;
    let grace = 0;
    let poll = 0;
    const settle = (next: Status) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(deadline);
      window.clearTimeout(grace);
      window.clearInterval(poll);
      window.removeEventListener("message", onMessage);
      setStatus(next);
    };
    // Kept as the fast path even though none of these widgets has been seen
    // to send it: it costs one listener, and a widget that does announce
    // itself should not be made to wait out the grace below.
    function onMessage(event: MessageEvent) {
      if (TV_ORIGINS.has(event.origin)) settle("live");
    }
    window.addEventListener("message", onMessage);

    const script = document.createElement("script");
    script.src = tvEmbedScript(widget);
    script.async = true;
    script.type = "text/javascript";
    script.innerHTML = JSON.stringify(config(theme));
    script.onerror = () => settle("unavailable");

    poll = window.setInterval(() => {
      if (el.querySelector("iframe") === null) return;
      window.clearInterval(poll);
      grace = window.setTimeout(() => settle("live"), IFRAME_GRACE_MS);
    }, IFRAME_POLL_MS);

    deadline = window.setTimeout(() => {
      // Nothing ever appeared: the loader was blocked, or never ran.
      settle(el.querySelector("iframe") === null ? "unavailable" : "live");
    }, MOUNT_DEADLINE_MS);

    container.appendChild(script);

    return () => {
      settled = true;
      window.clearTimeout(deadline);
      window.clearTimeout(grace);
      window.clearInterval(poll);
      window.removeEventListener("message", onMessage);
      el.replaceChildren();
    };
  }, [widget, config, theme, refusal]);

  if (refusal !== undefined) {
    // Loud, but not fatal: breaking the whole page would be a worse outcome
    // than the thing this guard exists to prevent. The unit test in
    // test/tradingview.test.ts is the real enforcement — it walks this
    // module's call sites — and this is the runtime backstop.
    console.error(
      `TradingView widget "${widget}" is refused by this panel: ${refusal}. ` +
        `See lib/tradingview.ts#TV_REFUSED_WIDGETS.`,
    );
    return null;
  }

  return (
    <WidgetFrame title={title} status={status} height={height}>
      <div ref={host} className="h-full w-full" aria-hidden={status !== "live"} />
    </WidgetFrame>
  );
}

/* ------------------------------------------------------------------ *
 * Shell 2 — modern web component
 * ------------------------------------------------------------------ */

/**
 * One ES-module `<script>` per custom element, shared by every instance.
 *
 * Deliberately keyed by tag rather than being a single global promise like
 * components/tradingview-mini-chart.tsx's: the reference desk mounts three
 * DIFFERENT elements, so one promise for all of them would resolve the first
 * caller against the wrong element's registration. TradingView's own guidance
 * is that the widgets share their chunks across loaders anyway, so the cost
 * of three module requests is one module graph.
 */
const loaders = new Map<string, Promise<void>>();

function loadComponent(tag: string): Promise<void> {
  const existing = loaders.get(tag);
  if (existing) return existing;

  const p = new Promise<void>((resolve, reject) => {
    if (customElements.get(tag)) return resolve();
    const src = tvComponentScript(tag);
    if (!document.querySelector<HTMLScriptElement>(`script[src="${src}"]`)) {
      const script = document.createElement("script");
      script.type = "module";
      script.src = src;
      script.async = true;
      script.onerror = () => reject(new Error(`tradingview ${tag} script failed`));
      document.head.appendChild(script);
    }
    // Resolve on whenDefined rather than on the script's load event: the
    // module registers the element asynchronously, so "loaded" is too early.
    const timer = setTimeout(
      () => reject(new Error(`tradingview ${tag} timed out`)), DEFINE_TIMEOUT_MS);
    customElements.whenDefined(tag).then(() => {
      clearTimeout(timer);
      resolve();
    }, reject);
  });
  // A failed load must not be cached as a permanent verdict for a later
  // navigation, but it must not be retried by three sibling cards either.
  p.catch(() => loaders.delete(tag));
  loaders.set(tag, p);
  return p;
}

function TradingViewComponent({ spec, title, height }: {
  spec: TvComponentSpec;
  title: string;
  height: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const inView = useInView(host);
  const theme = usePanelTheme(inView);
  const [status, setStatus] = useState<Status>("pending");

  // `attrs` is rebuilt by the caller on every render, so the effect keys on
  // its serialisation rather than its identity — otherwise a parent re-render
  // would tear down and rebuild a working widget on every keystroke elsewhere
  // on the page.
  const attrKey = JSON.stringify(spec.attrs);

  useEffect(() => {
    const node = host.current;
    if (node === null || theme === null) return;
    let cancelled = false;

    loadComponent(spec.tag).then(() => {
      if (cancelled || !node.isConnected) return;
      const el = document.createElement(spec.tag);
      for (const [name, value] of Object.entries(spec.attrs)) {
        el.setAttribute(name, value === true ? "" : value);
      }
      // Mirrored explicitly rather than left to the page's `color-scheme`:
      // this panel signals appearance with a class on <html>, which the
      // widget cannot see. Same bridge components/tradingview-mini-chart.tsx
      // uses.
      el.setAttribute("theme", theme);
      el.style.display = "block";
      el.style.width = "100%";
      el.style.height = "100%";
      node.replaceChildren(el);
      setStatus("live");
    }).catch(() => {
      if (cancelled) return;
      setStatus("unavailable");
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.tag, attrKey, theme]);

  return (
    <WidgetFrame
      title={title}
      status={status}
      height={height}
      // The one theming lever this generation gives that the classic embeds
      // do not: CSS custom properties inherit through a shadow boundary even
      // a closed one, so the panel's palette actually reaches inside. Same
      // application components/driver-panel.tsx makes for the Mini Charts.
      style={TV_THEME_TOKENS as CSSProperties}
    >
      <div ref={host} className="h-full w-full" aria-hidden={status !== "live"} />
    </WidgetFrame>
  );
}

/* ------------------------------------------------------------------ *
 * The named widgets
 * ------------------------------------------------------------------ */

/**
 * One named component per widget, all here rather than inline in the page,
 * for a boring but hard reason: the config builders are functions, and a
 * server component cannot pass a function across the client boundary. Keeping
 * the builder and its shell on the same side of that line means
 * app/markets/page.tsx stays a plain server component that renders named
 * elements, with no "use client" of its own.
 */

export function WatchlistWidget() {
  return (
    <TradingViewComponent
      spec={watchlistComponent()}
      title="the drivers watchlist"
      height={560}
    />
  );
}

export function WorldMarketSummaryWidget() {
  return (
    <TradingViewComponent
      spec={worldMarketSummaryComponent()}
      title="the world market summary"
      height={440}
    />
  );
}

export function SeasonalChartWidget() {
  return (
    <TradingViewComponent
      spec={seasonalChartComponent()}
      title="the gold seasonality chart"
      height={420}
    />
  );
}

export function HeatmapWidget() {
  return (
    <TradingViewEmbed
      widget="stock-heatmap"
      config={heatmapConfig}
      title="the S&P 500 heatmap"
      height={480}
    />
  );
}

export function ScreenerWidget() {
  return (
    <TradingViewEmbed
      widget="screener"
      config={screenerConfig}
      title="the FX screener"
      height={480}
    />
  );
}

export function NewsWidget() {
  return (
    <TradingViewEmbed
      widget="timeline"
      config={newsConfig}
      title="TradingView's gold commentary"
      height={460}
    />
  );
}

/**
 * The economic calendar. Mounted on app/calendar/page.tsx, under Jamasp's own
 * event list — see lib/tradingview.ts#economicCalendarConfig for why it lives
 * there and not on the reference desk with the others.
 */
export function EconomicCalendarWidget() {
  return (
    <TradingViewEmbed
      widget="events"
      config={economicCalendarConfig}
      title="the TradingView economic calendar"
      height={460}
    />
  );
}
