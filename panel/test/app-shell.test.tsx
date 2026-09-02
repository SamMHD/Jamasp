import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestTone } from "@/components/shell/app-shell";

// SideNav/TabBar/TopBar all call usePathname() — needed for the full
// AppShell render further down, harmless for the pure ingestTone tests above.
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

const NOW = new Date("2026-08-01T12:00:00Z");

describe("ingestTone", () => {
  // Same 60-minute rule StatusStrip already applies, so the shell and the
  // Overview cannot disagree about whether ingest is healthy.
  it("is fresh within the hour", () => {
    expect(ingestTone("2026-08-01T11:05:00Z", NOW)).toBe("fresh");
  });
  it("is stale past the hour", () => {
    expect(ingestTone("2026-08-01T10:30:00Z", NOW)).toBe("stale");
  });
  it("is stale exactly at the boundary", () => {
    expect(ingestTone("2026-08-01T11:00:00Z", NOW)).toBe("fresh");
    expect(ingestTone("2026-08-01T10:59:59Z", NOW)).toBe("stale");
  });
  // A fresh host has never ingested; that is not the same as stale, and
  // claiming either would be a fabricated status.
  it("is unknown when ingest has never run", () => {
    expect(ingestTone(null, NOW)).toBe("unknown");
  });
  it("is unknown when the timestamp is unparseable", () => {
    expect(ingestTone("not-a-date", NOW)).toBe("unknown");
  });
});

// A1: getMeta runs during ROOT layout render, where app/error.tsx cannot
// catch it (Next only wraps layouts *below* the root — see
// app/global-error.tsx). Before this branch the root layout did no data
// access at all; a throw here now takes down all nine routes with the
// framework's bare error page unless AppShell catches it itself.
//
// Real conditions, not a mocked db module: an isolated JAMASP_ROOT whose
// state/ directory has no jamasp.db at all is exactly "a fresh host before
// the first CLI run" — lib/db.ts's `fileMustExist: true` throws on that for
// real, the same way it does on a host mid-deploy or with JAMASP_ROOT
// misconfigured. vi.resetModules() + dynamic import is the established
// pattern in this suite (see test/files-edge-cases.test.ts) for making
// lib/paths.ts re-read the env var into a fresh module graph.
describe("AppShell against an isolated root with no db file yet", () => {
  let tmpRoot: string | undefined;

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
    delete process.env.JAMASP_ROOT;
  });

  async function renderAgainstFreshRoot(): Promise<string> {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "jamasp-app-shell-no-db-"));
    // Deliberately no state/ directory at all — the DB open must throw,
    // not merely find an empty table.
    process.env.JAMASP_ROOT = tmpRoot;
    vi.resetModules();
    const { AppShell } = await import("@/components/shell/app-shell");
    return renderToStaticMarkup(<AppShell>{<div>page content</div>}</AppShell>);
  }

  it("renders instead of throwing when the db file doesn't exist yet", async () => {
    // No try/catch here on purpose: an uncaught throw from AppShell's own
    // render would fail this test with that exception, which is exactly
    // the proof required — the old behaviour was to throw.
    const html = await renderAgainstFreshRoot();
    // Falls back to "unknown", not a fabricated "fresh"/"stale" — visible in
    // TopBar's status-dot aria-label ("Alerts — ingest unknown").
    expect(html).toContain("ingest unknown");
    expect(html).toContain("page content");
  });
});
