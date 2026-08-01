import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// These tests exercise robustness paths that the shared fixture root
// (test/fixtures/root) cannot cover without corrupting other tests:
//   - settings.yaml that parses to null (empty / comment-only file)
//   - predictions.jsonl with a malformed/truncated line
// Each test builds its own throwaway temp root, points JAMASP_ROOT at it,
// busts the module cache with vi.resetModules(), and dynamic-imports a
// fresh instance of lib/files so lib/paths.ts re-reads the new env var.

describe("files layer edge cases (isolated temp roots)", () => {
  let tmpRoot: string | undefined;

  afterEach(() => {
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = undefined;
    }
    delete process.env.JAMASP_ROOT;
  });

  it("maxRunsPerDay falls back to 20 when settings.yaml parses to null", async () => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "jamasp-files-settings-"));
    mkdirSync(path.join(tmpRoot, "config"), { recursive: true });
    // A comment-only YAML file parses to `null`, not `{}` or an error.
    writeFileSync(path.join(tmpRoot, "config", "settings.yaml"), "# no keys here, just a comment\n");

    process.env.JAMASP_ROOT = tmpRoot;
    vi.resetModules();
    const files = await import("../lib/files");

    expect(files.loadSettings()).toEqual({});
    expect(files.maxRunsPerDay()).toBe(20);
  });

  it("readPredictions skips a malformed line and keeps the valid entries", async () => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "jamasp-files-predictions-"));
    mkdirSync(path.join(tmpRoot, "state"), { recursive: true });
    const lines = [
      '{"id":"z1","date":"2026-07-01","claim":"ok one","direction":"up","horizon_days":1,"confidence":0.5,"created_at":"2026-07-01T00:00:00Z","outcome":null,"scored_at":null,"note":null}',
      '{"id":"z2","date":"2026-07-02","claim":"truncated write', // simulates an interrupted append: no closing quote/brace
      '{"id":"z3","date":"2026-07-03","claim":"ok two","direction":"down","horizon_days":1,"confidence":0.4,"created_at":"2026-07-03T00:00:00Z","outcome":"hit","scored_at":"2026-07-04T00:00:00Z","note":null}',
    ];
    writeFileSync(path.join(tmpRoot, "state", "predictions.jsonl"), lines.join("\n") + "\n");

    process.env.JAMASP_ROOT = tmpRoot;
    vi.resetModules();
    const files = await import("../lib/files");

    const preds = files.readPredictions();
    expect(preds.map(p => p.id)).toEqual(["z1", "z3"]);
    expect(preds.length).toBe(2);
  });
});
