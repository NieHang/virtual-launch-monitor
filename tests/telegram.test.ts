import { describe, expect, it } from "vitest";
import { formatAlert, formatCompactUsd, isTelegramChatAllowed } from "../src/telegram.js";

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

describe("Frontrun alert formatting", () => {
  const base = {
    virtualId: "123",
    chainKey: "base" as const,
    tokenAddress: "0x0000000000000000000000000000000000000001",
    tokenName: "Project",
    launchedAt: "2026-07-20T08:00:00+08:00",
    projectTwitter: "https://x.com/project",
    explorer: "https://basescan.org",
  };

  it("formats Solana alerts with a Solscan token link", () => {
    const mint = "HyTQyxUVyB8kqFpgGh2Ej77JJrNNSUrcYc9kAA2zCTq8";
    const text = formatAlert({ ...base, chainKey: "solana", tokenAddress: mint, explorer: "https://solscan.io" });
    expect(text).toContain("网络：Solana");
    expect(text).toContain(`https://solscan.io/token/${mint}`);
    expect(text).not.toContain(`https://solscan.io/address/${mint}`);
  });

  it("formats an important Smart Followers alert with handles", () => {
    const text = formatAlert({ ...base, frontrunAttention: {
      totalCount: 2,
      smartFollowers: [{ twitter: "kol_one" }, { twitter: "kol_two" }],
      virtualOfficials: [],
      resolved: true,
    } });
    expect(text).toContain("重要提醒");
    expect(text).toContain("Smart Followers：2");
    expect(text).toContain("@kol_one、@kol_two");
  });

  it("formats the highest alert when a Virtual official is in the top list", () => {
    const text = formatAlert({ ...base, frontrunAttention: {
      totalCount: 10,
      smartFollowers: [{ twitter: "hananyss" }],
      virtualOfficials: ["hananyss"],
      resolved: true,
    } });
    expect(text).toContain("最高提醒");
    expect(text).toContain("Virtual 官方关注：@hananyss");
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
