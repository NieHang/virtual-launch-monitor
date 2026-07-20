import { describe, expect, it, vi } from "vitest";
import { FrontrunAttentionCoordinator, FrontrunService, shouldNotifyForAttention, twitterUsername } from "../src/frontrun.js";
import { SqliteStore } from "../src/store.js";
import type { LiveProject } from "../src/types.js";

function project(): LiveProject {
  return {
    virtualId: "123",
    chainKey: "base",
    tokenAddress: "0x0000000000000000000000000000000000000001",
    launchedAt: new Date("2026-07-20T00:00:00Z"),
    projectTwitter: "https://x.com/example_project",
  };
}

describe("FrontrunService", () => {
  it("uses one top-list request and detects Virtual officials case-insensitively", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      status: true,
      data: {
        totalCount: 1351,
        smartFollowers: [
          { twitter: "@IntoPurpleMoon", name: "Official" },
          { twitter: "https://x.com/OtherKOL", name: "Other" },
        ],
        meta: { resolved: true },
      },
    }));
    const result = await new FrontrunService("secret", fetcher as typeof fetch)
      .getSmartFollowers("https://x.com/project");

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.frontrun.pro/api/v1/pro/twitter/project/smart-followers");
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer secret" });
    expect(result).toMatchObject({ totalCount: 1351, virtualOfficials: ["IntoPurpleMoon"], resolved: true });
    expect(result.smartFollowers.map(({ twitter }) => twitter)).toEqual(["IntoPurpleMoon", "OtherKOL"]);
  });

  it("does not qualify zero or unresolved results for notification", () => {
    expect(shouldNotifyForAttention({ totalCount: 0, smartFollowers: [], virtualOfficials: [], resolved: true })).toBe(false);
    expect(shouldNotifyForAttention({ totalCount: 2, smartFollowers: [], virtualOfficials: [], resolved: false })).toBe(false);
    expect(shouldNotifyForAttention({ totalCount: 2, smartFollowers: [], virtualOfficials: [], resolved: true })).toBe(true);
  });

  it("extracts usernames from supported X formats", () => {
    expect(twitterUsername("@hello_world")).toBe("hello_world");
    expect(twitterUsername("https://twitter.com/hello_world/status/1")).toBe("hello_world");
    expect(twitterUsername("https://example.com/hello_world")).toBeUndefined();
  });
});

describe("FrontrunAttentionCoordinator", () => {
  it("persists and reuses the first launch result", async () => {
    const store = new SqliteStore(":memory:");
    const getSmartFollowers = vi.fn(async () => ({
      totalCount: 1,
      smartFollowers: [{ twitter: "celesteanglm" }],
      virtualOfficials: ["celesteanglm"],
      resolved: true,
    }));
    const coordinator = new FrontrunAttentionCoordinator(store, { getSmartFollowers } as unknown as FrontrunService);
    await expect(coordinator.forLaunch(project())).resolves.toMatchObject({ status: "success" });
    await expect(coordinator.forLaunch(project())).resolves.toMatchObject({ status: "success" });
    expect(getSmartFollowers).toHaveBeenCalledTimes(1);
    store.close();
  });
});
