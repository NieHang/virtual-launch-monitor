import { describe, expect, it } from "vitest";
import { toBeijingIsoString } from "../src/time.js";

describe("Beijing time formatting", () => {
  it("formats UTC instants with an explicit +08:00 offset", () => {
    expect(toBeijingIsoString(new Date("2026-07-16T14:15:45.000Z"))).toBe(
      "2026-07-16T22:15:45.000+08:00",
    );
  });
});
