import { afterEach, describe, expect, it } from "vitest";

const ORIGINAL = process.env.INMOB;

describe("INMOB feature flag", () => {
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.INMOB;
    else process.env.INMOB = ORIGINAL;
  });

  it("is disabled when unset or given an unrecognized value", async () => {
    delete process.env.INMOB;
    const { inmobEnabled } = await import("@/server/inmob/flag");
    expect(inmobEnabled()).toBe(false);
    process.env.INMOB = "enabled";
    expect(inmobEnabled()).toBe(false);
  });

  it("enables only for an explicit on value, case and whitespace insensitive", async () => {
    const { inmobEnabled } = await import("@/server/inmob/flag");
    for (const value of ["on", "ON", " true ", "1", "sí"]) {
      process.env.INMOB = value;
      expect(inmobEnabled()).toBe(true);
    }
    for (const value of ["off", "false", "0", "", "no"]) {
      process.env.INMOB = value;
      expect(inmobEnabled()).toBe(false);
    }
  });
});
