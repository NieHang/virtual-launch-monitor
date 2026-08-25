import { env } from "./config.js";
import type { TaxScanState } from "./store.js";
import type { LiveProject } from "./types.js";

const VIRTUAL_DECIMALS = 9;
const SIGNATURE_PAGE_SIZE = 1_000;
const MAX_SIGNATURE_PAGES = 20;

interface SolanaSignature {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

interface SolanaTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface SolanaTransaction {
  slot: number;
  transaction: {
    message: { accountKeys: Array<string | { pubkey: string; signer: boolean }> };
  };
  meta: {
    err: unknown;
    logMessages?: string[] | null;
    preTokenBalances?: SolanaTokenBalance[] | null;
    postTokenBalances?: SolanaTokenBalance[] | null;
  } | null;
}

interface SolanaRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

export interface SolanaTaxResult extends TaxScanState {
  taxAddress: string;
  taxRecipient: string;
  taxDecimals: number;
}

export async function scanSolanaTax(project: LiveProject, cached?: TaxScanState): Promise<SolanaTaxResult> {
  if (!project.preTokenPair) throw new Error("Virtuals API 未返回该 Solana 代币的 Bonding Pair，无法查税。");

  const startedAt = Math.floor(project.launchedAt.getTime() / 1_000);
  const windowEndsAt = startedAt + 98 * 60;
  const currentSlot = await solanaRpc<number>("getSlot", [{ commitment: "finalized" }]);
  const signatures: SolanaSignature[] = [];
  let before: string | undefined;
  let boundaryReached = false;

  for (let page = 0; page < MAX_SIGNATURE_PAGES; page += 1) {
    const options: { limit: number; before?: string } = { limit: SIGNATURE_PAGE_SIZE };
    if (before) options.before = before;
    const batch = await solanaRpc<SolanaSignature[]>("getSignaturesForAddress", [project.preTokenPair, options]);
    if (batch.length === 0) {
      boundaryReached = true;
      break;
    }
    for (const signature of batch) {
      if (cached && signature.slot <= cached.scannedToBlock) {
        boundaryReached = true;
        break;
      }
      if (signature.blockTime !== null && signature.blockTime < startedAt) {
        boundaryReached = true;
        break;
      }
      if (
        signature.err === null
        && signature.blockTime !== null
        && signature.blockTime <= windowEndsAt
      ) signatures.push(signature);
    }
    if (boundaryReached) break;
    before = batch.at(-1)?.signature;
    if (batch.length < SIGNATURE_PAGE_SIZE) {
      boundaryReached = true;
      break;
    }
  }
  if (!boundaryReached) throw new Error("Solana 税期交易过多，请配置归档 RPC 或稍后增量查询。");

  let taxWei = cached?.taxWei ?? 0n;
  let transactionCount = cached?.transactionCount ?? 0;
  for (const batch of chunk(signatures, 10)) {
    const transactions = await Promise.all(batch.map(({ signature }) => solanaRpc<SolanaTransaction | null>(
      "getTransaction",
      [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }],
      true,
    )));
    for (const transaction of transactions) {
      if (!transaction) continue;
      const amount = solanaClaimedVirtualUnits(
        transaction,
        env.SOL_TAX_EXECUTOR_ADDRESS,
        env.SOL_BUYBACK_ADDRESS,
        env.SOL_VIRTUAL_MINT,
      );
      if (amount <= 0n) continue;
      taxWei += amount;
      transactionCount += 1;
    }
  }

  const launchBlock = cached?.launchBlock
    ?? signatures.reduce((minimum, signature) => Math.min(minimum, signature.slot), currentSlot);
  return {
    launchBlock,
    scannedToBlock: currentSlot,
    taxWei,
    transactionCount,
    taxAddress: env.SOL_TAX_EXECUTOR_ADDRESS,
    taxRecipient: env.SOL_BUYBACK_ADDRESS,
    taxDecimals: VIRTUAL_DECIMALS,
  };
}

export function solanaClaimedVirtualUnits(
  transaction: SolanaTransaction,
  executorAddress: string,
  recipientAddress: string,
  virtualMint: string,
): bigint {
  if (!transaction.meta || transaction.meta.err !== null) return 0n;
  if (!transaction.meta.logMessages?.includes("Program log: Instruction: ClaimTradingFee")) return 0n;
  const executorSigned = transaction.transaction.message.accountKeys.some((account) => (
    typeof account === "string"
      ? false
      : account.pubkey === executorAddress && account.signer
  ));
  if (!executorSigned) return 0n;

  const amounts = new Map<number, bigint>();
  for (const balance of transaction.meta.preTokenBalances ?? []) {
    if (balance.owner === recipientAddress && balance.mint === virtualMint) {
      amounts.set(balance.accountIndex, -BigInt(balance.uiTokenAmount.amount));
    }
  }
  for (const balance of transaction.meta.postTokenBalances ?? []) {
    if (balance.owner === recipientAddress && balance.mint === virtualMint) {
      amounts.set(balance.accountIndex, (amounts.get(balance.accountIndex) ?? 0n) + BigInt(balance.uiTokenAmount.amount));
    }
  }
  const received = [...amounts.values()].reduce((total, amount) => total + amount, 0n);
  return received > 0n ? received : 0n;
}

async function solanaRpc<T>(method: string, params: unknown[], allowNull = false): Promise<T> {
  const response = await fetch(env.SOLANA_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
  const payload = await response.json() as SolanaRpcResponse<T>;
  if (payload.error) throw new Error(`${method} returned ${payload.error.code}: ${payload.error.message}`);
  if (payload.result === undefined || (!allowNull && payload.result === null)) throw new Error(`${method} returned no result`);
  return payload.result as T;
}

function chunk<T>(values: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) batches.push(values.slice(index, index + size));
  return batches;
}
