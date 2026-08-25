import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../src/store.js";
import type { LiveProject } from "../src/types.js";

const stores: SqliteStore[] = [];
const tempDirectories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createStore(): SqliteStore {
  const store = new SqliteStore(":memory:");
  stores.push(store);
  return store;
}

function project(overrides: Partial<LiveProject> = {}): LiveProject {
  return {
    virtualId: "100",
    chainKey: "robinhood",
    tokenAddress: "0x0000000000000000000000000000000000000001",
    tokenName: "Test by Virtuals",
    tokenSymbol: "TEST",
    launchedAt: new Date("2026-07-17T12:00:00Z"),
    projectTwitter: "https://x.com/verified",
    ...overrides,
  };
}

describe("SqliteStore", () => {
  it("subscribes new users to Solana by default", () => {
    const store = createStore();
    expect(store.upsertUser({ chatId: "sol-user" }).chains).toEqual(["base", "robinhood", "solana"]);
  });

  it("persists user notification state and chains", () => {
    const store = createStore();
    const created = store.upsertUser({ chatId: "123", username: "alice" });
    expect(created.enabled).toBe(false);
    store.setUserEnabled("123", true);
    store.setUserChains("123", ["base"]);
    expect(store.getUser("123")).toMatchObject({ enabled: true, chains: ["base"], username: "alice" });
  });

  it("never notifies launches loaded into the startup baseline", () => {
    const store = createStore();
    store.upsertUser({ chatId: "123" });
    store.setUserEnabled("123", true);
    const item = project();
    store.baselineLaunch(item, new Date("2026-07-17T12:01:00Z"));
    expect(store.registerLiveLaunch(item, new Date("2026-07-17T12:02:00Z"), 300_000)).toBe(false);
    expect(store.isNotificationCandidate(item, new Date("2026-07-17T12:02:00Z"), 300_000)).toBe(false);
    expect(store.stats().pendingNotifications).toBe(0);
  });

  it("reactivates a future launch that was loaded into the startup baseline", () => {
    const store = createStore();
    const item = project({
      virtualId: "119656",
      launchedAt: new Date("2026-07-23T12:00:00Z"),
    });
    const baselineTime = new Date("2026-07-22T11:51:51Z");
    store.baselineLaunch(item, baselineTime);

    expect(store.isNotificationCandidate(item, baselineTime, 300_000)).toBe(false);
    const launchTime = new Date("2026-07-23T12:00:10Z");
    expect(store.registerLiveLaunch(item, launchTime, 300_000)).toBe(true);
    expect(store.isNotificationCandidate(item, launchTime, 300_000)).toBe(true);
  });

  it("keeps a fresh launch eligible while its attention lookup is retried", () => {
    const store = createStore();
    const item = project();
    const now = new Date("2026-07-17T12:01:00Z");
    expect(store.registerLiveLaunch(item, now, 300_000)).toBe(true);
    expect(store.registerLiveLaunch(item, now, 300_000)).toBe(false);
    expect(store.isNotificationCandidate(item, now, 300_000)).toBe(true);
  });

  it("queues a fresh verified launch once for active matching users", () => {
    const store = createStore();
    store.upsertUser({ chatId: "active" });
    store.setUserEnabled("active", true);
    store.upsertUser({ chatId: "paused" });
    const item = project();
    const now = new Date("2026-07-17T12:01:00Z");
    expect(store.registerLiveLaunch(item, now, 300_000)).toBe(true);
    expect(store.enqueueForActiveUsers(item)).toBe(1);
    expect(store.enqueueForActiveUsers(item)).toBe(0);
    expect(store.claimOutbox(10).map((entry) => entry.chatId)).toEqual(["active"]);
  });

  it("queues an official-followed project once for WeChat without Telegram users", () => {
    const store = createStore();
    const item = project();
    const attention = {
      totalCount: 2,
      smartFollowers: [{ twitter: "hananyss" }],
      virtualOfficials: ["hananyss"],
      resolved: true,
    };
    expect(store.enqueueForWeChat(item, attention)).toBe(1);
    expect(store.enqueueForWeChat(item, attention)).toBe(0);
    expect(store.claimWeChatOutbox(10)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          virtualId: item.virtualId,
          frontrunAttention: expect.objectContaining({ virtualOfficials: ["hananyss"] }),
        }),
      }),
    ]);
  });

  it("disables existing users and discards queued alerts outside the whitelist", () => {
    const directory = mkdtempSync(join(tmpdir(), "virtual-launch-monitor-"));
    tempDirectories.push(directory);
    const filename = join(directory, "whitelist.sqlite");
    const initialStore = new SqliteStore(filename);
    initialStore.upsertUser({ chatId: "allowed" });
    initialStore.setUserEnabled("allowed", true);
    initialStore.upsertUser({ chatId: "blocked" });
    initialStore.setUserEnabled("blocked", true);
    initialStore.enqueueForActiveUsers(project());
    initialStore.close();

    const restrictedStore = new SqliteStore(filename, new Set(["allowed"]));
    expect(restrictedStore.getUser("allowed")?.enabled).toBe(true);
    expect(restrictedStore.getUser("blocked")?.enabled).toBe(false);
    expect(restrictedStore.claimOutbox(10).map((entry) => entry.chatId)).toEqual(["allowed"]);
    restrictedStore.close();
  });

  it("does not notify an unseen old launch", () => {
    const store = createStore();
    store.upsertUser({ chatId: "active" });
    store.setUserEnabled("active", true);
    expect(store.registerLiveLaunch(project(), new Date("2026-07-17T13:00:00Z"), 300_000)).toBe(false);
    expect(store.stats().pendingNotifications).toBe(0);
  });

  it("can qualify a just-launched project when creator verification appears later", () => {
    const store = createStore();
    const unverified = project();
    delete unverified.projectTwitter;
    expect(store.registerLiveLaunch(unverified, new Date("2026-07-17T12:00:10Z"), 300_000)).toBe(false);
    expect(store.registerLiveLaunch(project(), new Date("2026-07-17T12:01:00Z"), 300_000)).toBe(true);
  });

  it("persists the incremental tax scan cursor and exact bigint total", () => {
    const store = createStore();
    const tokenAddress = "0x0000000000000000000000000000000000000001";
    store.saveTaxScan("robinhood", tokenAddress, {
      launchBlock: 100,
      scannedToBlock: 250,
      taxWei: 72_442_227_521_009_874_560_945n,
      transactionCount: 488,
    });
    expect(store.getTaxScan("robinhood", tokenAddress)).toEqual({
      launchBlock: 100,
      scannedToBlock: 250,
      taxWei: 72_442_227_521_009_874_560_945n,
      transactionCount: 488,
    });
  });
});
