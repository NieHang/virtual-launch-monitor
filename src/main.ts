import { env } from "./config.js";
import { ChainLaunchMonitor } from "./chain-monitor.js";
import { startHealthServer } from "./health.js";
import { LiveLaunchMonitor } from "./live-monitor.js";
import { logger } from "./logger.js";
import { SqliteStore } from "./store.js";
import { NotificationWorker, TelegramApi, TelegramBot } from "./telegram.js";

const store = new SqliteStore(env.SQLITE_PATH);
const telegramApi = env.TELEGRAM_BOT_TOKEN ? new TelegramApi(env.TELEGRAM_BOT_TOKEN) : undefined;
const telegramBot = telegramApi ? new TelegramBot(telegramApi, store) : undefined;
const notificationWorker = new NotificationWorker(store, telegramApi);
const liveMonitor = new LiveLaunchMonitor(store);
const chainMonitor = new ChainLaunchMonitor(store);
const healthServer = startHealthServer(env.PORT, store);

notificationWorker.start();
// The first latest-page fetch is a baseline only. It can never enqueue alerts.
await liveMonitor.start();
await chainMonitor.start();
telegramBot?.start();
logger.info("Virtual Launch Monitor ready", {
  storage: "sqlite",
  database: env.SQLITE_PATH,
  port: env.PORT,
  telegram: Boolean(telegramApi),
});

async function shutdown(signal: string): Promise<void> {
  logger.info("Shutting down", { signal });
  telegramBot?.stop();
  notificationWorker.stop();
  liveMonitor.stop();
  chainMonitor.stop();
  healthServer.close();
  store.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
