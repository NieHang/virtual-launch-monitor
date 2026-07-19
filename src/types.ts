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

export type XAttentionStatus = "matched" | "none" | "unknown";

export interface OfficialXFollower {
  userId: string;
  username: string;
  role: string;
}

export interface XAttentionResult {
  status: XAttentionStatus;
  projectUsername?: string;
  projectUserId?: string;
  followers: OfficialXFollower[];
  checkedAt: string;
  error?: string;
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
  xAttention?: XAttentionResult;
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
