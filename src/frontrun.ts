import { logger } from "./logger.js";
import type { FrontrunAttention, FrontrunCheck, LiveProject, SmartFollower } from "./types.js";
import type { SqliteStore } from "./store.js";

const FRONTRUN_API_URL = "https://api.frontrun.pro/api/v1/pro/twitter";

export const VIRTUAL_OFFICIALS = [
  "celesteanglm",
  "IntoPurpleMoon",
  "0xTP91",
  "Ryhar8103",
  "sal_hotpot666",
  "DonJohnsonSays",
  "umeirzz",
  "hananyss",
] as const;

const normalizedVirtualOfficials = new Map(
  VIRTUAL_OFFICIALS.map((handle) => [handle.toLowerCase(), handle]),
);

interface FrontrunResponse {
  status?: boolean;
  message?: string;
  data?: {
    smartFollowers?: Array<{
      twitter?: string;
      name?: string;
      primaryLabel?: string;
      position?: string;
    }>;
    totalCount?: number;
    meta?: { resolved?: boolean };
  };
}

export class FrontrunService {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async getSmartFollowers(projectTwitter: string): Promise<FrontrunAttention> {
    const username = twitterUsername(projectTwitter);
    if (!username) throw new Error("项目 X 地址中没有有效用户名");
    const response = await this.fetcher(`${FRONTRUN_API_URL}/${encodeURIComponent(username)}/smart-followers`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "x-copilot-client-language": "zh_CN",
      },
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => undefined) as FrontrunResponse | undefined;
    if (!response.ok || !payload?.status) {
      throw new Error(payload?.message ?? `Frontrun API returned ${response.status}`);
    }
    const totalCount = payload.data?.totalCount;
    if (!Number.isInteger(totalCount) || (totalCount ?? -1) < 0) {
      throw new Error("Frontrun API 返回了无效的 Smart Followers 数量");
    }
    const smartFollowers = (payload.data?.smartFollowers ?? []).flatMap((item): SmartFollower[] => {
      const twitter = normalizeTwitterHandle(item.twitter);
      if (!twitter) return [];
      return [{
        twitter,
        ...(item.name ? { name: item.name } : {}),
        ...(item.primaryLabel ? { primaryLabel: item.primaryLabel } : {}),
        ...(item.position ? { position: item.position } : {}),
      }];
    });
    const virtualOfficials = [...new Set(smartFollowers.flatMap(({ twitter }) => {
      const official = normalizedVirtualOfficials.get(twitter.toLowerCase());
      return official ? [official] : [];
    }))];
    return {
      totalCount: totalCount!,
      smartFollowers,
      virtualOfficials,
      resolved: payload.data?.meta?.resolved !== false,
    };
  }
}

export class FrontrunAttentionCoordinator {
  private readonly blockedTwitterUsernames: ReadonlySet<string>;

  constructor(
    private readonly store: SqliteStore,
    private readonly service?: FrontrunService,
    xBlockList: readonly string[] = [],
  ) {
    this.blockedTwitterUsernames = new Set(
      xBlockList.flatMap((entry) => {
        const username = twitterUsername(entry);
        return username ? [username.toLowerCase()] : [];
      }),
    );
  }

  isBlocked(projectTwitter?: string): boolean {
    if (!projectTwitter) return false;
    const username = twitterUsername(projectTwitter);
    return Boolean(username && this.blockedTwitterUsernames.has(username.toLowerCase()));
  }

  async forLaunch(project: LiveProject): Promise<FrontrunCheck> {
    if (this.isBlocked(project.projectTwitter)) {
      return { status: "failed", error: "项目 X 已被黑名单过滤" };
    }
    const existing = this.store.getFrontrunCheck(project.virtualId);
    if (existing) return existing;
    if (!this.service || !project.projectTwitter) {
      return { status: "failed", error: "Frontrun 查询未启用或项目没有 X" };
    }
    if (!this.store.claimFrontrunCheck(project.virtualId)) {
      return this.store.getFrontrunCheck(project.virtualId) ?? { status: "checking" };
    }
    try {
      const attention = await this.service.getSmartFollowers(project.projectTwitter);
      this.store.saveFrontrunCheck(project.virtualId, attention);
      return { status: "success", attention };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.failFrontrunCheck(project.virtualId, message);
      logger.warn("Frontrun launch lookup failed", { virtualId: project.virtualId, error: message });
      return { status: "failed", error: message };
    }
  }
}

export function shouldNotifyForAttention(attention?: FrontrunAttention): attention is FrontrunAttention {
  return Boolean(attention?.resolved && attention.totalCount > 0);
}

export function twitterUsername(value: string): string | undefined {
  const trimmed = value.trim();
  const direct = trimmed.match(/^@?([A-Za-z0-9_]{1,15})$/)?.[1];
  if (direct) return direct;
  try {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(url.hostname)) return undefined;
    const username = url.pathname.split("/").filter(Boolean)[0];
    return username && /^[A-Za-z0-9_]{1,15}$/.test(username) ? username : undefined;
  } catch {
    return undefined;
  }
}

function normalizeTwitterHandle(value?: string): string | undefined {
  if (!value) return undefined;
  return twitterUsername(value);
}
