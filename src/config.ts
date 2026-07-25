import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  SQLITE_PATH: z.string().default("./data/monitor.sqlite"),
  TELEGRAM_BOT_TOKEN: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()),
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().default("").transform((value, context) => {
    const chatIds = value.split(/[\s,]+/).filter(Boolean);
    const invalid = chatIds.find((chatId) => !/^-?\d+$/.test(chatId));
    if (invalid) {
      context.addIssue({ code: "custom", message: `Invalid Telegram chat ID: ${invalid}` });
      return z.NEVER;
    }
    return [...new Set(chatIds)];
  }),
  WECOM_WEBHOOK_URL: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().url().optional(),
  ),
  FrontRunKey: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()),
  XBlockList: z.string().default("").transform((value) => (
    [...new Set(value.split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean))]
  )),
  BASE_RPC_URL: z.string().url().default("https://mainnet.base.org"),
  ROBINHOOD_RPC_URL: z.string().url().default("https://rpc.mainnet.chain.robinhood.com"),
  CHAIN_POLL_MS: z.coerce.number().int().min(500).default(1000),
  OFFICIAL_API_POLL_MS: z.coerce.number().int().min(3000).default(5000),
  LIVE_LAUNCH_MAX_AGE_MS: z.coerce.number().int().min(30_000).default(5 * 60_000),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const env = envSchema.parse(process.env);
