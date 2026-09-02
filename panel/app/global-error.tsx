"use client";

// The belt-and-braces complement to app/error.tsx. error.tsx wraps every
// route segment *below* the root layout in a React error boundary, but it
// does not wrap the root layout itself — a throw during the root layout's
// own render (e.g. AppShell's getMeta read, see the try/catch and its
// comment in components/shell/app-shell.tsx) has nowhere else to land, and
// without this file it surfaces as Next's bare "Application error" page on
// every route instead of a working, on-brand fallback. Per the Next docs
// (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
// error.md), global-error must define its own <html> and <body> — it
// replaces the root layout entirely when active, and does not inherit the
// layout's own <head> (so no pre-paint theme script runs here). Importing
// globals.css directly gives this page the same design tokens the rest of
// the panel uses; without the pre-paint script the `@media
// (prefers-color-scheme: dark)` fallback already in globals.css is what
// picks dark vs. light, exactly as it does for a JS-disabled reader anywhere
// else in the app.
import "./globals.css";

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    // global-error must include its own html and body tags.
    <html lang="en">
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <div className="flex min-h-screen items-center justify-center p-4">
          <div className="w-full max-w-sm rounded border border-primary/40 bg-primary/5 p-4 text-sm text-foreground">
            <p className="font-medium">Couldn&apos;t load the Jamasp panel</p>
            <p className="mt-1 text-muted-foreground">{error.message}</p>
            <button onClick={reset} className="mt-2 rounded border border-primary/40 px-2 py-1">
              retry
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
