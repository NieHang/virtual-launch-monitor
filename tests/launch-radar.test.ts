import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUpcomingProjects } from "../src/launch-radar.js";

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

  it("includes a future initialized project with a migration token address", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.searchParams.has("filters[launchInfo][launchRadarEnabled][$eq]")) {
        return Response.json({ data: [] });
      }
      return Response.json({ data: [{
        id: 130418,
        name: "HALO",
        symbol: "HALO",
        status: "INITIALIZED",
        chain: "BASE",
        launchedAt: "2026-08-06T13:00:04.162Z",
        migrateTokenAddress: "0xbbd27C575fB0e113219D610cc787B02Eeff71d42",
      }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const projects = await fetchUpcomingProjects(new Date("2026-08-06T12:20:00Z"));

    expect(projects).toEqual([expect.objectContaining({ virtualId: "130418", name: "HALO" })]);
    const migrationUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(migrationUrl.searchParams.get("filters[migrateTokenAddress][$notNull]")).toBe("true");
    expect(migrationUrl.searchParams.get("filters[status][$eq]")).toBe("INITIALIZED");
    expect(migrationUrl.searchParams.get("filters[launchedAt][$gt]")).toBe("2026-08-06T12:20:00.000Z");
  });
});
