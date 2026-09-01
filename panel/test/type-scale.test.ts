import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

describe("type scale", () => {
  it("defines every step", () => {
    const css = readFileSync(path.join(root, "app/globals.css"), "utf8");
    for (const step of ["display", "title", "heading", "body", "meta", "label"]) {
      expect(css, `--text-${step} is missing`).toContain(`--text-${step}:`);
    }
  });

  // The platform minimum is 11pt on mobile, and this panel is a phone target.
  it("has no font size below 11px anywhere", () => {
    const offenders: string[] = [];
    for (const file of [...sources(path.join(root, "app")), ...sources(path.join(root, "components"))]) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/text-\[(\d+)px\]/g)) {
        if (Number(m[1]) < 11) offenders.push(`${path.relative(root, file)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
