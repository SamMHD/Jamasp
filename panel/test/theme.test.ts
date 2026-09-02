import { describe, expect, it } from "vitest";
import {
  nextPref, readPref, resolveAppearance, THEME_STORAGE_KEY, writePref,
} from "@/lib/theme";

describe("resolveAppearance", () => {
  it("honours an explicit choice regardless of the system", () => {
    expect(resolveAppearance("light", true)).toBe("light");
    expect(resolveAppearance("dark", false)).toBe("dark");
  });
  it("follows the system when the preference is system", () => {
    expect(resolveAppearance("system", true)).toBe("dark");
    expect(resolveAppearance("system", false)).toBe("light");
  });
});

describe("nextPref", () => {
  it("cycles system -> light -> dark -> system", () => {
    expect(nextPref("system")).toBe("light");
    expect(nextPref("light")).toBe("dark");
    expect(nextPref("dark")).toBe("system");
  });
});

describe("readPref", () => {
  it("defaults to system when nothing is stored", () => {
    expect(readPref({ getItem: () => null })).toBe("system");
  });
  it("defaults to system when the stored value is not a valid preference", () => {
    expect(readPref({ getItem: () => "midnight" })).toBe("system");
  });
  it("returns a valid stored preference", () => {
    expect(readPref({ getItem: () => "dark" })).toBe("dark");
  });
  // Private browsing makes the accessor itself throw, not return null.
  it("falls back to system when storage throws", () => {
    expect(readPref({ getItem: () => { throw new Error("denied"); } })).toBe("system");
  });
  it("falls back to system when there is no storage at all", () => {
    expect(readPref(null)).toBe("system");
  });
});

describe("writePref", () => {
  it("stores under the shared key", () => {
    const calls: [string, string][] = [];
    writePref({ setItem: (k, v) => { calls.push([k, v]); } }, "light");
    expect(calls).toEqual([[THEME_STORAGE_KEY, "light"]]);
  });
  it("does not throw when storage is unavailable", () => {
    expect(() => writePref({ setItem: () => { throw new Error("denied"); } }, "dark"))
      .not.toThrow();
    expect(() => writePref(null, "dark")).not.toThrow();
  });
});
