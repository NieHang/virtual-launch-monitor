import { normalizeChain } from "./chains.js";
import type { ChainKey } from "./types.js";

interface LaunchRadarItem {
  id?: number;
  name?: string;
  symbol?: string;
  status?: string;
  chain?: string;
  launchedAt?: string | null;
  migrateTokenAddress?: string | null;
  socials?: {
    VERIFIED_LINKS?: { TWITTER?: string | null } | null;
  } | null;
}

interface LaunchRadarResponse { data?: LaunchRadarItem[] }

export interface UpcomingProject {
  virtualId: string;
  name: string;
  symbol?: string;
  chainKey: ChainKey;
  launchedAt: Date;
  projectTwitter?: string;
}

export async function fetchUpcomingProjects(now = new Date()): Promise<UpcomingProject[]> {
  const radarUrl = new URL("https://api2.virtuals.io/api/virtuals");
  radarUrl.searchParams.set("filters[launchInfo][launchRadarEnabled][$eq]", "true");
  radarUrl.searchParams.set("sort[0]", "createdAt:desc");
  radarUrl.searchParams.set("populate[0]", "launchInfo");
  radarUrl.searchParams.set("pagination[page]", "1");
  radarUrl.searchParams.set("pagination[pageSize]", "100");

  const migrationUrl = new URL("https://api2.virtuals.io/api/virtuals");
  migrationUrl.searchParams.set("filters[migrateTokenAddress][$notNull]", "true");
  migrationUrl.searchParams.set("filters[status][$eq]", "INITIALIZED");
  migrationUrl.searchParams.set("filters[launchedAt][$gt]", now.toISOString());
  migrationUrl.searchParams.set("sort[0]", "launchedAt:asc");
  migrationUrl.searchParams.set("pagination[page]", "1");
  migrationUrl.searchParams.set("pagination[pageSize]", "100");

  const [radarPayload, migrationPayload] = await Promise.all([
    fetchItems(radarUrl, "Virtuals Launch Radar API"),
    fetchItems(migrationUrl, "Virtuals migration launch API"),
  ]);
  const items = [
    ...(radarPayload.data ?? []),
    ...(migrationPayload.data ?? []).filter((item) => item.migrateTokenAddress),
  ];
  const projectsById = new Map<string, UpcomingProject>();

  for (const item of items) {
    const chainKey = normalizeChain(item.chain);
    const launchedAt = item.launchedAt ? new Date(item.launchedAt) : undefined;
    if (item.status !== "INITIALIZED" || !chainKey || !launchedAt || launchedAt <= now) continue;
    const virtualId = String(item.id ?? 0);
    projectsById.set(virtualId, {
      virtualId,
      name: item.name ?? item.symbol ?? "Unnamed project",
      ...(item.symbol ? { symbol: item.symbol } : {}),
      chainKey,
      launchedAt,
      ...(item.socials?.VERIFIED_LINKS?.TWITTER ? { projectTwitter: item.socials.VERIFIED_LINKS.TWITTER } : {}),
    });
  }

  return [...projectsById.values()].sort((left, right) => left.launchedAt.getTime() - right.launchedAt.getTime());
}

async function fetchItems(url: URL, source: string): Promise<LaunchRadarResponse> {
  const response = await fetch(url, {
    headers: { accept: "application/json, text/plain, */*" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${source} returned ${response.status}`);
  return response.json() as Promise<LaunchRadarResponse>;
}
