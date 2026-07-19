import { setTimeout as delay } from "node:timers/promises";
import { env } from "./config.js";
import { fetchLaunchById, fetchLaunchByToken } from "./live-monitor.js";
import { logger } from "./logger.js";
import type { SqliteStore } from "./store.js";
import type { ChainKey } from "./types.js";
import type { XAttentionService } from "./x-attention.js";

const LAUNCH_TOPIC = "0xb9ee8aa6d909a3efd0bf1b0bc2bde7f998f7ad30178b0d45f9227f5382cebc8f";

const chains: Record<ChainKey, { rpcUrl: string; launchContract: string }> = {
  base: {
    rpcUrl: env.BASE_RPC_URL,
    launchContract: "0x1a540088125d00dd3990f9da45ca0859af4d3b01",
  },
  robinhood: {
    rpcUrl: env.ROBINHOOD_RPC_URL,
    launchContract: "0xd4ccbfa37e2f35611b3042e4096ad7a3459bd007",
  },
};

interface RpcLog {
  blockNumber: string;
  transactionHash: string;
  topics: string[];
}

interface RpcTransaction { input?: string }

interface RpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

export class ChainLaunchMonitor {
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private readonly lastBlocks = new Map<ChainKey, number>();
  private readonly resolvingTokens = new Set<string>();

  constructor(private readonly store: SqliteStore, private readonly xAttention: XAttentionService) {}

  async start(): Promise<void> {
    this.stopped = false;
    await Promise.all((Object.keys(chains) as ChainKey[]).map((chainKey) => this.establishBaseline(chainKey)));
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), env.CHAIN_POLL_MS);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      await Promise.all((Object.keys(chains) as ChainKey[]).map((chainKey) => this.pollChain(chainKey)));
    } catch (error) {
      logger.warn("Chain launch polling failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.schedule();
    }
  }

  private async pollChain(chainKey: ChainKey): Promise<void> {
    const config = chains[chainKey];
    const previous = this.lastBlocks.get(chainKey);
    if (previous === undefined) {
      await this.establishBaseline(chainKey);
      return;
    }
    const latestHex = await rpc<string>(config.rpcUrl, "eth_blockNumber", []);
    const latest = Number.parseInt(latestHex, 16);
    if (!Number.isFinite(latest) || latest <= previous) return;

    const logs = await rpc<RpcLog[]>(config.rpcUrl, "eth_getLogs", [{
      address: config.launchContract,
      topics: [LAUNCH_TOPIC],
      fromBlock: toHex(previous + 1),
      toBlock: latestHex,
    }]);
    this.lastBlocks.set(chainKey, latest);
    for (const log of logs) {
      const tokenAddress = tokenFromLaunchLog(log);
      if (!tokenAddress) continue;
      logger.info("On-chain Virtuals launch detected", {
        chain: chainKey,
        token: tokenAddress,
        transactionHash: log.transactionHash,
        block: Number.parseInt(log.blockNumber, 16),
      });
      let virtualId: string | undefined;
      try {
        const transaction = await rpc<RpcTransaction | null>(config.rpcUrl, "eth_getTransactionByHash", [log.transactionHash]);
        virtualId = projectIdFromLaunchInput(transaction?.input);
      } catch (error) {
        logger.warn("Launch transaction lookup failed", { chain: chainKey, tokenAddress, error: error instanceof Error ? error.message : String(error) });
      }
      void this.resolveAndNotify(chainKey, tokenAddress, virtualId);
    }
  }

  private async establishBaseline(chainKey: ChainKey): Promise<void> {
    try {
      const block = await rpc<string>(chains[chainKey].rpcUrl, "eth_blockNumber", []);
      const blockNumber = Number.parseInt(block, 16);
      if (!Number.isFinite(blockNumber)) throw new Error("invalid latest block");
      this.lastBlocks.set(chainKey, blockNumber);
      logger.info("Chain launch baseline established", { chain: chainKey, block: blockNumber });
    } catch (error) {
      logger.warn("Chain launch baseline failed; will retry", { chain: chainKey, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async resolveAndNotify(chainKey: ChainKey, tokenAddress: string, virtualId?: string): Promise<void> {
    const key = `${chainKey}:${tokenAddress.toLowerCase()}`;
    if (this.resolvingTokens.has(key)) return;
    this.resolvingTokens.add(key);
    const deadline = Date.now() + 90_000;
    try {
      while (!this.stopped && Date.now() < deadline) {
        try {
          const project = virtualId
            ? await fetchLaunchById(virtualId)
            : await fetchLaunchByToken(tokenAddress);
          if (project) {
            if (project.chainKey !== chainKey) {
              logger.warn("Token lookup returned a different chain", { tokenAddress, expected: chainKey, actual: project.chainKey });
              return;
            }
            const now = new Date();
            const isNew = this.store.registerLiveLaunch(project, now, env.LIVE_LAUNCH_MAX_AGE_MS);
            const attention = isNew ? await this.xAttention.checkProject(project.projectTwitter!) : undefined;
            if (attention) this.store.saveLaunchAttention(project.virtualId, attention);
            const queued = isNew ? this.store.enqueueForActiveUsers(project, attention) : 0;
            logger.info("On-chain launch resolved", {
              virtualId: project.virtualId,
              token: project.tokenAddress,
              chain: project.chainKey,
              qualified: Boolean(project.projectTwitter),
              officialFollowers: attention?.followers.length,
              attentionStatus: attention?.status,
              queued,
              lookup: virtualId ? "virtual-id" : "token-address",
              resolutionMs: now.getTime() - project.launchedAt.getTime(),
            });
            return;
          }
        } catch (error) {
          logger.warn("On-chain launch token lookup failed", { tokenAddress, error: error instanceof Error ? error.message : String(error) });
        }
        await delay(1500);
      }
      logger.warn("On-chain launch could not be resolved before deadline", { chain: chainKey, tokenAddress });
    } finally {
      this.resolvingTokens.delete(key);
    }
  }
}

export function tokenFromLaunchLog(log: Pick<RpcLog, "topics">): string | undefined {
  const topic = log.topics[1];
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return undefined;
  return `0x${topic.slice(-40)}`;
}

export function projectIdFromLaunchInput(input?: string): string | undefined {
  if (!input || !/^0x[0-9a-fA-F]+$/.test(input) || input.length % 2 !== 0) return undefined;
  const decoded = Buffer.from(input.slice(2), "hex").toString("utf8");
  return decoded.match(/virtualprotocolcdn\/(\d+)_/i)?.[1];
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
  const payload = await response.json() as RpcResponse<T>;
  if (payload.error) throw new Error(`${method} returned ${payload.error.code}: ${payload.error.message}`);
  if (payload.result === undefined) throw new Error(`${method} returned no result`);
  return payload.result;
}

function toHex(value: number): string {
  return `0x${value.toString(16)}`;
}
