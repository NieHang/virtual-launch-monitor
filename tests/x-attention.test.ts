import { afterEach, describe, expect, it, vi } from "vitest";
import type { fetch as undiciFetch } from "undici";
import { parseXUsername, XAttentionService } from "../src/x-attention.js";

afterEach(() => vi.unstubAllGlobals());

describe("XAttentionService", () => {
  it("normalizes supported X account links", () => {
    expect(parseXUsername("https://x.com/Example_AI?s=20")).toBe("Example_AI");
    expect(parseXUsername("twitter.com/Example_AI/")).toBe("Example_AI");
    expect(parseXUsername("https://example.com/Example_AI")).toBeUndefined();
  });

  it("detects Virtual official followers and follows pagination", async () => {
    const officialUsers = [
      ["1", "celesteanglm"], ["2", "IntoPurpleMoon"], ["3", "0xTP91"], ["4", "Ryhar8103"],
      ["5", "sal_hotpot666"], ["6", "DonJohnsonSays"], ["7", "umeirzz"], ["8", "hananyss"],
    ].map(([id, username]) => ({ id: id!, username: username! }));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/2/users/by/username/project") {
        return Response.json({ data: { id: "99", username: "project" } });
      }
      if (url.pathname === "/2/users/by") return Response.json({ data: officialUsers });
      if (url.pathname === "/2/users/99/followers" && !url.searchParams.has("pagination_token")) {
        return Response.json({ data: [{ id: "2", username: "IntoPurpleMoon" }], meta: { next_token: "next" } });
      }
      if (url.pathname === "/2/users/99/followers") {
        return Response.json({ data: [{ id: "7", username: "umeirzz" }], meta: {} });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof undiciFetch;

    const result = await new XAttentionService("token", fetchMock).checkProject("https://x.com/project", new Date("2026-07-19T00:00:00Z"));
    expect(result).toMatchObject({ status: "matched", projectUserId: "99", checkedAt: "2026-07-19T00:00:00.000Z" });
    expect(result.followers.map((follower) => follower.username)).toEqual(["IntoPurpleMoon", "umeirzz"]);
  });

  it("reports unknown instead of zero when X access is unavailable", async () => {
    const result = await new XAttentionService().checkProject("https://x.com/project");
    expect(result).toMatchObject({ status: "unknown", followers: [], error: "未配置 X_BEARER_TOKEN" });
  });
});
