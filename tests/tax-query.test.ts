import { describe, expect, it } from "vitest";
import { formatVirtual, taxLogBelongsToTokenBuy } from "../src/tax-query.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

describe("tax query helpers", () => {
  it("requires the tax payer to fund the target pool and that pool to send the target token", () => {
    const token = "0xb807ceed5a4a3d78e314d8c0c9039b257fc16513";
    const pool = "0x27bb54784406114db07b30cc8cc944f07427b791";
    const payer = "0x57fcfcc8260aaebe2a8619737a6d78ae38d0d0b8";
    const launchContract = "0xd4ccbfa37e2f35611b3042e4096ad7a3459bd007";
    const virtual = "0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31";
    const recipient = "0x0000000000000000000000000000000000000002";
    const taxLog = { address: virtual, topics: [TRANSFER_TOPIC, addressTopic(payer), addressTopic("0x32487287c65f11d53bbca89c2472171eb09bf337")] };
    const receipt = { to: launchContract, logs: [
      {
        address: virtual,
        blockNumber: "0x1",
        transactionHash: "0x1",
        topics: [TRANSFER_TOPIC, addressTopic(payer), addressTopic(pool)],
        data: "0x1",
      },
      {
        address: token,
        blockNumber: "0x1",
        transactionHash: "0x1",
        topics: [TRANSFER_TOPIC, addressTopic(pool), addressTopic(recipient)],
        data: "0x1",
      },
    ] };
    expect(taxLogBelongsToTokenBuy(receipt, taxLog, token, pool)).toBe(true);
    expect(taxLogBelongsToTokenBuy(receipt, taxLog, token, "0x0000000000000000000000000000000000000001")).toBe(false);
    const routedReceipt = { ...receipt, to: "0x0000000000000000000000000000000000000001" };
    expect(taxLogBelongsToTokenBuy(routedReceipt, taxLog, token, pool)).toBe(true);
  });

  it("formats 18-decimal VIRTUAL amounts without floating point loss", () => {
    expect(formatVirtual(85n * 10n ** 18n)).toBe("85");
    expect(formatVirtual(1_234_500_000_000_000_000n)).toBe("1.2345");
  });
});

function addressTopic(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}
