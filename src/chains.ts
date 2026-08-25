import type { ChainKey, EvmChainKey } from "./types.js";

export const ALL_CHAINS: readonly ChainKey[] = ["base", "robinhood", "solana"];
export const EVM_CHAINS: readonly EvmChainKey[] = ["base", "robinhood"];

export function normalizeChain(value?: string): ChainKey | undefined {
  switch (value?.toUpperCase()) {
    case "BASE": return "base";
    case "ROBINHOOD": return "robinhood";
    case "SOL":
    case "SOLANA": return "solana";
    default: return undefined;
  }
}

export function chainDisplayName(chainKey: ChainKey): string {
  switch (chainKey) {
    case "base": return "Base";
    case "robinhood": return "Robinhood Chain";
    case "solana": return "Solana";
  }
}

export function explorerRoot(chainKey: ChainKey): string {
  switch (chainKey) {
    case "base": return "https://basescan.org";
    case "robinhood": return "https://robinhoodchain.blockscout.com";
    case "solana": return "https://solscan.io";
  }
}

export function tokenExplorerUrl(chainKey: ChainKey, tokenAddress: string): string {
  const resource = chainKey === "solana" ? "token" : "address";
  return `${explorerRoot(chainKey)}/${resource}/${tokenAddress}`;
}

export function isEvmChain(chainKey: ChainKey): chainKey is EvmChainKey {
  return chainKey !== "solana";
}

export function normalizeSolanaAddress(value: string): string | undefined {
  const trimmed = value.trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed) ? trimmed : undefined;
}
