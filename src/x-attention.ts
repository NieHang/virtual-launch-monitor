import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import type { OfficialXFollower, XAttentionResult } from "./types.js";

const X_API_BASE = "https://api.x.com/2";
const xDispatcher = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY
  ? new EnvHttpProxyAgent()
  : undefined;

export const VIRTUAL_OFFICIAL_X_ACCOUNTS = [
  { role: "AI Developers", username: "celesteanglm" },
  { role: "Robotics", username: "IntoPurpleMoon" },
  { role: "Degen", username: "0xTP91" },
  { role: "Moonshot Product", username: "Ryhar8103" },
  { role: "客服", username: "sal_hotpot666" },
  { role: "US", username: "DonJohnsonSays" },
  { role: "EMEA", username: "umeirzz" },
  { role: "Institution", username: "hananyss" },
] as const;

interface XUser { id: string; username: string }
interface XUsersResponse {
  data?: XUser[];
  errors?: Array<{ detail?: string; title?: string }>;
  meta?: { next_token?: string };
}
interface XUserResponse { data?: XUser }

export class XAttentionService {
  private officialAccounts: Promise<OfficialXFollower[]> | undefined;

  constructor(
    private readonly bearerToken?: string,
    private readonly fetchImpl: typeof undiciFetch = undiciFetch,
  ) {}

  async checkProject(projectTwitter: string, now = new Date()): Promise<XAttentionResult> {
    const checkedAt = now.toISOString();
    const projectUsername = parseXUsername(projectTwitter);
    if (!projectUsername) {
      return { status: "unknown", followers: [], checkedAt, error: "项目认证 X 链接格式无效" };
    }
    if (!this.bearerToken) {
      return { status: "unknown", projectUsername, followers: [], checkedAt, error: "未配置 X_BEARER_TOKEN" };
    }

    try {
      const [project, officials] = await Promise.all([
        this.getUserByUsername(projectUsername),
        this.getOfficialAccounts(),
      ]);
      const officialById = new Map(officials.map((account) => [account.userId, account]));
      const matched = new Map<string, OfficialXFollower>();
      let paginationToken: string | undefined;
      do {
        const url = new URL(`${X_API_BASE}/users/${encodeURIComponent(project.id)}/followers`);
        url.searchParams.set("max_results", "1000");
        if (paginationToken) url.searchParams.set("pagination_token", paginationToken);
        const payload = await this.request<XUsersResponse>(url);
        for (const follower of payload.data ?? []) {
          const official = officialById.get(follower.id);
          if (official) matched.set(official.userId, official);
        }
        paginationToken = payload.meta?.next_token;
      } while (paginationToken && matched.size < officials.length);

      const followers = [...matched.values()].sort((left, right) =>
        VIRTUAL_OFFICIAL_X_ACCOUNTS.findIndex((item) => item.username.toLowerCase() === left.username.toLowerCase())
        - VIRTUAL_OFFICIAL_X_ACCOUNTS.findIndex((item) => item.username.toLowerCase() === right.username.toLowerCase())
      );
      return {
        status: followers.length ? "matched" : "none",
        projectUsername: project.username,
        projectUserId: project.id,
        followers,
        checkedAt,
      };
    } catch (error) {
      return {
        status: "unknown",
        projectUsername,
        followers: [],
        checkedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private getOfficialAccounts(): Promise<OfficialXFollower[]> {
    this.officialAccounts ??= this.loadOfficialAccounts().catch((error) => {
      this.officialAccounts = undefined;
      throw error;
    });
    return this.officialAccounts;
  }

  private async loadOfficialAccounts(): Promise<OfficialXFollower[]> {
    const url = new URL(`${X_API_BASE}/users/by`);
    url.searchParams.set("usernames", VIRTUAL_OFFICIAL_X_ACCOUNTS.map((account) => account.username).join(","));
    const payload = await this.request<XUsersResponse>(url);
    const users = new Map((payload.data ?? []).map((user) => [user.username.toLowerCase(), user]));
    const missing = VIRTUAL_OFFICIAL_X_ACCOUNTS.filter((account) => !users.has(account.username.toLowerCase()));
    if (missing.length) throw new Error(`无法解析官方 X 账号：${missing.map((account) => `@${account.username}`).join(", ")}`);
    return VIRTUAL_OFFICIAL_X_ACCOUNTS.map((account) => {
      const user = users.get(account.username.toLowerCase())!;
      return { userId: user.id, username: user.username, role: account.role };
    });
  }

  private async getUserByUsername(username: string): Promise<XUser> {
    const payload = await this.request<XUserResponse>(new URL(`${X_API_BASE}/users/by/username/${encodeURIComponent(username)}`));
    const user = payload.data;
    if (!user) throw new Error(`X 账号 @${username} 不存在或不可访问`);
    return user;
  }

  private async request<T>(url: URL): Promise<T> {
    const response = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${this.bearerToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
      ...(xDispatcher ? { dispatcher: xDispatcher } : {}),
    });
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      throw new Error(`X API 返回 ${response.status}${retryAfter ? `，${retryAfter} 秒后可重试` : ""}`);
    }
    return await response.json() as T;
  }
}

export function parseXUsername(value: string): string | undefined {
  const trimmed = value.trim();
  const direct = trimmed.match(/^@?([A-Za-z0-9_]{1,15})$/);
  if (direct) return direct[1];
  try {
    const url = new URL(trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`);
    if (!/^(?:www\.|mobile\.)?(?:x\.com|twitter\.com)$/i.test(url.hostname)) return undefined;
    const username = url.pathname.split("/").filter(Boolean)[0];
    return username && /^[A-Za-z0-9_]{1,15}$/.test(username) ? username : undefined;
  } catch {
    return undefined;
  }
}
