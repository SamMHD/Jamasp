import { describe, expect, it } from "vitest";
import { ingestTone } from "@/components/shell/app-shell";

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
