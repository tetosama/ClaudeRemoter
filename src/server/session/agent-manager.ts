// Runs Claude agent turns for sessions, buffering and broadcasting events to websocket clients.
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { WebSocket } from "ws";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ClientCommand,
  EffortLevel,
  PermissionMode,
  QuestionDto,
  ServerEvent,
  ServerEventType,
} from "../../shared/protocol.js";
import type { RuntimeConfig } from "../infra/config.js";
import { redactSecrets } from "../infra/config.js";
import type { AppDatabase, SessionRecord, UploadRecord } from "../data/db.js";
import { sessionDto } from "../data/db.js";
import { IMAGE_MIMES, MAX_TURN_UPLOAD_BYTES } from "../data/uploads.js";
import { normalizeTranscriptMessage, sdkSessionId, streamDeltaFromSdkMessage } from "./messages.js";

const MAX_BUFFER_EVENTS = 2_000;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;

interface PendingInteraction {
  id: string;
  kind: "question" | "permission";
  input: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface LiveSession {
  seq: number;
  events: ServerEvent[];
  eventBytes: number;
  sockets: Set<WebSocket>;
  query: any | null;
  running: boolean;
  pending: Map<string, PendingInteraction>;
  interrupted: boolean;
  internalWriteUntil: number;
}

export class AgentManager {
  private readonly sessions = new Map<string, LiveSession>();
  private runningCount = 0;

  // Create the manager around the runtime configuration and shared database.
  constructor(private readonly config: RuntimeConfig, private readonly db: AppDatabase) {}

  // Attach a websocket to a session and replay any buffered events it missed.
  connect(sessionId: string, socket: WebSocket, lastSeq = 0): () => void {
    this.requireSession(sessionId);
    const live = this.live(sessionId);
    live.sockets.add(socket);
    for (const event of live.events) if (event.seq > lastSeq) safeSend(socket, event);
    safeSend(socket, this.ephemeralMetadata(sessionId, live));
    return () => live.sockets.delete(socket);
  }

  // Dispatch a client command to the matching session operation.
  async command(sessionId: string, command: ClientCommand): Promise<void> {
    switch (command.type) {
      case "hello":
        return;
      case "send":
        await this.send(sessionId, command.text, command.uploadIds || []);
        return;
      case "answer":
        this.answer(sessionId, command.interactionId, command.answers);
        return;
      case "permission":
        this.decidePermission(sessionId, command.interactionId, command.decision, command.message);
        return;
      case "set_mode":
        await this.setMode(sessionId, command.mode);
        return;
      case "set_model":
        await this.setModel(sessionId, command.model);
        return;
      case "set_effort":
        await this.setEffort(sessionId, command.effort);
        return;
      case "interrupt":
        await this.interrupt(sessionId);
        return;
    }
  }

  // Tell connected clients when the Claude CLI changes a transcript outside the app.
  notifyExternalChange(changedPath: string): void {
    if (!changedPath.endsWith(".jsonl")) return;
    const changedSdkId = basename(changedPath, ".jsonl");
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(changedSdkId)) return;
    const now = Date.now();
    let matched = false;
    for (const [sessionId, live] of this.sessions) {
      const row = this.db.getSession(sessionId);
      if (!row?.sdk_session_id || row.sdk_session_id !== changedSdkId) continue;
      matched = true;
      if (now <= live.internalWriteUntil) continue;
      this.emit(sessionId, "external.changed", { message: "The Claude CLI history was updated externally. Refresh to see the changes." });
    }
    if (!matched) {
      for (const sessionId of this.sessions.keys()) {
        this.emit(sessionId, "external.changed", { message: "The Claude CLI added new history. The session list was refreshed." });
      }
    }
  }

  // Interrupt every running session, used when the server shuts down.
  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.interrupt(id)));
  }

  // Run one agent turn: build the prompt, stream results, and update session state.
  private async send(sessionId: string, text: string, uploadIds: string[]): Promise<void> {
    const row = this.requireSession(sessionId);
    if (!(await isDirectory(row.project_id))) throw new Error("The project directory is currently unavailable");
    const live = this.live(sessionId);
    if (live.running) throw new Error("This session is already running. Wait for it or stop the current turn first");
    if (this.runningCount >= this.config.maxActiveSessions) throw new Error("Active session limit reached. Try again shortly");
    const uploads = this.db.getUploads(uploadIds, sessionId);
    if (uploads.length !== new Set(uploadIds).size) throw new Error("Some attachments do not exist or do not belong to this session");
    const totalBytes = uploads.reduce((sum, upload) => sum + upload.size, 0);
    if (totalBytes > MAX_TURN_UPLOAD_BYTES) throw new Error("Attachments for this turn exceed 100 MiB in total");
    if (!text.trim() && uploads.length === 0) throw new Error("Message cannot be empty");

    live.interrupted = false;
    live.running = true;
    this.runningCount += 1;
    this.db.updateSession(sessionId, {
      state: "running",
      title: row.state === "draft" && text.trim() ? summarizeTitle(text) : row.title,
      updatedAt: Date.now(),
    });
    this.emit(sessionId, "turn.started", { text, uploadIds });

    const options: Record<string, unknown> = {
      cwd: row.project_id,
      model: row.model,
      effort: row.effort_level === "default" ? undefined : row.effort_level,
      permissionMode: row.permission_mode,
      allowDangerouslySkipPermissions: true,
      pathToClaudeCodeExecutable: this.config.claudePath,
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      additionalDirectories: [...new Set(uploads
        .filter((upload) => !IMAGE_MIMES.has(upload.mime))
        .map((upload) => dirname(upload.storage_path)))],
      resume: row.sdk_session_id || undefined,
      canUseTool: (toolName: string, input: Record<string, unknown>, context: { signal?: AbortSignal } = {}) =>
        this.requestInteraction(sessionId, toolName, input, context.signal),
    };

    try {
      const prompt = await buildPrompt(text, uploads);
      if (live.interrupted) throw new Error("User interrupted the turn");
      const agentQuery = query({ prompt: prompt as any, options: options as any });
      live.query = agentQuery;
      let completedPayload: Record<string, unknown> = {};
      for await (const message of agentQuery) {
        live.internalWriteUntil = Date.now() + 3_000;
        const discoveredId = sdkSessionId(message);
        const current = this.db.getSession(sessionId)!;
        if (discoveredId && current.sdk_session_id !== discoveredId) {
          this.db.updateSession(sessionId, { sdkSessionId: discoveredId, state: "running", updatedAt: Date.now() });
          this.emit(sessionId, "session.metadata", sessionDto(this.db.getSession(sessionId)!));
        }
        const delta = streamDeltaFromSdkMessage(message);
        if (delta) this.emit(sessionId, "assistant.delta", { text: delta });
        this.forwardStructuredMessage(sessionId, message);
        if (isRecord(message) && message.type === "result") {
          completedPayload = {
            subtype: message.subtype,
            stopReason: message.stop_reason,
            durationMs: message.duration_ms,
            costUsd: message.total_cost_usd,
            isError: message.is_error,
          };
        }
      }
      if (live.interrupted) {
        this.db.updateSession(sessionId, { state: "interrupted", updatedAt: Date.now() });
        this.emit(sessionId, "turn.interrupted", {});
      } else {
        this.db.updateSession(sessionId, { state: "idle", updatedAt: Date.now() });
        this.emit(sessionId, "turn.completed", completedPayload);
      }
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error), this.config.sensitiveValues);
      const state = live.interrupted ? "interrupted" : "error";
      this.db.updateSession(sessionId, { state, updatedAt: Date.now() });
      this.emit(sessionId, live.interrupted ? "turn.interrupted" : "turn.failed", { message });
    } finally {
      for (const interaction of live.pending.values()) interaction.reject(new Error("Agent turn ended"));
      live.pending.clear();
      live.query = null;
      live.running = false;
      this.runningCount = Math.max(0, this.runningCount - 1);
      this.emit(sessionId, "session.metadata", sessionDto(this.db.getSession(sessionId)!));
    }
  }

  // Forward assistant, user, and tool blocks from the SDK as discrete events.
  private forwardStructuredMessage(sessionId: string, message: unknown): void {
    if (!isRecord(message)) return;
    if (message.type === "assistant" || message.type === "user") {
      const normalized = normalizeTranscriptMessage(message, this.config.sensitiveValues);
      if (!normalized) return;
      if (normalized.role === "assistant") this.emit(sessionId, "assistant.message", normalized);
      for (const block of normalized.blocks) {
        if (block.type === "tool_use") this.emit(sessionId, "tool.started", block);
        if (block.type === "tool_result") this.emit(sessionId, "tool.finished", block);
      }
    }
  }

  // Park a question or permission prompt and wait for the client to resolve it.
  private requestInteraction(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const live = this.live(sessionId);
    const id = randomUUID();
    const isQuestion = toolName === "AskUserQuestion";
    this.db.updateSession(sessionId, { state: "waiting", updatedAt: Date.now() });
    return new Promise((resolve, reject) => {
      const pending: PendingInteraction = { id, kind: isQuestion ? "question" : "permission", input, resolve, reject };
      live.pending.set(id, pending);
      if (isQuestion) {
        this.emit(sessionId, "interaction.question", {
          interactionId: id,
          questions: normalizeQuestions(input.questions),
        });
      } else {
        this.emit(sessionId, "interaction.permission", {
          interactionId: id,
          toolName,
          input,
        });
      }
      signal?.addEventListener("abort", () => {
        if (live.pending.delete(id)) reject(new Error("Interaction cancelled"));
      }, { once: true });
    }).finally(() => {
      live.pending.delete(id);
      if (live.query) this.db.updateSession(sessionId, { state: "running", updatedAt: Date.now() });
    });
  }

  // Resolve a pending question with the answers the client chose.
  private answer(sessionId: string, interactionId: string, answers: Record<string, string[]>): void {
    const pending = this.live(sessionId).pending.get(interactionId);
    if (!pending || pending.kind !== "question") throw new Error("This question is no longer pending");
    const questions = normalizeQuestions(pending.input.questions);
    const encoded: Record<string, string> = {};
    for (const question of questions) {
      const selected = answers[question.question]?.map((value) => value.trim()).filter(Boolean) || [];
      if (selected.length === 0) throw new Error(`Please answer: ${question.header}`);
      if (!question.multiSelect && selected.length > 1) throw new Error(`${question.header} allows only one selection`);
      encoded[question.question] = selected.join(", ");
    }
    pending.resolve({ behavior: "allow", updatedInput: { questions: pending.input.questions, answers: encoded } });
    this.emit(sessionId, "interaction.resolved", { interactionId });
  }

  // Resolve a pending permission request with an allow or deny decision.
  private decidePermission(
    sessionId: string,
    interactionId: string,
    decision: "allow" | "deny",
    message?: string,
  ): void {
    const pending = this.live(sessionId).pending.get(interactionId);
    if (!pending || pending.kind !== "permission") throw new Error("This permission request is no longer pending");
    if (decision === "allow") pending.resolve({ behavior: "allow", updatedInput: pending.input });
    else pending.resolve({ behavior: "deny", message: message?.trim() || "User rejected this action" });
    this.emit(sessionId, "interaction.resolved", { interactionId });
  }

  // Apply a new permission mode to the running query and persist it.
  private async setMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const row = this.requireSession(sessionId);
    const live = this.live(sessionId);
    if (live.query?.setPermissionMode) await live.query.setPermissionMode(mode);
    this.db.updateSession(row.id, { permissionMode: mode, updatedAt: Date.now() });
    this.emit(sessionId, "mode.changed", { mode });
    this.emit(sessionId, "session.metadata", sessionDto(this.db.getSession(sessionId)!));
  }

  // Switch the session model after checking it against the allowed list.
  private async setModel(sessionId: string, model: string): Promise<void> {
    const row = this.requireSession(sessionId);
    const allowed = await import("./models.js").then(({ configuredModels }) => configuredModels(this.config.claudeConfigDir));
    if (!allowed.includes(model)) throw new Error("Model is not in the settings.json allowlist");
    const live = this.live(sessionId);
    if (live.query?.setModel) await live.query.setModel(model);
    this.db.updateSession(row.id, { model, updatedAt: Date.now() });
    this.emit(sessionId, "session.metadata", sessionDto(this.db.getSession(sessionId)!));
  }

  // Apply a new reasoning effort level to the session and persist it.
  private async setEffort(sessionId: string, effort: EffortLevel): Promise<void> {
    const row = this.requireSession(sessionId);
    const live = this.live(sessionId);
    if (live.query?.applyFlagSettings) {
      await live.query.applyFlagSettings({ effortLevel: effort === "default" ? null : effort });
    }
    this.db.updateSession(row.id, { effortLevel: effort, updatedAt: Date.now() });
    this.emit(sessionId, "effort.changed", { effort });
    this.emit(sessionId, "session.metadata", sessionDto(this.db.getSession(sessionId)!));
  }

  // Stop the running turn and settle any pending interactions.
  private async interrupt(sessionId: string): Promise<void> {
    const live = this.sessions.get(sessionId);
    if (!live?.running) return;
    live.interrupted = true;
    for (const interaction of live.pending.values()) {
      interaction.resolve({ behavior: "deny", message: "User interrupted the turn" });
    }
    live.pending.clear();
    if (!live.query) return;
    try {
      if (live.query.interrupt) await live.query.interrupt();
      else if (live.query.close) live.query.close();
    } catch {
      // The query may already be exiting.
    }
  }

  // Return the session row or throw when it does not exist.
  private requireSession(sessionId: string): SessionRecord {
    const row = this.db.getSession(sessionId);
    if (!row) throw new Error("Session not found");
    return row;
  }

  // Return the in-memory state of a session, creating it on first use.
  private live(sessionId: string): LiveSession {
    let live = this.sessions.get(sessionId);
    if (!live) {
      live = {
        seq: 0, events: [], eventBytes: 0, sockets: new Set(), query: null, running: false,
        pending: new Map(), interrupted: false, internalWriteUntil: 0,
      };
      this.sessions.set(sessionId, live);
    }
    return live;
  }

  // Append an event to the bounded replay buffer and broadcast it to all sockets.
  private emit(sessionId: string, type: ServerEventType, payload: unknown): ServerEvent {
    const live = this.live(sessionId);
    const event: ServerEvent = { seq: ++live.seq, type, sessionId, payload, timestamp: Date.now() };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    live.events.push(event);
    live.eventBytes += bytes;
    while (live.events.length > MAX_BUFFER_EVENTS || live.eventBytes > MAX_BUFFER_BYTES) {
      const removed = live.events.shift();
      if (!removed) break;
      live.eventBytes -= Buffer.byteLength(JSON.stringify(removed));
    }
    for (const socket of live.sockets) safeSend(socket, event);
    return event;
  }

  // Build the current session metadata event without adding it to the buffer.
  private ephemeralMetadata(sessionId: string, live: LiveSession): ServerEvent {
    return {
      seq: live.seq,
      type: "session.metadata",
      sessionId,
      payload: sessionDto(this.requireSession(sessionId)),
      timestamp: Date.now(),
    };
  }
}

// Build the SDK prompt: the message text, inline images, and paths of attached files.
async function buildPrompt(text: string, uploads: UploadRecord[]): Promise<AsyncIterable<SDKUserMessage>> {
  const images = uploads.filter((upload) => IMAGE_MIMES.has(upload.mime));
  const files = uploads.filter((upload) => !IMAGE_MIMES.has(upload.mime));
  const attachmentText = files.length
    ? `\n\nAttached files available on this computer:\n${files.map((file) => `- ${file.display_name}: ${file.storage_path}`).join("\n")}`
    : "";
  const blocks: Array<Record<string, unknown>> = [];
  if (text || attachmentText) blocks.push({ type: "text", text: `${text}${attachmentText}` });
  for (const image of images) {
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: image.mime, data: (await readFile(image.storage_path)).toString("base64") },
    });
  }
  return (async function* (): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: blocks as any },
    };
  })();
}

// Coerce raw question input into a bounded list of question DTOs.
function normalizeQuestions(value: unknown): QuestionDto[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).slice(0, 4).map((question) => ({
    question: String(question.question || ""),
    header: String(question.header || "Question").slice(0, 24),
    multiSelect: question.multiSelect === true,
    options: Array.isArray(question.options) ? question.options.filter(isRecord).slice(0, 8).map((option) => ({
      label: String(option.label || ""), description: String(option.description || ""),
    })) : [],
  }));
}

// Derive a one-line session title from the first message text.
function summarizeTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine || "New session";
}

// Serialize an event to a socket, ignoring sockets that are closed or failing.
function safeSend(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(value));
  } catch {
    // Socket cleanup is handled by the close event.
  }
}

// Check that a value is a plain, non-array object.
function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Check whether a path currently resolves to a directory.
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
