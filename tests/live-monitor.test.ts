import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLatestLaunches } from "../src/live-monitor.js";

afterEach(() => vi.unstubAllGlobals());

describe("fetchLatestLaunches", () => {
  it("maps SOLANA launches and keeps their base58 mint address", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{
      id: 136950,
      name: "Laso by Virtuals",
      symbol: "LASO",
      chain: "SOLANA",
      preToken: "HyTQyxUVyB8kqFpgGh2Ej77JJrNNSUrcYc9kAA2zCTq8",
      preTokenPair: "9JiruYXjE3S4FhYRpWBQk8z5b1WD2E4yGe9ZrXxH424g",
      launchedAt: "2026-08-25T10:48:24.991Z",
      creator: { socials: { VERIFIED_LINKS: { TWITTER: "https://x.com/laso" } } },
    }] })));

    await expect(fetchLatestLaunches()).resolves.toEqual([expect.objectContaining({
      virtualId: "136950",
      chainKey: "solana",
      tokenAddress: "HyTQyxUVyB8kqFpgGh2Ej77JJrNNSUrcYc9kAA2zCTq8",
      preTokenPair: "9JiruYXjE3S4FhYRpWBQk8z5b1WD2E4yGe9ZrXxH424g",
    })]);
  });

  it("falls back to project socials when creator is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [
      {
        id: 1,
        name: "Verified",
        symbol: "GOOD",
        chain: "ROBINHOOD",
        preToken: "0x1",
        launchedAt: "2026-07-17T12:00:00Z",
        socials: { VERIFIED_LINKS: { TWITTER: "https://x.com/good", TELEGRAM: "https://t.me/good" } },
      },
      {
        id: 2,
        name: "Unverified",
        chain: "BASE",
        preToken: "0x2",
        launchedAt: "2026-07-17T12:01:00Z",
        socials: null,
      },
    ] }), { status: 200 })));

    const projects = await fetchLatestLaunches();
    expect(projects).toHaveLength(2);
    expect(projects[0]).toMatchObject({ projectTwitter: "https://x.com/good", projectTelegram: "https://t.me/good" });
    expect(projects[1]?.projectTwitter).toBeUndefined();
    const requestUrl = String((vi.mocked(fetch).mock.calls[0] ?? [])[0]);
    expect(requestUrl).toContain("noCache=");
  });

  it("reads creator socials when they are present", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{
      id: 3,
      name: "Creator verified",
      chain: "BASE",
      preToken: "0x3",
      launchedAt: "2026-07-17T12:02:00Z",
      creator: {
        socials: { VERIFIED_LINKS: { TWITTER: "https://x.com/creator", TELEGRAM: "https://t.me/creator" } },
      },
      socials: { VERIFIED_LINKS: { TWITTER: "https://x.com/project" } },
    }] }), { status: 200 })));

    const projects = await fetchLatestLaunches();
    expect(projects[0]).toMatchObject({
      projectTwitter: "https://x.com/creator",
      projectTelegram: "https://t.me/creator",
    });
  });
});
