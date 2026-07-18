import { createServer, type Server } from "node:http";
import type { SqliteStore } from "./store.js";
import { toBeijingIsoString } from "./time.js";

export function startHealthServer(port: number, store: SqliteStore): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (url.pathname !== "/health") {
      response.writeHead(404).end("Not found");
      return;
    }
    try {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, now: toBeijingIsoString(new Date()), ...store.stats() }));
    } catch (error) {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }).listen(port);
}
