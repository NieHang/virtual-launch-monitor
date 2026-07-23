import { env } from "./config.js";
import { fetchLaunchByToken } from "./live-monitor.js";
import type { SqliteStore } from "./store.js";
import type { ChainKey } from "./types.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const LAUNCH_TOPIC = "0xb9ee8aa6d909a3efd0bf1b0bc2bde7f998f7ad30178b0d45f9227f5382cebc8f";
const TAX_ADDRESS = "0x32487287c65f11d53bbca89c2472171eb09bf337";
const LOG_BLOCK_RANGE = 10_000;
const MAX_TAX_WINDOW_SECONDS = 98 * 60;
const PAIR_START_LOOKBACK_BLOCKS = 2_000;
const SELECTOR = {
  startTime: "0x78e97925",
  taxStartTime: "0x70e6e182",
} as const;

const chains: Record<ChainKey, { rpcUrl: string; virtualToken: string; launchContract: string }> = {
  base: {
    rpcUrl: env.BASE_RPC_URL,
    virtualToken: "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b",
    launchContract: "0x1a540088125d00dd3990f9da45ca0859af4d3b01",
  },
  robinhood: {
    rpcUrl: env.ROBINHOOD_RPC_URL,
    virtualToken: "0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31",
    launchContract: "0xd4ccbfa37e2f35611b3042e4096ad7a3459bd007",
  },
};

interface RpcLog {
  address: string;
  blockNumber: string;
  transactionHash: string;
  topics: string[];
  data: string;
}
interface RpcBlock { timestamp: string }
interface RpcReceipt { to: string | null; logs: RpcLog[] }
interface RpcResponse<T> { result?: T; error?: { code: number; message: string } }
interface LaunchInfo { blockNumber: number; bondingPool: string; startedAt?: number }

export interface TaxQueryResult {
  chainKey: ChainKey;
  tokenAddress: string;
  tokenName?: string;
  tokenSymbol?: string;
  launchBlock: number;
  scannedToBlock: number;
  taxAddress: string;
  taxWei: bigint;
  transactionCount: number;
}

export class TaxQueryService {
  constructor(private readonly store?: SqliteStore) {}

  async query(rawTokenAddress: string): Promise<TaxQueryResult> {
    const requestedTokenAddress = normalizeAddress(rawTokenAddress);
    if (!requestedTokenAddress) throw new Error("代币 CA 格式错误，请输入 0x 开头的 40 位十六进制地址。");

    const project = await fetchLaunchByToken(requestedTokenAddress);
    if (!project) throw new Error("未在 Virtuals 中找到这个代币 CA。");

    const tokenAddress = resolveTaxTokenAddress(requestedTokenAddress, project.tokenAddress);
    const chain = chains[project.chainKey];
    const latestHex = await rpc<string>(chain.rpcUrl, "eth_blockNumber", []);
    const latestBlock = parseHexNumber(latestHex, "latest block");
    const cached = this.store?.getTaxScan(project.chainKey, tokenAddress);
    const launch = cached
      ? await getLaunchInfoAtBlock(chain.rpcUrl, chain.launchContract, tokenAddress, cached.launchBlock)
      : await findLaunchInfoWithPairFallback(
        chain.rpcUrl,
        chain.launchContract,
        tokenAddress,
        Math.floor(project.launchedAt.getTime() / 1000),
        latestBlock,
        project.preTokenPair,
      );
    const launchBlock = launch.blockNumber;
    const taxWindowEndsAt = (launch.startedAt ?? Math.floor(project.launchedAt.getTime() / 1000)) + MAX_TAX_WINDOW_SECONDS;
    const scanToBlock = taxWindowEndsAt >= Math.floor(Date.now() / 1000)
      ? latestBlock
      : await findBlockAtOrBefore(chain.rpcUrl, taxWindowEndsAt, latestBlock, launchBlock);
    const scanFromBlock = cached ? cached.scannedToBlock + 1 : launchBlock;
    const taxLogs = await getLogsInRanges(chain.rpcUrl, {
      address: chain.virtualToken,
      topics: [TRANSFER_TOPIC, null, addressTopic(TAX_ADDRESS)],
    }, scanFromBlock, scanToBlock);

    let taxWei = cached?.taxWei ?? 0n;
    let transactionCount = cached?.transactionCount ?? 0;
    for (const batch of chunk(taxLogs, 10)) {
      const receipts = await Promise.all(batch.map((log) => rpc<RpcReceipt>(chain.rpcUrl, "eth_getTransactionReceipt", [log.transactionHash])));
      for (let index = 0; index < batch.length; index += 1) {
        const log = batch[index];
        const receipt = receipts[index];
        if (!log || !receipt || !taxLogBelongsToTokenBuy(receipt, log, tokenAddress, launch.bondingPool)) continue;
        taxWei += parseHexBigInt(log.data);
        transactionCount += 1;
      }
    }

    this.store?.saveTaxScan(project.chainKey, tokenAddress, {
      launchBlock,
      scannedToBlock: scanToBlock,
      taxWei,
      transactionCount,
    });

    return {
      chainKey: project.chainKey,
      tokenAddress,
      ...(project.tokenName ? { tokenName: project.tokenName } : {}),
      ...(project.tokenSymbol ? { tokenSymbol: project.tokenSymbol } : {}),
      launchBlock,
      scannedToBlock: scanToBlock,
      taxAddress: TAX_ADDRESS,
      taxWei,
      transactionCount,
    };
  }
}

export function resolveTaxTokenAddress(requestedTokenAddress: string, projectTokenAddress?: string): string {
  return normalizeAddress(projectTokenAddress ?? "") ?? requestedTokenAddress;
}

export function selectPairStartTimestamp(taxStartTime: bigint | undefined, startTime: bigint | undefined): number | undefined {
  const selected = taxStartTime && taxStartTime > 0n ? taxStartTime : startTime;
  if (!selected || selected <= 0n || selected > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(selected);
}

export function taxLogBelongsToTokenBuy(
  receipt: Pick<RpcReceipt, "logs">,
  taxLog: Pick<RpcLog, "address" | "topics">,
  tokenAddress: string,
  bondingPool: string,
): boolean {
  const payer = topicAddress(taxLog.topics[1]);
  if (!payer) return false;
  const targetTokenLeavesPool = receipt.logs.some((log) =>
    log.address.toLowerCase() === tokenAddress.toLowerCase()
    && log.topics[0]?.toLowerCase() === TRANSFER_TOPIC
    && topicAddress(log.topics[1]) === bondingPool.toLowerCase()
  );
  const payerFundsTargetPool = receipt.logs.some((log) =>
    log.address.toLowerCase() === taxLog.address.toLowerCase()
    && log.topics[0]?.toLowerCase() === TRANSFER_TOPIC
    && topicAddress(log.topics[1]) === payer
    && topicAddress(log.topics[2]) === bondingPool.toLowerCase(),
  );
  return targetTokenLeavesPool && payerFundsTargetPool;
}

export function formatVirtual(wei: bigint): string {
  const base = 10n ** 18n;
  const whole = wei / base;
  const fraction = (wei % base).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function normalizeAddress(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(trimmed) ? trimmed : undefined;
}

function addressTopic(address: string): string { return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`; }

function topicAddress(topic?: string): string | undefined {
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return undefined;
  return `0x${topic.slice(-40).toLowerCase()}`;
}

async function findLaunchInfoWithPairFallback(
  rpcUrl: string,
  launchContract: string,
  tokenAddress: string,
  launchedAt: number,
  latestBlock: number,
  bondingPool?: string,
): Promise<LaunchInfo> {
  try {
    return await findLaunchInfo(rpcUrl, launchContract, tokenAddress, launchedAt, latestBlock);
  } catch (launchError) {
    const normalizedPool = bondingPool ? normalizeAddress(bondingPool) : undefined;
    if (!normalizedPool) throw launchError;
    try {
      const startedAt = await readPairStartTimestamp(rpcUrl, normalizedPool);
      const approximateBlock = await findBlockAtOrBefore(rpcUrl, startedAt, latestBlock);
      return {
        blockNumber: Math.max(0, approximateBlock - PAIR_START_LOOKBACK_BLOCKS),
        bondingPool: normalizedPool,
        startedAt,
      };
    } catch {
      throw launchError;
    }
  }
}

async function findLaunchInfo(
  rpcUrl: string,
  launchContract: string,
  tokenAddress: string,
  launchedAt: number,
  latestBlock: number,
): Promise<LaunchInfo> {
  try {
    const sampleBlockNumber = Math.max(0, latestBlock - 10_000);
    const [latest, sample] = await Promise.all([
      rpc<RpcBlock>(rpcUrl, "eth_getBlockByNumber", [toHex(latestBlock), false]),
      rpc<RpcBlock>(rpcUrl, "eth_getBlockByNumber", [toHex(sampleBlockNumber), false]),
    ]);
    const latestTimestamp = parseHexNumber(latest.timestamp, "latest block timestamp");
    const sampleTimestamp = parseHexNumber(sample.timestamp, "sample block timestamp");
    const secondsPerBlock = Math.max(0.001, (latestTimestamp - sampleTimestamp) / (latestBlock - sampleBlockNumber));
    const estimatedBlock = Math.max(0, Math.min(latestBlock, Math.round(latestBlock - (latestTimestamp - launchedAt) / secondsPerBlock)));
    const searchRadius = 20_000;
    const logs = await rpc<RpcLog[]>(rpcUrl, "eth_getLogs", [{
      address: launchContract,
      topics: [LAUNCH_TOPIC, addressTopic(tokenAddress)],
      fromBlock: toHex(Math.max(0, estimatedBlock - searchRadius)),
      toBlock: toHex(Math.min(latestBlock, estimatedBlock + searchRadius)),
    }]);
    const launchLog = logs[0];
    if (launchLog) return launchInfoFromLog(launchLog);
  } catch {
    // Some providers cap eth_getLogs ranges. Timestamp lookup is slower but portable.
  }
  const approximateBlock = await findBlockAtOrBefore(rpcUrl, launchedAt, latestBlock);
  const logs = await rpc<RpcLog[]>(rpcUrl, "eth_getLogs", [{
    address: launchContract,
    topics: [LAUNCH_TOPIC, addressTopic(tokenAddress)],
    fromBlock: toHex(Math.max(0, approximateBlock - 1_000)),
    toBlock: toHex(Math.min(latestBlock, approximateBlock + 1_000)),
  }]);
  const launchLog = logs[0];
  if (!launchLog) throw new Error("Could not locate the token launch event");
  return launchInfoFromLog(launchLog);
}

async function readPairStartTimestamp(rpcUrl: string, bondingPool: string): Promise<number> {
  const [taxStartRaw, startRaw] = await Promise.all([
    optionalEthCall(rpcUrl, bondingPool, SELECTOR.taxStartTime),
    optionalEthCall(rpcUrl, bondingPool, SELECTOR.startTime),
  ]);
  const startedAt = selectPairStartTimestamp(
    parseOptionalHexBigInt(taxStartRaw),
    parseOptionalHexBigInt(startRaw),
  );
  if (!startedAt) throw new Error("Bonding pair does not expose a valid start time");
  return startedAt;
}

async function getLaunchInfoAtBlock(
  rpcUrl: string,
  launchContract: string,
  tokenAddress: string,
  launchBlock: number,
): Promise<LaunchInfo> {
  const logs = await rpc<RpcLog[]>(rpcUrl, "eth_getLogs", [{
    address: launchContract,
    topics: [LAUNCH_TOPIC, addressTopic(tokenAddress)],
    fromBlock: toHex(launchBlock),
    toBlock: toHex(launchBlock),
  }]);
  const launchLog = logs[0];
  if (!launchLog) throw new Error("Cached launch block does not contain the token launch event");
  return launchInfoFromLog(launchLog);
}

function launchInfoFromLog(log: RpcLog): LaunchInfo {
  const bondingPool = topicAddress(log.topics[2]);
  if (!bondingPool) throw new Error("Token launch event does not contain a bonding pool");
  return { blockNumber: parseHexNumber(log.blockNumber, "launch block"), bondingPool };
}

async function findBlockAtOrBefore(rpcUrl: string, timestamp: number, latestBlock: number, lowerBound = 0): Promise<number> {
  let low = lowerBound;
  let high = latestBlock;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const block = await rpc<RpcBlock>(rpcUrl, "eth_getBlockByNumber", [toHex(middle), false]);
    const blockTimestamp = parseHexNumber(block.timestamp, "block timestamp");
    if (blockTimestamp <= timestamp) low = middle;
    else high = middle - 1;
  }
  return low;
}

async function getLogsInRanges(
  rpcUrl: string,
  filter: { address: string; topics: Array<string | null> },
  fromBlock: number,
  toBlock: number,
): Promise<RpcLog[]> {
  const logs: RpcLog[] = [];
  if (fromBlock > toBlock) return logs;
  for (let start = fromBlock; start <= toBlock; start += LOG_BLOCK_RANGE) {
    const end = Math.min(toBlock, start + LOG_BLOCK_RANGE - 1);
    logs.push(...await rpc<RpcLog[]>(rpcUrl, "eth_getLogs", [{ ...filter, fromBlock: toHex(start), toBlock: toHex(end) }]));
  }
  return logs;
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
  const payload = await response.json() as RpcResponse<T>;
  if (payload.error) throw new Error(`${method} returned ${payload.error.code}: ${payload.error.message}`);
  if (payload.result === undefined || payload.result === null) throw new Error(`${method} returned no result`);
  return payload.result;
}

async function optionalEthCall(rpcUrl: string, to: string, data: string): Promise<string | undefined> {
  try {
    return await rpc<string>(rpcUrl, "eth_call", [{ to, data }, "latest"]);
  } catch {
    return undefined;
  }
}

function parseHexNumber(value: string, label: string): number {
  const parsed = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${label}`);
  return parsed;
}

function parseHexBigInt(value: string): bigint {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new Error("Invalid transfer amount");
  return BigInt(value);
}

function parseOptionalHexBigInt(value?: string): bigint | undefined {
  return value && /^0x[0-9a-fA-F]+$/.test(value) ? BigInt(value) : undefined;
}

function toHex(value: number): string { return `0x${value.toString(16)}`; }

function chunk<T>(values: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) batches.push(values.slice(index, index + size));
  return batches;
}
