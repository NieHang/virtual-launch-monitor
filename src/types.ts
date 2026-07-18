export type ChainKey = "base" | "robinhood";

export interface TelegramUser {
  chatId: string;
  username?: string;
  enabled: boolean;
  chains: ChainKey[];
}

export interface LiveProject {
  virtualId: string;
  chainKey: ChainKey;
  tokenAddress: string;
  tokenName?: string;
  tokenSymbol?: string;
  preTokenPair?: string;
  lpAddress?: string;
  launchedAt: Date;
  projectTwitter?: string;
  projectTelegram?: string;
}

export interface AlertPayload {
  virtualId: string;
  chainKey: ChainKey;
  tokenAddress: string;
  tokenName?: string;
  tokenSymbol?: string;
  launchedAt: string;
  projectTwitter: string;
  projectTelegram?: string;
  explorer: string;
}

export interface OutboxItem {
  id: number;
  chatId: string;
  payload: AlertPayload;
  attempts: number;
}

export interface StoreStats {
  users: number;
  activeUsers: number;
  seenLaunches: number;
  pendingNotifications: number;
}
