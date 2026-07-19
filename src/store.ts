import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AlertPayload, ChainKey, LiveProject, OutboxItem, StoreStats, TelegramUser, XAttentionResult } from "./types.js";
import { toBeijingIsoString } from "./time.js";

export class SqliteStore {
  private readonly db: DatabaseSync;

  constructor(path: string, allowedChatIds: ReadonlySet<string> = new Set()) {
    const filename = path === ":memory:" ? path : resolve(path);
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
    this.enforceTelegramWhitelist(allowedChatIds);
  }

  close(): void { this.db.close(); }

  upsertUser(input: Pick<TelegramUser, "chatId" | "username">): TelegramUser {
    this.db.prepare(`
      INSERT INTO telegram_users (chat_id, username) VALUES (?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        username = COALESCE(excluded.username, telegram_users.username),
        updated_at = unixepoch()
    `).run(input.chatId, input.username ?? null);
    return this.getUser(input.chatId)!;
  }

  getUser(chatId: string): TelegramUser | undefined {
    const row = this.db.prepare("SELECT * FROM telegram_users WHERE chat_id = ?").get(chatId) as UserRow | undefined;
    return row ? rowToUser(row) : undefined;
  }

  setUserEnabled(chatId: string, enabled: boolean): TelegramUser {
    this.db.prepare("UPDATE telegram_users SET enabled = ?, updated_at = unixepoch() WHERE chat_id = ?").run(enabled ? 1 : 0, chatId);
    return this.requireUser(chatId);
  }

  setUserChains(chatId: string, chains: ChainKey[]): TelegramUser {
    this.db.prepare("UPDATE telegram_users SET chains = ?, updated_at = unixepoch() WHERE chat_id = ?").run(JSON.stringify(chains), chatId);
    return this.requireUser(chatId);
  }

  baselineLaunch(project: LiveProject, now = new Date()): void {
    this.db.prepare(`
      INSERT INTO observed_launches (virtual_id, chain_key, launched_at, first_seen_at, qualified_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(virtual_id) DO UPDATE SET
        qualified_at = COALESCE(observed_launches.qualified_at, excluded.qualified_at)
    `).run(
      project.virtualId,
      project.chainKey,
      project.launchedAt.getTime(),
      now.getTime(),
      project.projectTwitter ? now.getTime() : null,
    );
  }

  registerLiveLaunch(project: LiveProject, now: Date, maxAgeMs: number): boolean {
    const existing = this.db.prepare("SELECT qualified_at FROM observed_launches WHERE virtual_id = ?").get(project.virtualId) as { qualified_at: number | null } | undefined;
    if (!existing) {
      this.db.prepare(`
        INSERT INTO observed_launches (virtual_id, chain_key, launched_at, first_seen_at, qualified_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(project.virtualId, project.chainKey, project.launchedAt.getTime(), now.getTime(), project.projectTwitter ? now.getTime() : null);
      return Boolean(project.projectTwitter) && isFresh(project, now, maxAgeMs);
    }
    if (existing.qualified_at === null && project.projectTwitter) {
      this.db.prepare("UPDATE observed_launches SET qualified_at = ? WHERE virtual_id = ?").run(now.getTime(), project.virtualId);
      return isFresh(project, now, maxAgeMs);
    }
    return false;
  }

  saveLaunchAttention(virtualId: string, result: XAttentionResult): void {
    this.db.prepare(`
      INSERT INTO launch_attention_checks (virtual_id, status, result, checked_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(virtual_id) DO NOTHING
    `).run(virtualId, result.status, JSON.stringify(result), new Date(result.checkedAt).getTime());
  }

  getLaunchAttention(virtualId: string): XAttentionResult | undefined {
    const row = this.db.prepare("SELECT result FROM launch_attention_checks WHERE virtual_id = ?").get(virtualId) as { result: string } | undefined;
    return row ? JSON.parse(row.result) as XAttentionResult : undefined;
  }

  enqueueForActiveUsers(project: LiveProject, xAttention?: XAttentionResult): number {
    if (!project.projectTwitter) return 0;
    const users = this.db.prepare("SELECT * FROM telegram_users WHERE enabled = 1").all() as unknown as UserRow[];
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO notification_outbox (chat_id, virtual_id, payload)
      VALUES (?, ?, ?)
    `);
    const payload: AlertPayload = {
      virtualId: project.virtualId,
      chainKey: project.chainKey,
      tokenAddress: project.tokenAddress,
      ...(project.tokenName ? { tokenName: project.tokenName } : {}),
      ...(project.tokenSymbol ? { tokenSymbol: project.tokenSymbol } : {}),
      launchedAt: toBeijingIsoString(project.launchedAt),
      projectTwitter: project.projectTwitter,
      ...(project.projectTelegram ? { projectTelegram: project.projectTelegram } : {}),
      explorer: project.chainKey === "base" ? "https://basescan.org" : "https://robinhoodchain.blockscout.com",
      ...(xAttention ? { xAttention } : {}),
    };
    let count = 0;
    for (const row of users) {
      const user = rowToUser(row);
      if (!user.chains.includes(project.chainKey)) continue;
      const result = insert.run(user.chatId, project.virtualId, JSON.stringify(payload));
      count += Number(result.changes);
    }
    return count;
  }

  claimOutbox(limit: number): OutboxItem[] {
    const rows = this.db.prepare(`
      SELECT id, chat_id, payload, attempts FROM notification_outbox
      WHERE status IN ('pending', 'failed') AND next_attempt_at <= ?
      ORDER BY id LIMIT ?
    `).all(Date.now(), limit) as unknown as OutboxRow[];
    const mark = this.db.prepare("UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ?");
    for (const row of rows) mark.run(row.id);
    return rows.map((row) => ({ id: row.id, chatId: row.chat_id, payload: JSON.parse(row.payload) as AlertPayload, attempts: row.attempts + 1 }));
  }

  markOutboxSent(id: number, telegramMessageId?: number): void {
    this.db.prepare("UPDATE notification_outbox SET status = 'sent', telegram_message_id = ?, sent_at = ? WHERE id = ?")
      .run(telegramMessageId ?? null, Date.now(), id);
  }

  markOutboxFailed(id: number, error: string): void {
    const row = this.db.prepare("SELECT attempts FROM notification_outbox WHERE id = ?").get(id) as { attempts: number } | undefined;
    const delayMs = Math.min(60_000, 2 ** Math.min(row?.attempts ?? 1, 6) * 1000);
    this.db.prepare("UPDATE notification_outbox SET status = 'failed', last_error = ?, next_attempt_at = ? WHERE id = ?")
      .run(error.slice(0, 2000), Date.now() + delayMs, id);
  }

  stats(): StoreStats {
    const row = this.db.prepare(`
      SELECT
        (SELECT count(*) FROM telegram_users) AS users,
        (SELECT count(*) FROM telegram_users WHERE enabled = 1) AS active_users,
        (SELECT count(*) FROM observed_launches) AS seen_launches,
        (SELECT count(*) FROM notification_outbox WHERE status IN ('pending', 'failed', 'sending')) AS pending_notifications
    `).get() as { users: number; active_users: number; seen_launches: number; pending_notifications: number };
    return { users: row.users, activeUsers: row.active_users, seenLaunches: row.seen_launches, pendingNotifications: row.pending_notifications };
  }

  getTaxScan(chainKey: ChainKey, tokenAddress: string): TaxScanState | undefined {
    const row = this.db.prepare(`
      SELECT launch_block, scanned_to_block, tax_wei, transaction_count
      FROM tax_scans WHERE chain_key = ? AND token_address = ? AND matcher_version = 4
    `).get(chainKey, tokenAddress.toLowerCase()) as TaxScanRow | undefined;
    return row ? {
      launchBlock: row.launch_block,
      scannedToBlock: row.scanned_to_block,
      taxWei: BigInt(row.tax_wei),
      transactionCount: row.transaction_count,
    } : undefined;
  }

  saveTaxScan(chainKey: ChainKey, tokenAddress: string, state: TaxScanState): void {
    this.db.prepare(`
      INSERT INTO tax_scans (chain_key, token_address, launch_block, scanned_to_block, tax_wei, transaction_count, matcher_version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 4, unixepoch())
      ON CONFLICT(chain_key, token_address) DO UPDATE SET
        launch_block = excluded.launch_block,
        scanned_to_block = excluded.scanned_to_block,
        tax_wei = excluded.tax_wei,
        transaction_count = excluded.transaction_count,
        matcher_version = 4,
        updated_at = unixepoch()
    `).run(
      chainKey,
      tokenAddress.toLowerCase(),
      state.launchBlock,
      state.scannedToBlock,
      state.taxWei.toString(),
      state.transactionCount,
    );
  }

  private requireUser(chatId: string): TelegramUser {
    const user = this.getUser(chatId);
    if (!user) throw new Error(`Telegram user ${chatId} is not registered`);
    return user;
  }

  private enforceTelegramWhitelist(allowedChatIds: ReadonlySet<string>): void {
    if (allowedChatIds.size === 0) return;
    const ids = [...allowedChatIds];
    const placeholders = ids.map(() => "?").join(", ");
    this.db.prepare(`
      UPDATE telegram_users
      SET enabled = 0, updated_at = unixepoch()
      WHERE chat_id NOT IN (${placeholders})
    `).run(...ids);
    this.db.prepare(`
      UPDATE notification_outbox
      SET status = 'discarded', last_error = 'Telegram user is outside the configured whitelist'
      WHERE status IN ('pending', 'failed', 'sending')
        AND chat_id NOT IN (${placeholders})
    `).run(...ids);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_users (
        chat_id TEXT PRIMARY KEY,
        username TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        chains TEXT NOT NULL DEFAULT '["base","robinhood"]',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS observed_launches (
        virtual_id TEXT PRIMARY KEY,
        chain_key TEXT NOT NULL,
        launched_at INTEGER NOT NULL,
        first_seen_at INTEGER NOT NULL,
        qualified_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS notification_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL REFERENCES telegram_users(chat_id) ON DELETE CASCADE,
        virtual_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        telegram_message_id INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        sent_at INTEGER,
        UNIQUE(chat_id, virtual_id)
      );
      CREATE TABLE IF NOT EXISTS launch_attention_checks (
        virtual_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        result TEXT NOT NULL,
        checked_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tax_scans (
        chain_key TEXT NOT NULL,
        token_address TEXT NOT NULL,
        launch_block INTEGER NOT NULL,
        scanned_to_block INTEGER NOT NULL,
        tax_wei TEXT NOT NULL,
        transaction_count INTEGER NOT NULL,
        matcher_version INTEGER NOT NULL DEFAULT 4,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY(chain_key, token_address)
      );
      UPDATE notification_outbox SET status = 'failed', next_attempt_at = 0 WHERE status = 'sending';
    `);
    const taxScanColumns = this.db.prepare("PRAGMA table_info(tax_scans)").all() as unknown as Array<{ name: string }>;
    if (!taxScanColumns.some((column) => column.name === "matcher_version")) {
      this.db.exec("ALTER TABLE tax_scans ADD COLUMN matcher_version INTEGER NOT NULL DEFAULT 1");
    }
  }
}

interface UserRow { chat_id: string; username: string | null; enabled: number; chains: string }
interface OutboxRow { id: number; chat_id: string; payload: string; attempts: number }
interface TaxScanRow { launch_block: number; scanned_to_block: number; tax_wei: string; transaction_count: number }
export interface TaxScanState { launchBlock: number; scannedToBlock: number; taxWei: bigint; transactionCount: number }

function rowToUser(row: UserRow): TelegramUser {
  return {
    chatId: row.chat_id,
    ...(row.username ? { username: row.username } : {}),
    enabled: row.enabled === 1,
    chains: JSON.parse(row.chains) as ChainKey[],
  };
}

function isFresh(project: LiveProject, now: Date, maxAgeMs: number): boolean {
  const ageMs = now.getTime() - project.launchedAt.getTime();
  return ageMs >= -60_000 && ageMs <= maxAgeMs;
}
