import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appDir = path.join(import.meta.dirname, "..", "app");

/**
 * Every route segment that renders a page must ship a `loading.tsx`.
 *
 * This is a structural invariant, not a style preference. Every page in this
 * panel is `dynamic = "force-dynamic"`, and the App Router will not prefetch
 * a dynamic route at all unless the segment has a loading boundary — so
 * without one, a click on a nav link produces *nothing on screen* until the
 * server round trip and the whole RSC payload have completed. On the desk's
 * connection that was tens of seconds of a UI that looked like it had
 * ignored the click; on Overview, whose payload is ~380KB, it was the bug
 * that prompted this work. Adding a route without a fallback silently
 * reintroduces it, and no other test in this suite is positioned to notice.
 *
 * See node_modules/next/dist/docs/01-app/01-getting-started/
 * 04-linking-and-navigating.md — "Dynamic routes without loading.tsx".
 */
function pageSegments(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (!statSync(p).isDirectory()) continue;
    // Route handlers under app/api are not pages and have no loading UI.
    if (entry === "api") continue;
    pageSegments(p, out);
  }
  if (readdirSync(dir).some(f => /^page\.tsx?$/.test(f))) out.push(dir);
  return out;
}

describe("route loading fallbacks", () => {
  const segments = pageSegments(appDir);

  it("finds every page segment", () => {
    // Ten routes today: the overview plus nine sections. A failure here means
    // the walker stopped matching the tree, so the assertions below would be
    // vacuously passing.
    expect(segments.length).toBeGreaterThanOrEqual(10);
  });

  it.each(segments.map(s => path.relative(appDir, s) || "."))(
    "app/%s has a loading.tsx",
    rel => {
      const dir = path.join(appDir, rel);
      const has = readdirSync(dir).some(f => /^loading\.tsx?$/.test(f));
      expect(
        has,
        `app/${rel} renders a page but has no loading.tsx. Without one the ` +
          `App Router cannot prefetch this dynamic route and paints nothing ` +
          `on click — the click reads as ignored for the whole server round ` +
          `trip. Add a skeleton built from components/ui/skeleton.tsx.`,
      ).toBe(true);
    },
  );
});
