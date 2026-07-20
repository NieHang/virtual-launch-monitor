import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLatestLaunches } from "../src/live-monitor.js";

afterEach(() => vi.unstubAllGlobals());

describe("fetchLatestLaunches", () => {
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
