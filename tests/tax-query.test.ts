import { describe, expect, it } from "vitest";
import { formatVirtual, receiptContainsTokenTransfer } from "../src/tax-query.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

describe("tax query helpers", () => {
  it("only associates a tax payment with a receipt containing the queried token transfer", () => {
    const token = "0xb807ceed5a4a3d78e314d8c0c9039b257fc16513";
    expect(receiptContainsTokenTransfer({ logs: [{
      address: token,
      blockNumber: "0x1",
      transactionHash: "0x1",
      topics: [TRANSFER_TOPIC],
      data: "0x0",
    }] }, token)).toBe(true);
    expect(receiptContainsTokenTransfer({ logs: [{
      address: "0x0000000000000000000000000000000000000001",
      blockNumber: "0x1",
      transactionHash: "0x1",
      topics: [TRANSFER_TOPIC],
      data: "0x0",
    }] }, token)).toBe(false);
  });

  it("formats 18-decimal VIRTUAL amounts without floating point loss", () => {
    expect(formatVirtual(85n * 10n ** 18n)).toBe("85");
    expect(formatVirtual(1_234_500_000_000_000_000n)).toBe("1.2345");
  });
});
