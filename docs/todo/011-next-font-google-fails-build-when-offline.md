---
id: 011
title: next/font/google is a build-time network dependency that fails the build, not just degrades, when unreachable
status: open
opened: 2026-09-02
owner: unassigned
closed:
---

## Problem

`app/layout.tsx:2,8-9` loads both panel fonts through `next/font/google`:

```ts
import { Inter, Vazirmatn } from "next/font/google";
const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const vazirmatn = Vazirmatn({ subsets: ["arabic"], variable: "--font-fa", display: "swap" });
```

The *runtime* result is genuinely self-hosted — confirmed during Task 5 of
the design-system plan (grepping `.next/static` for `fonts.googleapis.com`/
`fonts.gstatic.com` finds nothing; the served `@font-face` points at a local
`/_next/static/media/...` path). But that self-hosting is achieved by
**fetching the font CSS and files from Google Fonts at build time** and
writing the result into `.next/static/media`. If that fetch fails —
because the build host has no outbound network, DNS is down, or Google
Fonts itself is unreachable — the loader does not fall back to a system
font or otherwise degrade. It calls `nextFontError`, which throws, and the
webpack/turbopack build fails outright:

```js
// node_modules/next/dist/compiled/@next/font/dist/google/loader.js:97
if (fontFaceDeclarations == null) {
    (0, next_font_error_1.nextFontError)(`Failed to fetch \`${fontFamily}\` from Google Fonts.`);
}
// same file, line 120, for the font file download itself
if (fontFileBuffer == null) {
    (0, next_font_error_1.nextFontError)(`Failed to fetch \`${fontFamily}\` from Google Fonts.`);
}
```

`nextFontError` (`node_modules/next/dist/compiled/@next/font/dist/next-font-error.js`)
is an unconditional `throw new Error(...)` — there is no dev/production
branch, no retry, and no cached-fallback path in this loader.

## Why it matters

`jamasp-panel` is one of two always-on services this project runs
(alongside `jamasp-authd`), documented in the top-level `CLAUDE.md` and the
`deploy` skill. An incident recovery, a host rebuild, or any rebuild
performed from a network-degraded environment (the exact kind of moment a
production panel is often rebuilt in) would fail at `next build` with a
Google Fonts network error, even though nothing about the panel's own code,
data, or the `jamasp` CLI it depends on has changed. That is a fragile
coupling for a self-hosted internal tool to carry silently.

## Evidence

Checked directly, 2026-09-02:

- `app/layout.tsx:2,8-9` — the `next/font/google` import and both font
  calls.
- `node_modules/next/dist/compiled/@next/font/dist/google/loader.js:97,120` —
  both `nextFontError` call sites (CSS fetch failure, font file fetch
  failure), quoted above.
- `node_modules/next/dist/compiled/@next/font/dist/next-font-error.js` —
  `nextFontError` is an unconditional throw, no fallback branch.
- `docs/superpowers/plans/2026-09-01-panel-design-system.md:959-963` — the
  plan itself already flags a related, narrower issue (`next/font/google`
  is a build-time SWC stub in dev, so a runtime `typeof` check on it is
  meaningless) but does not address the offline-build failure mode above.
- Not tested here: an actual offline build (would require disabling
  outbound network for the build host, out of scope for a source-review
  pass). The throw path above is read directly from the shipped loader
  source, not inferred.

## Fix

Vendor the two font files and switch to `next/font/local`, which has no
network dependency at build time. The design-system plan already sketched
this exact fallback for Vazirmatn specifically, for a different reason
(`docs/superpowers/plans/2026-09-01-panel-design-system.md:977-980`):

```ts
import localFont from "next/font/local";
const vazirmatn = localFont({
  src: "./fonts/Vazirmatn[wght].woff2",
  variable: "--font-fa",
  display: "swap",
});
```

The same treatment applies to Inter. Concretely:

1. Download the specific Inter and Vazirmatn `woff2` files currently
   fetched from Google Fonts (the exact subset/weight range `next/font/google`
   resolved — check the generated `@font-face` blocks in
   `.next/static/media`/`.next/dev/static/chunks/[next]_internal_font_google_*`
   for the URLs and `unicode-range`s actually in use, so the vendored files
   match what's shipped today).
2. Commit them under `panel/app/fonts/`.
3. Replace both `next/font/google` calls in `app/layout.tsx` with
   `next/font/local`, keeping the same `variable` names (`--font-sans`,
   `--font-fa`) so nothing downstream (`app/globals.css`'s `--font-sans`/
   `--font-fa` bindings) needs to change.
4. Re-verify Task 5's own self-hosting check still passes (no
   `fonts.googleapis.com`/`fonts.gstatic.com` in `.next/static`) and that
   the build succeeds with the build host's network disabled.

## Done when

- `next build` succeeds with outbound network disabled (or blocked to
  `fonts.googleapis.com`/`fonts.gstatic.com` specifically), proving the
  build-time dependency is gone.
- Rendered output is visually unchanged (same font files, same
  `unicode-range` coverage) — a diff of the generated `@font-face` blocks
  before/after should show only the `src` URL scheme changing from a
  build-fetched path to a checked-in one, not different font data.
- `docs/superpowers/specs/2026-09-01-panel-redesign-design.md`'s error
  table is corrected — see the note below, already done as part of the
  same review pass that filed this item.

## Related

- `app/layout.tsx` — the two font calls.
- `docs/superpowers/plans/2026-09-01-panel-design-system.md:955-980` —
  Task 5, which already sketched the `next/font/local` fallback for
  Vazirmatn (for a different trigger condition: the font not being in the
  manifest at all, not a network failure).
- `docs/superpowers/specs/2026-09-01-panel-redesign-design.md`'s Error
  handling table previously read "Font fetch fails at build |
  `next/font` metric-adjusted fallback; no layout shift" — that row
  describes the *size-mismatch* fallback (`adjustFontFallbackMetrics`,
  which only ever engages once a font has already loaded, to avoid
  layout shift against the fallback font while `display: swap` is
  pending) and does not cover a **fetch** failure at all, which is the
  fetch-time `nextFontError` throw documented above. Corrected in the
  same commit that filed this item to describe the real failure mode: the
  build fails outright, with no runtime fallback.
- `.superpowers/sdd/2026-09-01-panel-design-system/final-fix-report.md` —
  the review pass that filed this item.
