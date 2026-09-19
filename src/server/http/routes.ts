// HTTP and websocket endpoints: authentication, projects, sessions, messages, and uploads.
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createReadStream } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RawData } from "ws";
import { forkSession, getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  EFFORT_LABELS,
  EFFORT_LEVELS,
  MODE_LABELS,
  PERMISSION_MODES,
  type ApiErrorBody,
  type ClientCommand,
  type PermissionMode,
} from "../../shared/protocol.js";
import type { RuntimeConfig } from "../infra/config.js";
import { isPathInside, redactSecrets } from "../infra/config.js";
import { createSessionToken, verifyPassword, verifySessionToken } from "../infra/auth.js";
import { AppDatabase, sessionDto, uploadDto } from "../data/db.js";
import { listProjects, projectDto } from "../data/projects.js";
import type { AgentManager } from "../session/agent-manager.js";
import { configuredModels } from "../session/models.js";
import { LoginRateLimiter } from "../infra/rate-limit.js";
import { normalizeTranscriptMessage } from "../session/messages.js";
import { MAX_FILE_BYTES, MAX_TURN_UPLOAD_BYTES, openUpload, saveUpload } from "../data/uploads.js";

const SESSION_COOKIE = "ccr_session";
const loginBody = z.object({ password: z.string().min(1).max(256) });
const projectBody = z.object({ path: z.string().min(1).max(4096) });
const createSessionBody = z.object({
  projectId: z.string().min(1).max(4096), model: z.string().min(1).max(256), permissionMode: z.enum(PERMISSION_MODES),
  effortLevel: z.enum(EFFORT_LEVELS).default("default"),
});
const forkBody = z.object({ messageId: z.string().min(1).max(128), title: z.string().max(120).optional() });
const wsCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), lastSeq: z.number().int().min(0).optional() }),
  z.object({ type: z.literal("send"), text: z.string().max(500_000), uploadIds: z.array(z.string().uuid()).max(20).optional() }),
  z.object({ type: z.literal("answer"), interactionId: z.string().uuid(), answers: z.record(z.string(), z.array(z.string()).max(16)) }),
  z.object({ type: z.literal("permission"), interactionId: z.string().uuid(), decision: z.enum(["allow", "deny"]), message: z.string().max(2_000).optional() }),
  z.object({ type: z.literal("set_mode"), mode: z.enum(PERMISSION_MODES) }),
  z.object({ type: z.literal("set_model"), model: z.string().min(1).max(256) }),
  z.object({ type: z.literal("set_effort"), effort: z.enum(EFFORT_LEVELS) }),
  z.object({ type: z.literal("interrupt") }),
]);

export interface RouteContext {
  config: RuntimeConfig;
  db: AppDatabase;
  agents: AgentManager;
  allowedOrigins: Set<string>;
}

// Register every authenticated REST endpoint and the live session websocket.
export async function registerRoutes(app: FastifyInstance, context: RouteContext): Promise<void> {
  const limiter = new LoginRateLimiter();

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/api/auth/status", async (request) => ({ authenticated: authenticated(request, context.config) }));

  app.post("/api/auth/login", async (request, reply) => {
    assertOrigin(request, context.allowedOrigins);
    const ip = request.ip;
    if (!limiter.allowed(ip)) return reply.code(429).send({ error: "Too many login attempts. Try again shortly." } satisfies ApiErrorBody);
    const body = loginBody.parse(request.body);
    if (!await verifyPassword(body.password, context.config.auth)) {
      limiter.fail(ip);
      return reply.code(401).send({ error: "Incorrect password" } satisfies ApiErrorBody);
    }
    limiter.clear(ip);
    reply.setCookie(SESSION_COOKIE, createSessionToken(context.config.auth), {
      path: "/", httpOnly: true, secure: false, sameSite: "strict", maxAge: 7 * 24 * 60 * 60,
    });
    return { ok: true };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    assertOrigin(request, context.allowedOrigins);
    reply.clearCookie(SESSION_COOKIE, { path: "/", secure: false, sameSite: "strict" });
    return { ok: true };
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/") || request.url.startsWith("/api/auth/")) return;
    if (!authenticated(request, context.config)) return reply.code(401).send({ error: "Log in first" } satisfies ApiErrorBody);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) assertOrigin(request, context.allowedOrigins);
  });

  app.get("/api/config", async () => ({
    models: await configuredModels(context.config.claudeConfigDir),
    modes: PERMISSION_MODES.map((value) => ({ value, label: MODE_LABELS[value] })),
    efforts: EFFORT_LEVELS.map((value) => ({ value, label: EFFORT_LABELS[value] })),
    maxFileBytes: MAX_FILE_BYTES,
    maxTurnUploadBytes: MAX_TURN_UPLOAD_BYTES,
    localHostname: context.config.localHostname,
  }));

  app.get("/api/projects", async () => listProjects(context.config.claudeConfigDir, context.db));

  app.post("/api/projects", async (request) => {
    const body = projectBody.parse(request.body);
    if (!isAbsolute(body.path)) throw new Error("Project path must be absolute");
    const path = await realpath(body.path);
    if (!(await stat(path)).isDirectory()) throw new Error("Selected path is not a directory");
    return projectDto(path, context.db.sessionStatsByProject().get(path)?.count ?? 0);
  });

  app.get("/api/fs", async (request) => {
    const query = z.object({ path: z.string().optional() }).parse(request.query);
    const requested = resolve(query.path || context.config.projectRoot);
    const path = await realpath(requested);
    if (!isPathInside(context.config.projectRoot, path)) throw new Error("Only the configured project root can be browsed");
    const entries: Array<{ name: string; path: string }> = [];
    const dir = await opendir(path);
    for await (const entry of dir) {
      if (!entry.isDirectory()) continue;
      entries.push({ name: entry.name, path: join(path, entry.name) });
      if (entries.length >= 500) break;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const parent = path === resolve(context.config.projectRoot) ? null : dirname(path);
    return { path, parent, entries };
  });

  app.get("/api/projects/:projectId/sessions", async (request) => {
    const params = z.object({ projectId: z.string().min(1).max(4096) }).parse(request.params);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(40), offset: z.coerce.number().int().min(0).default(0) })
      .parse(request.query);
    const models = await configuredModels(context.config.claudeConfigDir);
    const defaultModel = models[0];
    if (!defaultModel) throw new Error("No usable model in settings.json");
    const sdkSessions = await listSessions({ dir: params.projectId, limit: query.limit, offset: query.offset, includeWorktrees: false });
    for (const item of sdkSessions) {
      context.db.importSession({
        sdkSessionId: item.sessionId, projectId: params.projectId, title: item.customTitle || item.summary,
        summary: item.summary, model: defaultModel, gitBranch: item.gitBranch,
        createdAt: item.createdAt, updatedAt: item.lastModified,
      });
    }
    return context.db.listSessions(params.projectId, query.limit, query.offset);
  });

  app.post("/api/sessions", async (request) => {
    const body = createSessionBody.parse(request.body);
    const models = await configuredModels(context.config.claudeConfigDir);
    if (!models.includes(body.model)) throw new Error("Model is not in the settings.json allowlist");
    return sessionDto(context.db.createDraftSession(body.projectId, body.model, body.permissionMode, body.effortLevel));
  });

  app.get("/api/sessions/:sessionId", async (request) => {
    const params = sessionParams(request);
    const row = context.db.getSession(params.sessionId);
    if (!row) throw new Error("Session not found");
    return sessionDto(row);
  });

  app.get("/api/sessions/:sessionId/messages", async (request) => {
    const params = sessionParams(request);
    const queryParams = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).default(0) })
      .parse(request.query);
    const row = context.db.getSession(params.sessionId);
    if (!row) throw new Error("Session not found");
    if (!row.sdk_session_id) return { messages: [], hasMore: false, nextOffset: 0 };
    const messages = await getSessionMessages(row.sdk_session_id, { dir: row.project_id });
    const end = Math.max(0, messages.length - queryParams.offset);
    const start = Math.max(0, end - queryParams.limit);
    return {
      messages: messages.slice(start, end)
        .map((message) => normalizeTranscriptMessage(message, context.config.sensitiveValues)).filter(Boolean),
      hasMore: start > 0,
      nextOffset: queryParams.offset + (end - start),
    };
  });

  app.post("/api/sessions/:sessionId/fork", async (request) => {
    const params = sessionParams(request);
    const body = forkBody.parse(request.body);
    const row = context.db.getSession(params.sessionId);
    if (!row?.sdk_session_id) throw new Error("This session has no history to fork yet");
    const messages = await getSessionMessages(row.sdk_session_id, { dir: row.project_id });
    if (!messages.some((message) => message.uuid === body.messageId)) throw new Error("Fork message not found");
    const title = body.title?.trim() || `${row.title} (fork)`;
    const fork = await forkSession(row.sdk_session_id, { dir: row.project_id, upToMessageId: body.messageId, title });
    return sessionDto(context.db.insertFork({
      sdkSessionId: fork.sessionId, projectId: row.project_id, model: row.model,
      permissionMode: row.permission_mode, effortLevel: row.effort_level,
      parentSessionId: row.id, parentMessageId: body.messageId, title,
    }));
  });

  app.post("/api/sessions/:sessionId/uploads", async (request, reply) => {
    const params = sessionParams(request);
    if (!context.db.getSession(params.sessionId)) throw new Error("Session not found");
    const part = await request.file({ limits: { fileSize: MAX_FILE_BYTES, files: 1 } });
    if (!part) return reply.code(400).send({ error: "No file was received" } satisfies ApiErrorBody);
    const record = await saveUpload({ part, sessionId: params.sessionId, uploadRoot: context.config.uploadDir, db: context.db });
    return uploadDto(record);
  });

  app.get("/api/uploads/:uploadId", async (request, reply) => {
    const params = z.object({ uploadId: z.string().uuid() }).parse(request.params);
    const upload = context.db.getUpload(params.uploadId);
    if (!upload) return reply.code(404).send({ error: "Attachment not found" } satisfies ApiErrorBody);
    reply.type(upload.mime);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Disposition", `${upload.mime.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(upload.display_name)}`);
    return reply.send(await openUpload(upload));
  });

  app.get("/api/sessions/:sessionId/live", { websocket: true }, (socket, request) => {
    try {
      if (!authenticated(request, context.config)) throw new Error("Unauthorized");
      assertOrigin(request, context.allowedOrigins);
      const params = sessionParams(request);
      const query = z.object({ lastSeq: z.coerce.number().int().min(0).default(0) }).parse(request.query);
      const disconnect = context.agents.connect(params.sessionId, socket, query.lastSeq);
      socket.on("message", async (raw: RawData) => {
        try {
          const command = wsCommand.parse(JSON.parse(raw.toString())) as ClientCommand;
          await context.agents.command(params.sessionId, command);
        } catch (error) {
          socket.send(JSON.stringify({
            seq: 0, type: "command.error", sessionId: params.sessionId,
            payload: {
              message: redactSecrets(error instanceof Error ? error.message : String(error), context.config.sensitiveValues),
            }, timestamp: Date.now(),
          }));
        }
      });
      socket.on("close", disconnect);
      socket.on("error", disconnect);
    } catch {
      socket.close(1008, "Unauthorized");
    }
  });
}

// Check the session cookie against the configured signing secret.
function authenticated(request: FastifyRequest, config: RuntimeConfig): boolean {
  return verifySessionToken(request.cookies[SESSION_COOKIE], config.auth);
}

// Require the request's Origin header to match one of the trusted, allowed origins.
function assertOrigin(request: FastifyRequest, allowed: Set<string>): void {
  const origin = request.headers.origin;
  if (!origin || !allowed.has(origin)) throw new Error("Untrusted request origin");
}

// Parse and validate the sessionId path parameter.
function sessionParams(request: FastifyRequest): { sessionId: string } {
  return z.object({ sessionId: z.string().uuid() }).parse(request.params);
}
