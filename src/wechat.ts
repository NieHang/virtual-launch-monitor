import { logger } from "./logger.js";
import type { SqliteStore } from "./store.js";
import type { AlertPayload } from "./types.js";

interface WeComResponse {
  errcode?: number;
  errmsg?: string;
}

export class WeChatApi {
  constructor(
    private readonly webhookUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async sendAlert(payload: AlertPayload): Promise<void> {
    const response = await this.fetcher(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { content: formatWeChatAlert(payload) },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json().catch(() => undefined) as WeComResponse | undefined;
    if (!response.ok || result?.errcode !== 0) {
      throw new Error(result?.errmsg ?? `WeCom webhook returned ${response.status}`);
    }
  }
}

export class WeChatNotificationWorker {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly store: SqliteStore,
    private readonly api: WeChatApi,
    private readonly isProjectTwitterBlocked: (projectTwitter: string) => boolean = () => false,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 500);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    try {
      for (const item of this.store.claimWeChatOutbox(20)) {
        try {
          if (this.isProjectTwitterBlocked(item.payload.projectTwitter)) {
            logger.info("Queued WeChat notification discarded by X block list", {
              virtualId: item.payload.virtualId,
              projectTwitter: item.payload.projectTwitter,
            });
            this.store.markWeChatOutboxSent(item.id);
            continue;
          }
          await this.api.sendAlert(item.payload);
          this.store.markWeChatOutboxSent(item.id);
        } catch (error) {
          this.store.markWeChatOutboxFailed(item.id, error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      logger.error("WeChat notification worker failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function formatWeChatAlert(payload: AlertPayload): string {
  const officials = payload.frontrunAttention?.virtualOfficials ?? [];
  const title = payload.tokenSymbol
    ? `${payload.tokenName ?? payload.tokenSymbol} ($${payload.tokenSymbol})`
    : payload.tokenName ?? payload.tokenAddress;
  return [
    "## 🚨 V 官方人员关注项目",
    `> 官方关注：<font color=\"warning\">${officials.map((handle) => `@${handle}`).join("、")}</font>`,
    `> 网络：${payload.chainKey === "base" ? "Base" : "Robinhood Chain"}`,
    `> 项目：${title}`,
    `> 发射时间：${payload.launchedAt}`,
    `> 项目 X：[${payload.projectTwitter}](${payload.projectTwitter})`,
    `> Token：\`${payload.tokenAddress}\``,
    `[Virtuals 项目详情](https://app.virtuals.io/virtuals/${payload.virtualId})`,
    `[区块浏览器](${payload.explorer}/address/${payload.tokenAddress})`,
  ].join("\n");
}
