import { env } from "./config.js";
import { shouldNotifyForAttention, type FrontrunAttentionCoordinator } from "./frontrun.js";
import { logger } from "./logger.js";
import type { SqliteStore } from "./store.js";
import type { ChainKey, LiveProject } from "./types.js";

interface VirtualsSocials {
  VERIFIED_LINKS?: { TWITTER?: string | null; TELEGRAM?: string | null } | null;
}

interface VirtualsItem {
  id?: number;
  name?: string;
  symbol?: string;
  status?: string;
  chain?: string;
  preToken?: string | null;
  preTokenPair?: string | null;
  tokenAddress?: string | null;
  lpAddress?: string | null;
  launchedAt?: string | null;
  creator?: { socials?: VirtualsSocials | null } | null;
  socials?: VirtualsSocials | null;
}

interface VirtualsResponse { data?: VirtualsItem[] }
interface VirtualDetailResponse { data?: VirtualsItem }

export class LiveLaunchMonitor {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private initialized = false;
  private consecutiveFailures = 0;
  private startedAt?: Date;

  constructor(
    private readonly store: SqliteStore,
    private readonly frontrun?: FrontrunAttentionCoordinator,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.startedAt = new Date();
    await this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async tick(): Promise<void> {
    let succeeded = false;
    try {
      const now = new Date();
      const projects = await fetchLatestLaunches();
      if (!this.initialized) {
        for (const project of projects) this.store.baselineLaunch(project, now);
        this.initialized = true;
        logger.info("Latest launch baseline established", { projects: projects.length });
      } else {
        for (const project of projects) {
          // A project that launched before this process started may appear in the
          // official index later. Record it, but never mistake it for a live event.
          if (this.startedAt && project.launchedAt.getTime() < this.startedAt.getTime()) {
            this.store.baselineLaunch(project, now);
            continue;
          }
          if (!this.store.registerLiveLaunch(project, now, env.LIVE_LAUNCH_MAX_AGE_MS)) continue;
          const check = await this.frontrun?.forLaunch(project);
          const attention = check?.status === "success" ? check.attention : undefined;
          const queued = shouldNotifyForAttention(attention)
            ? this.store.enqueueForActiveUsers(project, attention)
            : 0;
          logger.info("Qualified new launch discovered", {
            virtualId: project.virtualId,
            token: project.tokenAddress,
            chain: project.chainKey,
            launchedAt: project.launchedAt.toISOString(),
            smartFollowers: attention?.totalCount,
            frontrunStatus: check?.status ?? "disabled",
            queued,
          });
        }
      }
      this.consecutiveFailures = 0;
      succeeded = true;
    } catch (error) {
      this.consecutiveFailures += 1;
      logger.warn("Latest launch refresh failed", {
        failures: this.consecutiveFailures,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (!this.stopped) {
        const base = succeeded ? env.OFFICIAL_API_POLL_MS : Math.min(60_000, env.OFFICIAL_API_POLL_MS * 2 ** Math.min(this.consecutiveFailures, 4));
        this.timer = setTimeout(() => void this.tick(), base + Math.floor(Math.random() * 1000));
        this.timer.unref();
      }
    }
  }
}

export async function fetchLatestLaunches(): Promise<LiveProject[]> {
  const url = new URL("https://api2.virtuals.io/api/virtuals");
  url.searchParams.set("filters[status]", "5");
  url.searchParams.set("sort[0]", "age:desc");
  url.searchParams.set("sort[1]", "createdAt:desc");
  url.searchParams.set("noCache", String(Date.now()));
  url.searchParams.set("pagination[page]", "1");
  url.searchParams.set("pagination[pageSize]", "25");
  const response = await fetch(url, {
    headers: { accept: "application/json, text/plain, */*", "cache-control": "no-cache" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Virtuals API returned ${response.status}`);
  const payload = await response.json() as VirtualsResponse;
  return (payload.data ?? []).flatMap(toLiveProject);
}

export async function fetchLaunchByToken(tokenAddress: string): Promise<LiveProject | undefined> {
  const byPreToken = await fetchLaunchByTokenField("preToken", tokenAddress);
  return byPreToken ?? fetchLaunchByTokenField("tokenAddress", tokenAddress);
}

async function fetchLaunchByTokenField(field: "preToken" | "tokenAddress", tokenAddress: string): Promise<LiveProject | undefined> {
  const url = new URL("https://api2.virtuals.io/api/virtuals");
  url.searchParams.set(`filters[${field}][$eqi]`, tokenAddress);
  url.searchParams.set("noCache", String(Date.now()));
  url.searchParams.set("pagination[pageSize]", "1");
  const response = await fetch(url, {
    headers: { accept: "application/json, text/plain, */*", "cache-control": "no-cache" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Virtuals token lookup returned ${response.status}`);
  const payload = await response.json() as VirtualsResponse;
  return (payload.data ?? []).flatMap(toLiveProject)[0];
}

export async function fetchLaunchById(virtualId: string): Promise<LiveProject | undefined> {
  const url = new URL(`https://api2.virtuals.io/api/virtuals/${encodeURIComponent(virtualId)}`);
  url.searchParams.set("noCache", String(Date.now()));
  const response = await fetch(url, {
    headers: { accept: "application/json, text/plain, */*", "cache-control": "no-cache" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Virtuals project lookup returned ${response.status}`);
  const payload = await response.json() as VirtualDetailResponse;
  return payload.data ? toLiveProject(payload.data)[0] : undefined;
}

export function toLiveProject(item: VirtualsItem): LiveProject[] {
  const chainKey = normalizeChain(item.chain);
  const tokenAddress = item.preToken ?? item.tokenAddress;
  const launchedAt = item.launchedAt ? new Date(item.launchedAt) : undefined;
  if (!item.id || !chainKey || !tokenAddress || !launchedAt || !Number.isFinite(launchedAt.getTime())) return [];
  const creatorVerified = item.creator?.socials?.VERIFIED_LINKS;
  const projectVerified = item.socials?.VERIFIED_LINKS;
  const projectTwitter = creatorVerified?.TWITTER ?? projectVerified?.TWITTER;
  const projectTelegram = creatorVerified?.TELEGRAM ?? projectVerified?.TELEGRAM;
  return [{
    virtualId: String(item.id),
    chainKey,
    tokenAddress,
    ...(item.name ? { tokenName: item.name } : {}),
    ...(item.symbol ? { tokenSymbol: item.symbol } : {}),
    ...(item.preTokenPair ? { preTokenPair: item.preTokenPair } : {}),
    ...(item.lpAddress ? { lpAddress: item.lpAddress } : {}),
    launchedAt,
    ...(projectTwitter ? { projectTwitter } : {}),
    ...(projectTelegram ? { projectTelegram } : {}),
  }];
}

function normalizeChain(value?: string): ChainKey | undefined {
  if (value?.toUpperCase() === "BASE") return "base";
  if (value?.toUpperCase() === "ROBINHOOD") return "robinhood";
  return undefined;
}
