import { env } from "./config.js";
import { fetchLaunchByToken } from "./live-monitor.js";
import type { ChainKey, LiveProject } from "./types.js";

const SELECTOR = {
  totalSupply: "0x18160ddd",
  getReserves: "0x0902f1ac",
  token0: "0x0dfe1681",
  token1: "0xd21220a7",
  startTime: "0x78e97925",
  taxStartTime: "0x70e6e182",
  tokenAntiSniperType: "0x3aa012b4",
  bondingConfig: "0x83719f88",
  router: "0xf887ea40",
  factory: "0xc45a0155",
  getAntiSniperDuration: "0x77c8de5b",
  antiSniperBuyTaxStartValue: "0xb4979365",
  buyTax: "0x4f7041a5",
} as const;

const chains: Record<ChainKey, { rpcUrl: string; virtualToken: string; bondingV5: string }> = {
  base: {
    rpcUrl: env.BASE_RPC_URL,
    virtualToken: "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b",
    bondingV5: "0x1a540088125d00dd3990f9da45ca0859af4d3b01",
  },
  robinhood: {
    rpcUrl: env.ROBINHOOD_RPC_URL,
    virtualToken: "0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31",
    bondingV5: "0xd4ccbfa37e2f35611b3042e4096ad7a3459bd007",
  },
};

interface RpcBlock { number: string; timestamp: string }
interface RpcResponse<T> { result?: T; error?: { code: number; message: string } }
interface PoolSnapshot { poolAddress: string; source: "bonding" | "graduated"; tokenReserve: bigint; virtualReserve: bigint }

export interface RealCostResult {
  chainKey: ChainKey;
  tokenAddress: string;
  tokenName?: string;
  tokenSymbol?: string;
  blockNumber: number;
  blockTimestamp: number;
  poolAddress: string;
  poolSource: "bonding" | "graduated";
  fdvWei: bigint;
  effectiveFdvWei: bigint;
  virtualUsdPrice?: number;
  antiSniperType: number;
  antiSniperTaxPercent: number;
  normalBuyTaxPercent: number;
  totalBuyTaxPercent: number;
  taxDurationSeconds: number;
  taxStartTime: number;
  remainingSeconds: number;
  taxActive: boolean;
}

export class RealCostQueryService {
  async query(rawTokenAddress: string): Promise<RealCostResult> {
    const tokenAddress = normalizeAddress(rawTokenAddress);
    if (!tokenAddress) throw new Error("代币 CA 格式错误，请输入 0x 开头的 40 位十六进制地址。");

    const project = await fetchLaunchByToken(tokenAddress);
    if (!project) throw new Error("未在 Virtuals 中找到这个代币 CA。");
    if (!project.preTokenPair) throw new Error("Virtuals API 未返回该代币的 Bonding Pair，暂时无法读取链上实时成本。");

    const chain = chains[project.chainKey];
    const [latestBlock, totalSupplyRaw, startTimeRaw, taxStartTimeRaw, antiSniperTypeRaw, configRaw, routerRaw, pool] = await Promise.all([
      rpc<RpcBlock>(chain.rpcUrl, "eth_getBlockByNumber", ["latest", false]),
      ethCall(chain.rpcUrl, tokenAddress, SELECTOR.totalSupply),
      ethCall(chain.rpcUrl, project.preTokenPair, SELECTOR.startTime),
      optionalEthCall(chain.rpcUrl, project.preTokenPair, SELECTOR.taxStartTime),
      ethCall(chain.rpcUrl, chain.bondingV5, encodeAddressCall(SELECTOR.tokenAntiSniperType, tokenAddress)),
      ethCall(chain.rpcUrl, chain.bondingV5, SELECTOR.bondingConfig),
      ethCall(chain.rpcUrl, chain.bondingV5, SELECTOR.router),
      readCurrentPool(chain.rpcUrl, project, tokenAddress, chain.virtualToken),
    ]);

    const antiSniperType = toSafeNumber(decodeUint(antiSniperTypeRaw), "anti-sniper type");
    const configAddress = decodeAddress(configRaw);
    const routerAddress = decodeAddress(routerRaw);
    const factoryAddress = decodeAddress(await ethCall(chain.rpcUrl, routerAddress, SELECTOR.factory));
    const [durationRaw, startTaxRaw, normalBuyTaxRaw, virtualUsdPrice] = await Promise.all([
      ethCall(chain.rpcUrl, configAddress, encodeUintCall(SELECTOR.getAntiSniperDuration, BigInt(antiSniperType))),
      ethCall(chain.rpcUrl, factoryAddress, SELECTOR.antiSniperBuyTaxStartValue),
      ethCall(chain.rpcUrl, factoryAddress, SELECTOR.buyTax),
      fetchVirtualUsdPrice(),
    ]);

    const blockTimestamp = toSafeNumber(decodeUint(latestBlock.timestamp), "block timestamp");
    const taxStartTime = toSafeNumber(decodeUint(taxStartTimeRaw ?? startTimeRaw), "tax start time");
    const taxDurationSeconds = toSafeNumber(decodeUint(durationRaw), "anti-sniper duration");
    const startTaxPercent = toSafeNumber(decodeUint(startTaxRaw), "anti-sniper start tax");
    const normalBuyTaxPercent = toSafeNumber(decodeUint(normalBuyTaxRaw), "normal buy tax");
    const configuredAntiSniperTaxPercent = calculateAntiSniperTaxPercent(
      startTaxPercent,
      taxDurationSeconds,
      taxStartTime,
      blockTimestamp,
    );
    // Anti-sniper tax is charged by FRouterV3 while the token trades on the
    // bonding pair. Graduated LP swaps bypass that router and only retain the
    // normal trading tax.
    const antiSniperTaxPercent = pool.source === "bonding" ? configuredAntiSniperTaxPercent : 0;
    const totalBuyTaxPercent = Math.min(99, normalBuyTaxPercent + antiSniperTaxPercent);
    const taxActive = antiSniperTaxPercent > 0;
    const totalSupply = decodeUint(totalSupplyRaw);
    const fdvWei = calculateFdvWei(totalSupply, pool.tokenReserve, pool.virtualReserve);
    const effectiveFdvWei = taxActive
      ? calculateEffectiveFdvWei(fdvWei, totalBuyTaxPercent)
      : fdvWei;

    return {
      chainKey: project.chainKey,
      tokenAddress,
      ...(project.tokenName ? { tokenName: project.tokenName } : {}),
      ...(project.tokenSymbol ? { tokenSymbol: project.tokenSymbol } : {}),
      blockNumber: toSafeNumber(decodeUint(latestBlock.number), "block number"),
      blockTimestamp,
      poolAddress: pool.poolAddress,
      poolSource: pool.source,
      fdvWei,
      effectiveFdvWei,
      ...(virtualUsdPrice ? { virtualUsdPrice } : {}),
      antiSniperType,
      antiSniperTaxPercent,
      normalBuyTaxPercent,
      totalBuyTaxPercent,
      taxDurationSeconds,
      taxStartTime,
      remainingSeconds: taxActive ? Math.max(0, taxStartTime + taxDurationSeconds - blockTimestamp) : 0,
      taxActive,
    };
  }
}

export function calculateAntiSniperTaxPercent(
  startTaxPercent: number,
  durationSeconds: number,
  taxStartTime: number,
  currentTimestamp: number,
): number {
  if (durationSeconds <= 0) return 0;
  if (currentTimestamp < taxStartTime) return startTaxPercent;
  const elapsed = currentTimestamp - taxStartTime;
  if (elapsed >= durationSeconds) return 0;
  return Math.floor(startTaxPercent * (durationSeconds - elapsed) / durationSeconds);
}

export function calculateFdvWei(totalSupply: bigint, tokenReserve: bigint, virtualReserve: bigint): bigint {
  if (totalSupply <= 0n || tokenReserve <= 0n || virtualReserve <= 0n) throw new Error("池储备或代币总供应量无效。");
  return totalSupply * virtualReserve / tokenReserve;
}

export function calculateEffectiveFdvWei(fdvWei: bigint, totalBuyTaxPercent: number): bigint {
  if (!Number.isInteger(totalBuyTaxPercent) || totalBuyTaxPercent < 0 || totalBuyTaxPercent >= 100) {
    throw new Error("买入税率无效。");
  }
  return fdvWei * 100n / BigInt(100 - totalBuyTaxPercent);
}

export function formatVirtualFdv(wei: bigint, maximumFractionDigits = 2): string {
  const scale = 10n ** 18n;
  const factor = 10n ** BigInt(maximumFractionDigits);
  const rounded = (wei * factor + scale / 2n) / scale;
  const whole = rounded / factor;
  const fraction = (rounded % factor).toString().padStart(maximumFractionDigits, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

async function readCurrentPool(
  rpcUrl: string,
  project: LiveProject,
  tokenAddress: string,
  virtualToken: string,
): Promise<PoolSnapshot> {
  if (project.lpAddress) {
    try {
      const [token0Raw, token1Raw, reservesRaw] = await Promise.all([
        ethCall(rpcUrl, project.lpAddress, SELECTOR.token0),
        ethCall(rpcUrl, project.lpAddress, SELECTOR.token1),
        ethCall(rpcUrl, project.lpAddress, SELECTOR.getReserves),
      ]);
      const token0 = decodeAddress(token0Raw);
      const token1 = decodeAddress(token1Raw);
      const reserves = decodeWords(reservesRaw, 2);
      const reserve0 = reserves[0]!;
      const reserve1 = reserves[1]!;
      if (token0 === tokenAddress && token1 === virtualToken && reserve0 > 0n && reserve1 > 0n) {
        return { poolAddress: project.lpAddress, source: "graduated", tokenReserve: reserve0, virtualReserve: reserve1 };
      }
      if (token1 === tokenAddress && token0 === virtualToken && reserve0 > 0n && reserve1 > 0n) {
        return { poolAddress: project.lpAddress, source: "graduated", tokenReserve: reserve1, virtualReserve: reserve0 };
      }
    } catch {
      // The official API can expose an LP before it has usable reserves. Fall back to the live bonding pair.
    }
  }

  const reserves = decodeWords(
    await ethCall(rpcUrl, project.preTokenPair!, SELECTOR.getReserves),
    2,
  );
  const tokenReserve = reserves[0]!;
  const virtualReserve = reserves[1]!;
  return { poolAddress: project.preTokenPair!, source: "bonding", tokenReserve, virtualReserve };
}

async function fetchVirtualUsdPrice(): Promise<number | undefined> {
  try {
    const response = await fetch("https://api2.virtuals.io/api/dex/prices", {
      headers: { accept: "application/json, text/plain, */*", "cache-control": "no-cache" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { data?: { BASE?: { virtual?: number } } };
    const price = payload.data?.BASE?.virtual;
    return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : undefined;
  } catch {
    return undefined;
  }
}

async function ethCall(rpcUrl: string, to: string, data: string): Promise<string> {
  return rpc<string>(rpcUrl, "eth_call", [{ to, data }, "latest"]);
}

async function optionalEthCall(rpcUrl: string, to: string, data: string): Promise<string | undefined> {
  try { return await ethCall(rpcUrl, to, data); } catch { return undefined; }
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

function normalizeAddress(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : undefined;
}

function encodeAddressCall(selector: string, address: string): string {
  return `${selector}${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function encodeUintCall(selector: string, value: bigint): string {
  return `${selector}${value.toString(16).padStart(64, "0")}`;
}

function decodeAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("链上地址返回值无效。");
  return `0x${value.slice(-40).toLowerCase()}`;
}

function decodeUint(value: string): bigint {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new Error("链上整数返回值无效。");
  return BigInt(value);
}

function decodeWords(value: string, count: number): bigint[] {
  if (!/^0x(?:[0-9a-fA-F]{64})+$/.test(value)) throw new Error("链上储备返回值无效。");
  const body = value.slice(2);
  if (body.length < count * 64) throw new Error("链上储备返回值长度不足。");
  return Array.from({ length: count }, (_, index) => BigInt(`0x${body.slice(index * 64, (index + 1) * 64)}`));
}

function toSafeNumber(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid ${label}`);
  return number;
}
