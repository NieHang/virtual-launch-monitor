import { setTimeout as delay } from "node:timers/promises";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { fetchUpcomingProjects, type UpcomingProject } from "./launch-radar.js";
import { logger } from "./logger.js";
import { formatVirtualFdv, type RealCostQueryService, type RealCostResult } from "./real-cost-query.js";
import type { SqliteStore } from "./store.js";
import { formatVirtual, type TaxQueryResult, type TaxQueryService } from "./tax-query.js";
import { toBeijingIsoString } from "./time.js";
import type { AlertPayload, ChainKey, TelegramUser } from "./types.js";

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
  parameters?: { retry_after?: number };
}
interface TelegramMessage { message_id: number; chat: { id: number }; text?: string; from?: { username?: string } }
interface TelegramCallbackQuery { id: string; from: { username?: string }; message?: TelegramMessage; data?: string }
interface TelegramUpdate { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery }
interface InlineKeyboardMarkup { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }

const telegramDispatcher = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY
  ? new EnvHttpProxyAgent()
  : undefined;

export class TelegramApi {
  constructor(private readonly token: string) {}

  async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await undiciFetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(method === "getUpdates" ? 60_000 : 10_000),
      ...(telegramDispatcher ? { dispatcher: telegramDispatcher } : {}),
    });
    const payload = await response.json() as TelegramResponse<T>;
    if (!response.ok || !payload.ok) {
      throw new TelegramApiError(
        payload.description ?? `Telegram ${method} failed: ${response.status}`,
        Math.max(0, payload.parameters?.retry_after ?? 0) * 1000,
      );
    }
    return payload.result;
  }

  sendMessage(chatId: string, text: string, replyMarkup?: InlineKeyboardMarkup): Promise<TelegramMessage> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  answerCallbackQuery(callbackQueryId: string, text: string): Promise<boolean> {
    return this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  }
}

export class TelegramBot {
  private running = false;
  private offset = 0;

  constructor(
    private readonly api: TelegramApi,
    private readonly store: SqliteStore,
    private readonly allowedChatIds: ReadonlySet<string> = new Set(),
    private readonly taxQueryService?: TaxQueryService,
    private readonly realCostQueryService?: RealCostQueryService,
  ) {}

  start(): void { this.running = true; void this.loop(); }
  stop(): void { this.running = false; }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.api.call<TelegramUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ["message", "callback_query"],
        });
        for (const update of updates) {
          this.offset = update.update_id + 1;
          if (update.message?.text) await this.handleMessage(update.message);
          if (update.callback_query) await this.handleCallbackQuery(update.callback_query);
        }
      } catch (error) {
        logger.error("Telegram polling failed", { error: error instanceof Error ? error.message : String(error) });
        await delay(error instanceof TelegramApiError && error.retryAfterMs > 0 ? error.retryAfterMs : 2000);
      }
    }
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);
    if (!isTelegramChatAllowed(chatId, this.allowedChatIds)) {
      logger.warn("Rejected Telegram user outside whitelist", { chatId, username: message.from?.username });
      await this.api.sendMessage(chatId, unauthorizedText(chatId));
      return;
    }
    const [rawCommand = "", ...args] = (message.text ?? "").trim().split(/\s+/);
    const command = rawCommand.split("@")[0]?.toLowerCase();
    this.store.upsertUser({ chatId, ...(message.from?.username ? { username: message.from.username } : {}) });
    try {
      if (command === "/start" || command === "/help") {
        await this.sendMenu(chatId);
      } else if (command === "/chains") {
        const user = this.store.setUserChains(chatId, normalizeChains(args));
        await this.api.sendMessage(chatId, `已订阅：${user.chains.join(", ")}。不会补发历史提醒。`, notificationKeyboard(user.enabled));
      } else if (command === "/pause") {
        const user = this.store.setUserEnabled(chatId, false);
        await this.api.sendMessage(chatId, "⏸ 通知已暂停。发送 /resume 或点击按钮可重新开启。", notificationKeyboard(user.enabled));
      } else if (command === "/resume") {
        const user = this.store.setUserEnabled(chatId, true);
        await this.api.sendMessage(chatId, enabledText(), notificationKeyboard(user.enabled));
      } else if (command === "/status") {
        await this.sendStatus(chatId);
      } else if (command === "/test") {
        await this.api.sendMessage(chatId, "✅ Telegram 通知测试成功。Virtuals Launch Monitor 已连接。");
      } else if (command === "/tax") {
        const tokenAddress = args[0];
        if (!tokenAddress) throw new Error("用法：/tax <代币CA>");
        if (!this.taxQueryService) throw new Error("查税服务未启用。");
        await this.api.sendMessage(chatId, "正在扫描链上税收记录，请稍候……");
        const result = await this.taxQueryService.query(tokenAddress);
        await this.api.sendMessage(chatId, formatTaxResult(result));
      } else if (command === "/efdv") {
        const tokenAddress = args[0];
        if (!tokenAddress) throw new Error("用法：/efdv <代币CA>");
        if (!this.realCostQueryService) throw new Error("真实成本查询服务未启用。");
        await this.api.sendMessage(chatId, "正在读取最新区块、税率配置和池储备，请稍候……");
        const result = await this.realCostQueryService.query(tokenAddress);
        await this.api.sendMessage(chatId, formatRealCostResult(result));
      } else if (command === "/threshold") {
        await this.api.sendMessage(chatId, "成交量阈值筛选已取消。现在只通知项目自身已认证 Twitter 的新发射项目。", notificationKeyboard(this.store.getUser(chatId)?.enabled ?? false));
      } else {
        await this.sendMenu(chatId);
      }
    } catch (error) {
      await this.api.sendMessage(chatId, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleCallbackQuery(callback: TelegramCallbackQuery): Promise<void> {
    if (!callback.message) {
      await this.api.answerCallbackQuery(callback.id, "无法识别当前会话，请发送 /start");
      return;
    }
    const chatId = String(callback.message.chat.id);
    if (!isTelegramChatAllowed(chatId, this.allowedChatIds)) {
      logger.warn("Rejected Telegram callback outside whitelist", { chatId, username: callback.from.username });
      await this.api.answerCallbackQuery(callback.id, "未授权使用此 Bot");
      await this.api.sendMessage(chatId, unauthorizedText(chatId));
      return;
    }
    this.store.upsertUser({ chatId, ...(callback.from.username ? { username: callback.from.username } : {}) });
    try {
      if (callback.data === "notifications:enable") {
        const user = this.store.setUserEnabled(chatId, true);
        await this.api.answerCallbackQuery(callback.id, "通知已开启");
        await this.api.sendMessage(chatId, enabledText(), notificationKeyboard(user.enabled));
      } else if (callback.data === "notifications:pause") {
        const user = this.store.setUserEnabled(chatId, false);
        await this.api.answerCallbackQuery(callback.id, "通知已暂停");
        await this.api.sendMessage(chatId, "⏸ 通知已暂停。", notificationKeyboard(user.enabled));
      } else if (callback.data === "launch-radar:query") {
        await this.api.answerCallbackQuery(callback.id, "正在查询 Upcoming 项目");
        try {
          await this.sendUpcomingProjects(chatId);
        } catch (error) {
          await this.api.sendMessage(chatId, `Launch Radar 查询失败：${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        await this.api.answerCallbackQuery(callback.id, "未知操作");
      }
    } catch (error) {
      await this.api.answerCallbackQuery(callback.id, (error instanceof Error ? error.message : String(error)).slice(0, 180));
    }
  }

  private async sendMenu(chatId: string): Promise<void> {
    const user = this.requireUser(chatId);
    await this.api.sendMessage(chatId, helpText(user), notificationKeyboard(user.enabled));
  }

  private async sendStatus(chatId: string): Promise<void> {
    const user = this.requireUser(chatId);
    await this.api.sendMessage(chatId, statusText(user), notificationKeyboard(user.enabled));
  }

  private async sendUpcomingProjects(chatId: string): Promise<void> {
    const projects = await fetchUpcomingProjects();
    if (!projects.length) {
      await this.api.sendMessage(chatId, "当前没有 Upcoming 项目。", notificationKeyboard(this.requireUser(chatId).enabled));
      return;
    }
    const blocks = projects.map(formatUpcomingProject);
    let text = `📡 Virtuals Upcoming 项目（${projects.length}）`;
    for (const block of blocks) {
      if (`${text}\n\n${block}`.length > 3800) {
        await this.api.sendMessage(chatId, text);
        text = block;
      } else {
        text += `\n\n${block}`;
      }
    }
    await this.api.sendMessage(chatId, text, notificationKeyboard(this.requireUser(chatId).enabled));
  }

  private requireUser(chatId: string): TelegramUser {
    const user = this.store.getUser(chatId);
    if (!user) throw new Error("用户尚未注册");
    return user;
  }
}

export class NotificationWorker {
  private timer?: NodeJS.Timeout;
  constructor(private readonly store: SqliteStore, private readonly api?: TelegramApi) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 500);
    this.timer.unref();
    void this.tick();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async tick(): Promise<void> {
    try {
      for (const item of this.store.claimOutbox(20)) {
        try {
          const text = formatAlert(item.payload);
          if (!this.api) {
            logger.info("Telegram disabled; notification emitted to log", { chatId: item.chatId, text });
            this.store.markOutboxSent(item.id);
            continue;
          }
          const message = await this.api.sendMessage(item.chatId, text);
          this.store.markOutboxSent(item.id, message.message_id);
        } catch (error) {
          this.store.markOutboxFailed(item.id, error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      logger.error("Notification worker failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export function formatAlert(payload: AlertPayload): string {
  const title = payload.tokenSymbol ? `${payload.tokenName ?? payload.tokenSymbol} ($${payload.tokenSymbol})` : payload.tokenName ?? payload.tokenAddress;
  return [
    "🔥 Virtuals 认证项目新币发射",
    `网络：${payload.chainKey === "base" ? "Base" : "Robinhood Chain"}`,
    `项目：${title}`,
    `发射时间：${payload.launchedAt}`,
    `项目认证 X：${payload.projectTwitter}`,
    ...(payload.projectTelegram ? [`项目认证 Telegram：${payload.projectTelegram}`] : []),
    `Token：${payload.tokenAddress}`,
    `项目详情：https://app.virtuals.io/virtuals/${payload.virtualId}`,
    `${payload.explorer}/address/${payload.tokenAddress}`,
  ].join("\n");
}

function enabledText(): string {
  return "🔔 通知已开启。只会推送开启之后新发射、且项目自身已认证 Twitter 的项目，不会补发历史代币。";
}

export function isTelegramChatAllowed(chatId: string, allowedChatIds: ReadonlySet<string>): boolean {
  return allowedChatIds.size === 0 || allowedChatIds.has(chatId);
}

function unauthorizedText(chatId: string): string {
  return `⛔ 你未被授权使用此 Bot。\n你的 Telegram Chat ID：${chatId}\n请联系管理员加入白名单。`;
}

function normalizeChains(args: string[]): ChainKey[] {
  const values = args.map((value) => value.toLowerCase());
  if (values.includes("all")) return ["base", "robinhood"];
  const chains = [...new Set(values.filter((value): value is ChainKey => value === "base" || value === "robinhood"))];
  if (!chains.length) throw new Error("用法：/chains base robinhood（或 /chains all）");
  return chains;
}

function statusText(user: TelegramUser): string {
  return `状态：${user.enabled ? "🔔 通知中" : "⏸ 已暂停"}\n自动筛选：新发射 + 项目自身已认证 Twitter\n网络：${user.chains.join(", ")}`;
}

function notificationKeyboard(enabled: boolean): InlineKeyboardMarkup {
  return { inline_keyboard: [
    [enabled
      ? { text: "⏸ 暂停通知", callback_data: "notifications:pause" }
      : { text: "🔔 开启通知", callback_data: "notifications:enable" }],
    [{ text: "🔎 查询 Upcoming", callback_data: "launch-radar:query" }],
  ] };
}

function helpText(user: TelegramUser): string {
  return [
    "Virtuals Launch Monitor",
    "",
    statusText(user),
    "",
    "/chains base robinhood - 设置订阅网络",
    "/status - 查看设置",
    "/tax <代币CA> - 查询累计反狙击税",
    "/efdv <代币CA> - 查询链上实时 FDV / 真实 eFDV",
    "/test - 发送连接测试通知",
    "/pause - 暂停通知",
    "/resume - 恢复通知",
  ].join("\n");
}

export function formatTaxResult(result: TaxQueryResult): string {
  const title = result.tokenSymbol
    ? `${result.tokenName ?? result.tokenSymbol} ($${result.tokenSymbol})`
    : result.tokenName ?? result.tokenAddress;
  return [
    "🧾 Virtuals 查税结果",
    `项目：${title}`,
    `网络：${result.chainKey === "base" ? "Base" : "Robinhood Chain"}`,
    `代币 CA：${result.tokenAddress}`,
    `累计反狙击税：${formatVirtual(result.taxWei)} VIRTUAL`,
    `税收交易数：${result.transactionCount}`,
    `税收地址：${result.taxAddress}`,
    `税期扫描区块：${result.launchBlock} - ${result.scannedToBlock}`,
  ].join("\n");
}

export function formatRealCostResult(result: RealCostResult): string {
  const title = result.tokenSymbol
    ? `${result.tokenName ?? result.tokenSymbol} ($${result.tokenSymbol})`
    : result.tokenName ?? result.tokenAddress;
  const fdv = formatVirtualFdv(result.fdvWei);
  const effectiveFdv = formatVirtualFdv(result.effectiveFdvWei);
  const usdFdv = result.virtualUsdPrice ? formatCompactUsd(result.fdvWei, result.virtualUsdPrice) : undefined;
  const usdEffectiveFdv = result.virtualUsdPrice ? formatCompactUsd(result.effectiveFdvWei, result.virtualUsdPrice) : undefined;
  const poolLabel = result.poolSource === "graduated" ? "毕业后 LP" : "Bonding Pair";
  const lines = [
    "📐 Virtuals 链上真实成本",
    `项目：${title}`,
    `网络：${result.chainKey === "base" ? "Base" : "Robinhood Chain"}`,
    `代币 CA：${result.tokenAddress}`,
    `当前 FDV：${fdv} VIRTUAL${usdFdv ? `（约 ${usdFdv}）` : ""}`,
  ];
  if (result.taxActive) {
    lines.push(
      `当前反狙击税：${result.antiSniperTaxPercent}%`,
      `当前总买入税：${result.totalBuyTaxPercent}%（基础 ${result.normalBuyTaxPercent}% + 反狙击 ${result.antiSniperTaxPercent}%）`,
      `真实 eFDV：${effectiveFdv} VIRTUAL${usdEffectiveFdv ? `（约 ${usdEffectiveFdv}）` : ""}`,
      `距离反狙击税结束：${formatDuration(result.remainingSeconds)}`,
    );
  } else {
    lines.push("反狙击税：已结束", "真实成本：当前 FDV（不再叠加反狙击税）");
  }
  lines.push(
    `价格来源：${poolLabel} 链上储备`,
    `税率来源：链上 type ${result.antiSniperType} / ${result.taxDurationSeconds}s 配置`,
    `查询区块：${result.blockNumber}`,
  );
  return lines.join("\n");
}

export function formatCompactUsd(wei: bigint, virtualUsdPrice: number): string {
  const usd = Number(wei) / 1e18 * virtualUsdPrice;
  const units = [
    { threshold: 1e9, suffix: "B" },
    { threshold: 1e6, suffix: "M" },
    { threshold: 1e3, suffix: "K" },
  ];
  const unit = units.find(({ threshold }) => usd >= threshold);
  if (!unit) {
    return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  }
  const compact = (usd / unit.threshold).toFixed(1).replace(/\.0$/, "");
  return `$${compact}${unit.suffix}`;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}分${remainder}秒` : `${remainder}秒`;
}

function formatUpcomingProject(project: UpcomingProject): string {
  const title = project.symbol ? `${project.name} ($${project.symbol})` : project.name;
  return [
    `项目：${title}`,
    `网络：${project.chainKey === "base" ? "Base" : "Robinhood Chain"}`,
    `计划发射：${toBeijingIsoString(project.launchedAt)}`,
    `项目详情：https://app.virtuals.io/virtuals/${project.virtualId}`,
  ].join("\n");
}

class TelegramApiError extends Error {
  constructor(message: string, readonly retryAfterMs: number) { super(message); }
}
