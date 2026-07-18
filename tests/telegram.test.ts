import { describe, expect, it } from "vitest";
import { isTelegramChatAllowed } from "../src/telegram.js";

describe("Telegram whitelist", () => {
  it("keeps backward-compatible open access when the whitelist is empty", () => {
    expect(isTelegramChatAllowed("123", new Set())).toBe(true);
  });

  it("only allows exact chat IDs when the whitelist is configured", () => {
    const allowed = new Set(["123", "-456"]);
    expect(isTelegramChatAllowed("123", allowed)).toBe(true);
    expect(isTelegramChatAllowed("-456", allowed)).toBe(true);
    expect(isTelegramChatAllowed("789", allowed)).toBe(false);
  });
});
