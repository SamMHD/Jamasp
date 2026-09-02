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

// Extracts the body of the first `@theme inline { ... }` block in `css`,
// matching braces so nested rules (none today, but don't assume forever)
// don't truncate the extraction early.
function themeInlineBody(css: string): string {
  const marker = "@theme inline";
  const markerStart = css.indexOf(marker);
  if (markerStart === -1) return "";
  const braceStart = css.indexOf("{", markerStart);
  if (braceStart === -1) return "";
  let depth = 0;
  for (let i = braceStart; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(braceStart + 1, i);
    }
  }
  return css.slice(braceStart + 1);
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

  // Ruling R4 guard: the type-scale tokens must live in a plain `@theme`
  // block, never inside `@theme inline`. `inline` bakes each token's
  // literal value straight into every generated utility (e.g.
  // `.text-meta{font-size:.6875rem}`), so the utility never reads
  // `var(--text-meta)` at all — the mobile step-up's `@layer base` media
  // query then only ever changes a custom property nothing consumes, and
  // mobile silently renders at desktop sizes with no visible signal. The
  // other tests above can't catch this: they only check that the tokens
  // are declared *somewhere* in globals.css, which is equally true whether
  // they sit in the plain block (working) or the inline block (dead).
  it("keeps the type scale out of @theme inline", () => {
    const css = readFileSync(path.join(root, "app/globals.css"), "utf8");
    const inlineBody = themeInlineBody(css);
    for (const step of ["display", "title", "heading", "body", "meta", "label"]) {
      expect(
        inlineBody,
        `--text-${step} must not be declared inside @theme inline. ` +
          `@theme inline bakes the literal value straight into every generated ` +
          `utility instead of referencing the custom property, so the mobile ` +
          `step-up's @layer base media-query override of --text-${step} would ` +
          `change a variable no utility reads — the mobile scale would silently ` +
          `stop working while every other test here still passes. Keep the type ` +
          `scale in its own plain @theme block instead.`
      ).not.toContain(`--text-${step}:`);
    }
  });
});
