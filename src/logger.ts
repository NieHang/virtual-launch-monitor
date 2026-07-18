import { toBeijingIsoString } from "./time.js";

type Level = "debug" | "info" | "warn" | "error";

const priorities: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const configured = (process.env.LOG_LEVEL ?? "info") as Level;

function emit(level: Level, message: string, data?: Record<string, unknown>): void {
  if (priorities[level] < (priorities[configured] ?? priorities.info)) return;
  const line = JSON.stringify({ time: toBeijingIsoString(new Date()), level, message, ...data });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, data?: Record<string, unknown>) => emit("debug", message, data),
  info: (message: string, data?: Record<string, unknown>) => emit("info", message, data),
  warn: (message: string, data?: Record<string, unknown>) => emit("warn", message, data),
  error: (message: string, data?: Record<string, unknown>) => emit("error", message, data),
};
