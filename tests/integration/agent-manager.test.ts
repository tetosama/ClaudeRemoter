import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  scenario: "success" as "success" | "question" | "permission" | "blocking" | "error",
  lastPermissionResult: null as any,
  calls: [] as Array<{ resume?: string; effort?: string; streaming: boolean }>,
  controls: null as null | {
    interrupt: ReturnType<typeof vi.fn>;
    setPermissionMode: ReturnType<typeof vi.fn>;
    setModel: ReturnType<typeof vi.fn>;
    applyFlagSettings: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: any) => {
    mockState.calls.push({ resume: options.resume, effort: options.effort, streaming: Boolean(prompt?.[Symbol.asyncIterator]) });
    let interrupted = false;
    const generator = (async function* () {
      yield { type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111" };
      if (mockState.scenario === "question") {
        mockState.lastPermissionResult = await options.canUseTool("AskUserQuestion", {
          questions: [{ question: "Which mode?", header: "Mode", multiSelect: true, options: [
            { label: "Fast", description: "Quick" }, { label: "Safe", description: "Careful" },
          ] }],
        }, {});
      }
      if (mockState.scenario === "permission") {
        mockState.lastPermissionResult = await options.canUseTool("Bash", { command: "pwd" }, {});
      }
      if (mockState.scenario === "blocking") {
        while (!interrupted) await new Promise((resolve) => setTimeout(resolve, 5));
        return;
      }
      if (mockState.scenario === "error") throw new Error("gateway https://secret-gateway.local failed");
      yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } } };
      yield { type: "assistant", uuid: "message-1", session_id: "11111111-1111-4111-8111-111111111111", message: {
        role: "assistant", content: [{ type: "text", text: "hello" }],
      } };
      yield { type: "result", subtype: "success", session_id: "11111111-1111-4111-8111-111111111111", is_error: false };
    })();
    const controls = {
      interrupt: vi.fn(async () => { interrupted = true; }),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      applyFlagSettings: vi.fn(async () => undefined),
    };
    mockState.controls = controls;
    return Object.assign(generator, { ...controls, close: vi.fn(() => { interrupted = true; }) });
  },
}));

import { AgentManager } from "../../src/server/session/agent-manager.js";
import { AppDatabase } from "../../src/server/data/db.js";
import type { RuntimeConfig } from "../../src/server/infra/config.js";

describe("AgentManager with a fake Claude SDK transport", () => {
  beforeEach(() => {
    mockState.scenario = "success";
    mockState.lastPermissionResult = null;
    mockState.calls = [];
    mockState.controls = null;
  });

  it("creates, streams and persists a resumable SDK session", async () => {
    const fixture = await createFixture();
    await fixture.manager.command(fixture.sessionId, { type: "send", text: "hello" });
    await fixture.manager.command(fixture.sessionId, { type: "send", text: "continue" });
    const session = fixture.db.getSession(fixture.sessionId)!;
    expect(session.sdk_session_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(session.state).toBe("idle");
    expect(fixture.frames.some((frame) => frame.type === "assistant.delta")).toBe(true);
    expect(fixture.frames.some((frame) => frame.type === "turn.completed")).toBe(true);
    expect(mockState.calls.every((call) => call.streaming)).toBe(true);
    expect(mockState.calls[1].resume).toBe(session.sdk_session_id);
    fixture.db.close();
  });

  it("pauses for a multi-select answer and returns comma-separated labels", async () => {
    mockState.scenario = "question";
    const fixture = await createFixture();
    const running = fixture.manager.command(fixture.sessionId, { type: "send", text: "ask me" });
    const event = await waitForFrame(fixture.frames, "interaction.question");
    await fixture.manager.command(fixture.sessionId, {
      type: "answer", interactionId: event.payload.interactionId,
      answers: { "Which mode?": ["Fast", "Safe"] },
    });
    await running;
    expect(mockState.lastPermissionResult.updatedInput.answers).toEqual({ "Which mode?": "Fast, Safe" });
    fixture.db.close();
  });

  it("forwards a normal tool approval and resumes the turn", async () => {
    mockState.scenario = "permission";
    const fixture = await createFixture();
    const running = fixture.manager.command(fixture.sessionId, { type: "send", text: "run pwd" });
    const event = await waitForFrame(fixture.frames, "interaction.permission");
    await fixture.manager.command(fixture.sessionId, {
      type: "permission", interactionId: event.payload.interactionId, decision: "allow",
    });
    await running;
    expect(mockState.lastPermissionResult).toMatchObject({ behavior: "allow", updatedInput: { command: "pwd" } });
    fixture.db.close();
  });

  it("switches mode through the live SDK control channel and can stop a turn", async () => {
    mockState.scenario = "blocking";
    const fixture = await createFixture();
    const running = fixture.manager.command(fixture.sessionId, { type: "send", text: "keep working" });
    await waitFor(() => mockState.controls !== null);
    await fixture.manager.command(fixture.sessionId, { type: "set_mode", mode: "plan" });
    expect(mockState.controls?.setPermissionMode).toHaveBeenCalledWith("plan");
    expect(fixture.db.getSession(fixture.sessionId)?.permission_mode).toBe("plan");
    await fixture.manager.command(fixture.sessionId, { type: "set_effort", effort: "high" });
    expect(mockState.controls?.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: "high" });
    expect(fixture.db.getSession(fixture.sessionId)?.effort_level).toBe("high");
    await fixture.manager.command(fixture.sessionId, { type: "interrupt" });
    await running;
    expect(fixture.db.getSession(fixture.sessionId)?.state).toBe("interrupted");
    expect(fixture.frames.some((frame) => frame.type === "turn.interrupted")).toBe(true);
    fixture.db.close();
  });

  it("persists an effort level and supplies it to the next query", async () => {
    const fixture = await createFixture();
    await fixture.manager.command(fixture.sessionId, { type: "set_effort", effort: "medium" });
    await fixture.manager.command(fixture.sessionId, { type: "send", text: "use medium effort" });
    expect(mockState.calls[0].effort).toBe("medium");
    expect(fixture.frames.some((frame) => frame.type === "effort.changed")).toBe(true);
    fixture.db.close();
  });

  it("redacts configured gateway details from failures", async () => {
    mockState.scenario = "error";
    const fixture = await createFixture(["https://secret-gateway.local"]);
    await fixture.manager.command(fixture.sessionId, { type: "send", text: "fail" });
    const failed = fixture.frames.find((frame) => frame.type === "turn.failed");
    expect(failed.payload.message).toContain("[REDACTED]");
    expect(failed.payload.message).not.toContain("secret-gateway");
    fixture.db.close();
  });

  it("replays buffered events after a websocket reconnect", async () => {
    const fixture = await createFixture();
    await fixture.manager.command(fixture.sessionId, { type: "send", text: "hello" });
    const replayed: any[] = [];
    fixture.manager.connect(fixture.sessionId, {
      readyState: 1, send: (value: string) => replayed.push(JSON.parse(value)),
    } as any, 1);
    expect(replayed.some((frame) => frame.seq > 1 && frame.type === "turn.completed")).toBe(true);
    fixture.db.close();
  });
});

async function createFixture(sensitiveValues: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "remoter-agent-"));
  const db = new AppDatabase(join(dir, "test.sqlite3"));
  const session = db.createDraftSession(dir, "fake-model", "default");
  const config: RuntimeConfig = {
    dataDir: dir, databasePath: join(dir, "test.sqlite3"), uploadDir: join(dir, "uploads"), logDir: join(dir, "logs"),
    claudeConfigDir: dir, host: "127.0.0.1", port: 0, claudePath: "/bin/echo", projectRoot: dir,
    localHostname: "localhost", maxActiveSessions: 3,
    sensitiveValues,
    auth: { passwordSalt: "x", passwordHash: "x", sessionSecret: "x" },
  };
  const manager = new AgentManager(config, db);
  const frames: any[] = [];
  const socket = { readyState: 1, send: (value: string) => frames.push(JSON.parse(value)) } as any;
  manager.connect(session.id, socket);
  return { db, manager, sessionId: session.id, frames };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

async function waitForFrame(frames: any[], type: string): Promise<any> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = frames.find((frame) => frame.type === type);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${type}`);
}
