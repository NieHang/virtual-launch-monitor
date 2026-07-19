import { describe, expect, it } from "vitest";
import { formatAlert, formatCompactUsd, formatUpcomingProject, isTelegramChatAllowed } from "../src/telegram.js";

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

describe("official X attention formatting", () => {
  const attention = {
    status: "matched" as const,
    followers: [{ userId: "2", username: "IntoPurpleMoon", role: "Robotics" }],
    checkedAt: "2026-07-19T00:00:00.000Z",
  };

  it("promotes a followed launch to a priority alert", () => {
    const text = formatAlert({
      virtualId: "100",
      chainKey: "base",
      tokenAddress: "0x0000000000000000000000000000000000000001",
      launchedAt: "2026-07-19 08:00:00",
      projectTwitter: "https://x.com/project",
      explorer: "https://basescan.org",
      xAttention: attention,
    });
    expect(text).toContain("🚨 Virtual 官方重点关注项目");
    expect(text).toContain("V官方关注：1/8 🔥");
    expect(text).toContain("• Robotics：@IntoPurpleMoon");
  });

  it("marks a followed Upcoming project as priority", () => {
    const text = formatUpcomingProject({
      virtualId: "200",
      name: "Upcoming",
      chainKey: "robinhood",
      launchedAt: new Date("2026-07-20T00:00:00Z"),
      projectTwitter: "https://x.com/upcoming",
    }, attention);
    expect(text).toContain("🔥 重点关注");
    expect(text).toContain("V官方关注：1/8 🔥");
  });
});
