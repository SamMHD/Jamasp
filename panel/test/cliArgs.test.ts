import { describe, expect, it } from "vitest";
import { buildWakeupAddArgs, buildWakeupCancelArgs } from "../lib/cliArgs";

describe("buildWakeupAddArgs", () => {
  it("inserts a `--` separator before the positional args", () => {
    const args = buildWakeupAddArgs("2030-01-01T05:00:00Z", "scan", "check");
    expect(args).toEqual(["wakeup", "add", "--", "2030-01-01T05:00:00Z", "scan", "check"]);
  });

  it("passes a dash-prefixed task through intact as its own argv element, not as an option", () => {
    const args = buildWakeupAddArgs("2030-01-01T05:00:00Z", "scan", "--dry-run");
    // the separator must come before the task, and the task must survive
    // unmodified as a single positional element (index 5), not be dropped
    // or split by the parser
    expect(args[2]).toBe("--");
    expect(args).toHaveLength(6);
    expect(args[5]).toBe("--dry-run");
  });

  it("passes an em-dash-prefixed task through intact", () => {
    const args = buildWakeupAddArgs("2030-01-01T05:00:00Z", "brief", "-0.5% move — investigate");
    expect(args).toEqual([
      "wakeup", "add", "--",
      "2030-01-01T05:00:00Z", "brief", "-0.5% move — investigate",
    ]);
  });
});

describe("buildWakeupCancelArgs", () => {
  it("inserts a `--` separator before the id", () => {
    expect(buildWakeupCancelArgs(7)).toEqual(["wakeup", "cancel", "--", "7"]);
  });
});
