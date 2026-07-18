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
    expect(store.stats().pendingNotifications).toBe(0);
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
});
