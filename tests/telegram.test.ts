import { describe, expect, it } from "vitest";
import { formatCompactUsd, isTelegramChatAllowed } from "../src/telegram.js";

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

describe("compact USD formatting", () => {
  it("uses compact suffixes for FDV values", () => {
    const virtualWei = 10n ** 18n;
    expect(formatCompactUsd(5_261_81n * virtualWei / 100n, 1)).toBe("$5.3K");
    expect(formatCompactUsd(1_000_000n * virtualWei, 1)).toBe("$1M");
    expect(formatCompactUsd(1_250_000_000n * virtualWei, 1)).toBe("$1.3B");
  });

  it("keeps small values readable", () => {
    expect(formatCompactUsd(526_180000000000000000n, 1)).toBe("$526.18");
  });
});
