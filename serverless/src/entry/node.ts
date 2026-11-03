/**
 * Plain Node HTTP server, for local development or any host that runs a
 * long-lived process. Uses S3 when S3_BUCKET is set, else an in-memory store.
 */
import { createServer } from "node:http";
import { handle } from "../core/handler.ts";
import { logStoreFromEnv, s3StoreFromEnv } from "../store/s3.ts";
import { MemoryStore } from "../store/memory.ts";
import { buildId, config } from "../generated/config.ts";

const store = process.env["S3_BUCKET"] ? s3StoreFromEnv(process.env) : new MemoryStore();
const randomizationLog = process.env["S3_BUCKET"] ? (logStoreFromEnv(process.env) ?? undefined) : new MemoryStore();
const port = Number(process.env["PORT"] ?? 8787);

createServer(async (req, res) => {
  const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
    method: req.method ?? "GET",
  });
  const response = await handle(request, { store, config, buildId, log: console.log, logLevel: process.env["LOG_LEVEL"], randomizationLog, waitUntil: () => {} });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(req.method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
}).listen(port, () => {
  console.log(`study-roulette ${buildId} on http://localhost:${port} (${store instanceof MemoryStore ? "memory" : "S3"} store)`);
});
