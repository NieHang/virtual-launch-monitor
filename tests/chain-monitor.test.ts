import { describe, expect, it } from "vitest";
import { projectIdFromLaunchInput, tokenFromLaunchLog } from "../src/chain-monitor.js";

describe("tokenFromLaunchLog", () => {
  it("extracts the indexed token address from a Virtuals launch event", () => {
    expect(tokenFromLaunchLog({ topics: [
      "0xb9ee8aa6d909a3efd0bf1b0bc2bde7f998f7ad30178b0d45f9227f5382cebc8f",
      "0x000000000000000000000000113cfce15eb91465dde44e7805af1f9c93941487",
    ] })).toBe("0x113cfce15eb91465dde44e7805af1f9c93941487");
  });

  it("rejects a malformed indexed topic", () => {
    expect(tokenFromLaunchLog({ topics: ["0x0", "0x1234"] })).toBeUndefined();
  });
});

describe("projectIdFromLaunchInput", () => {
  it("extracts the Virtuals id from a CDN image embedded in launch calldata", () => {
    const text = "https://s3.ap-southeast-1.amazonaws.com/virtualprotocolcdn/113111_Pons_AI.png";
    expect(projectIdFromLaunchInput(`0x${Buffer.from(text).toString("hex")}`)).toBe("113111");
  });

  it("returns undefined for external images", () => {
    const text = "https://example.com/project.png";
    expect(projectIdFromLaunchInput(`0x${Buffer.from(text).toString("hex")}`)).toBeUndefined();
  });
});
