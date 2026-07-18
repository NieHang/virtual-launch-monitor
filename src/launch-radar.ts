import type { ChainKey } from "./types.js";

interface LaunchRadarItem {
  id?: number;
  name?: string;
  symbol?: string;
  status?: string;
  chain?: string;
  launchedAt?: string | null;
}

interface LaunchRadarResponse { data?: LaunchRadarItem[] }

export interface UpcomingProject {
  virtualId: string;
  name: string;
  symbol?: string;
  chainKey: ChainKey;
  launchedAt: Date;
}

export async function fetchUpcomingProjects(now = new Date()): Promise<UpcomingProject[]> {
  const url = new URL("https://api2.virtuals.io/api/virtuals");
  url.searchParams.set("filters[launchInfo][launchRadarEnabled][$eq]", "true");
  url.searchParams.set("sort[0]", "createdAt:desc");
  url.searchParams.set("populate[0]", "launchInfo");
  url.searchParams.set("pagination[page]", "1");
  url.searchParams.set("pagination[pageSize]", "100");
  const response = await fetch(url, {
    headers: { accept: "application/json, text/plain, */*" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Virtuals Launch Radar API returned ${response.status}`);
  const payload = await response.json() as LaunchRadarResponse;

  return (payload.data ?? []).flatMap((item): UpcomingProject[] => {
    const chainKey = normalizeChain(item.chain);
    const launchedAt = item.launchedAt ? new Date(item.launchedAt) : undefined;
    if (item.status !== "INITIALIZED" || !chainKey || !launchedAt || launchedAt <= now) return [];
    return [{
      virtualId: String(item.id ?? 0),
      name: item.name ?? item.symbol ?? "Unnamed project",
      ...(item.symbol ? { symbol: item.symbol } : {}),
      chainKey,
      launchedAt,
    }];
  }).sort((left, right) => left.launchedAt.getTime() - right.launchedAt.getTime());
}

function normalizeChain(value?: string): ChainKey | undefined {
  if (value?.toUpperCase() === "BASE") return "base";
  if (value?.toUpperCase() === "ROBINHOOD") return "robinhood";
  return undefined;
}
