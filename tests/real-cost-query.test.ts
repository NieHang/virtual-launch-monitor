import { describe, expect, it } from "vitest";
import {
  calculateAntiSniperTaxPercent,
  calculateEffectiveFdvWei,
  calculateFdvWei,
  formatVirtualFdv,
} from "../src/real-cost-query.js";

describe("real cost query helpers", () => {
  it("matches the router's timestamp-based linear anti-sniper formula", () => {
    const start = 1_700_000_000;
    expect(calculateAntiSniperTaxPercent(99, 5_880, start, start - 1)).toBe(99);
    expect(calculateAntiSniperTaxPercent(99, 5_880, start, start)).toBe(99);
    // Solidity floors the continuously decaying percentage to an integer.
    expect(calculateAntiSniperTaxPercent(99, 5_880, start, start + 60)).toBe(97);
    expect(calculateAntiSniperTaxPercent(99, 5_880, start, start + 2_940)).toBe(49);
    expect(calculateAntiSniperTaxPercent(99, 5_880, start, start + 5_820)).toBe(1);
    expect(calculateAntiSniperTaxPercent(99, 5_880, start, start + 5_880)).toBe(0);
  });

  it("uses the duration supplied by the chain rather than assuming 98 minutes", () => {
    const start = 1_700_000_000;
    expect(calculateAntiSniperTaxPercent(99, 600, start, start + 300)).toBe(49);
    expect(calculateAntiSniperTaxPercent(99, 60, start, start + 30)).toBe(49);
  });

  it("calculates spot FDV from current pool reserves without floating point", () => {
    const supply = 1_000_000_000n * 10n ** 18n;
    const tokenReserve = 500_000_000n * 10n ** 18n;
    const virtualReserve = 25_000n * 10n ** 18n;
    expect(calculateFdvWei(supply, tokenReserve, virtualReserve)).toBe(50_000n * 10n ** 18n);
  });

  it("converts FDV into effective buy cost and leaves formatting precise", () => {
    const fdv = 1_142_000n * 10n ** 18n;
    expect(calculateEffectiveFdvWei(fdv, 73)).toBe(fdv * 100n / 27n);
    expect(formatVirtualFdv(fdv * 100n / 27n)).toBe("4,229,629.63");
  });
});
