import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUpcomingProjectTwitter, fetchUpcomingProjects } from "../src/launch-radar.js";

afterEach(() => vi.unstubAllGlobals());

describe("Launch Radar project socials", () => {
  it("keeps a verified X link returned by the Radar list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{
      id: 10,
      name: "Upcoming",
      status: "INITIALIZED",
      chain: "BASE",
      launchedAt: "2026-07-21T00:00:00Z",
      socials: { VERIFIED_LINKS: { TWITTER: "https://x.com/upcoming" } },
    }] })));
    const projects = await fetchUpcomingProjects(new Date("2026-07-19T00:00:00Z"));
    expect(projects[0]).toMatchObject({ virtualId: "10", projectTwitter: "https://x.com/upcoming" });
  });

  it("can read an Upcoming X link without requiring a token address", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: {
      id: 10,
      socials: { VERIFIED_LINKS: { TWITTER: "https://x.com/upcoming" } },
    } })));
    await expect(fetchUpcomingProjectTwitter("10")).resolves.toBe("https://x.com/upcoming");
  });
});
