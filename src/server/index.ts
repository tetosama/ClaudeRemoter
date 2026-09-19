// Server entry point: assembles Fastify, routes, the database, and the transcript watcher.
import { join, resolve } from "node:path";
import process from "node:process";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import middie from "@fastify/middie";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import chokidar from "chokidar";
import { AgentManager } from "./session/agent-manager.js";
import { loadRuntimeConfig, localIpAddresses, preferredLanHost, redactSecrets } from "./infra/config.js";
import { AppDatabase } from "./data/db.js";
import { registerRoutes } from "./http/routes.js";

process.umask(0o077);

const config = await loadRuntimeConfig();
const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    redact: ["req.headers.authorization", "req.headers.cookie", "password", "token", "apiKey"],
  },
  bodyLimit: 2 * 1024 * 1024,
});

app.addHook("onSend", async (request, reply, payload) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "no-referrer");
  if (request.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
  return payload;
});

await app.register(cookie);
await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
await app.register(multipart, {
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 4, parts: 5 },
});

const db = new AppDatabase(config.databasePath);
const agents = new AgentManager(config, db);
const allowedOrigins = new Set([
  `http://localhost:${config.port}`,
  `http://127.0.0.1:${config.port}`,
  `http://${config.localHostname}:${config.port}`,
  ...localIpAddresses().map((ip) => `http://${ip}:${config.port}`),
]);

app.setErrorHandler((error, request, reply) => {
  const failure = error instanceof Error ? error : new Error(String(error));
  const status = "statusCode" in failure && typeof failure.statusCode === "number" ? failure.statusCode : 400;
  request.log.warn({ err: { message: redactSecrets(failure.message, config.sensitiveValues), name: failure.name } }, "request failed");
  reply.code(status >= 400 && status < 600 ? status : 500).send({ error: redactSecrets(failure.message || "Request failed", config.sensitiveValues) });
});

await registerRoutes(app, { config, db, agents, allowedOrigins });

if (process.env.NODE_ENV === "production") {
  const webRoot = resolve(process.cwd(), "dist/web");
  await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  app.get("/*", async (_request, reply) => reply.sendFile("index.html"));
} else {
  await app.register(middie);
  const { createServer } = await import("vite");
  const vite = await createServer({
    configFile: resolve(process.cwd(), "vite.config.ts"),
    // Fastify owns websocket upgrades for the application protocol. Running
    // Vite's HMR socket on that same server makes both handlers accept the
    // upgrade and produces invalid websocket frames, so middleware mode uses
    // ordinary full-page refreshes during local development instead.
    server: { middlewareMode: true, hmr: false },
    appType: "spa",
  });
  app.use((request, response, next) => {
    const url = request.url || "";
    if (url === "/health" || url.startsWith("/api/")) return next();
    return vite.middlewares(request, response, next);
  });
  app.addHook("onClose", async () => vite.close());
}

let watcherTimer: NodeJS.Timeout | undefined;
const watcher = chokidar.watch(join(config.claudeConfigDir, "projects"), {
  ignoreInitial: true,
  depth: 2,
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
});
watcher.on("all", (_event, changedPath) => {
  if (watcherTimer) clearTimeout(watcherTimer);
  watcherTimer = setTimeout(() => agents.notifyExternalChange(changedPath), 500);
});

app.addHook("onClose", async () => {
  if (watcherTimer) clearTimeout(watcherTimer);
  await watcher.close();
  await agents.shutdown();
  db.close();
});

try {
  await app.listen({ host: config.host, port: config.port });
  const displayHost = preferredLanHost(config.localHostname, localIpAddresses());
  const appUrl = `http://${displayHost}:${config.port}`;
  app.log.info({ url: appUrl }, "Claude Remoter ready");
  process.stdout.write(`\nClaude Remoter started\nOpen: ${appUrl}\n\n`);
} catch (error) {
  await app.close().catch(() => undefined);
  throw error;
}
