import { describe, expect, it, vi } from "vitest";
import { WeChatApi, formatWeChatAlert } from "../src/wechat.js";
import type { AlertPayload } from "../src/types.js";

const payload: AlertPayload = {
  virtualId: "123",
  chainKey: "base",
  tokenAddress: "0x0000000000000000000000000000000000000001",
  tokenName: "Project",
  tokenSymbol: "PRJ",
  launchedAt: "2026-07-25T08:00:00+08:00",
  projectTwitter: "https://x.com/project",
  explorer: "https://basescan.org",
  frontrunAttention: {
    totalCount: 3,
    smartFollowers: [{ twitter: "hananyss" }],
    virtualOfficials: ["hananyss"],
    resolved: true,
  },
};

describe("WeChat notifications", () => {
  it("formats the official account and project links", () => {
    const text = formatWeChatAlert(payload);
    expect(text).toContain("V 官方人员关注项目");
    expect(text).toContain("@hananyss");
    expect(text).toContain("https://app.virtuals.io/virtuals/123");
    expect(text).toContain(payload.tokenAddress);
  });

  it("posts WeCom text that the WeChat plugin can display", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      Response.json({ errcode: 0, errmsg: "ok" })
    ));
    await new WeChatApi("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test", fetcher as typeof fetch)
      .sendAlert(payload);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      msgtype: string;
      text: { content: string };
    };
    expect(body.msgtype).toBe("text");
    expect(body.text.content).toContain("@hananyss");
    expect(body.text.content).not.toContain("<font");
  });

  it("rejects an application-level WeCom error", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      Response.json({ errcode: 93000, errmsg: "invalid webhook" })
    ));
    await expect(new WeChatApi("https://example.com/hook", fetcher as typeof fetch).sendAlert(payload))
      .rejects.toThrow("invalid webhook");
  });
});
