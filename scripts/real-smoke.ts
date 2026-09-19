import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { deleteSession, forkSession, query } from "@anthropic-ai/claude-agent-sdk";
import { configuredModels } from "../src/server/session/models.js";

if (process.env.CLAUDE_REMOTER_REAL_SMOKE !== "1") {
  throw new Error("The real smoke test calls the current model gateway. Set CLAUDE_REMOTER_REAL_SMOKE=1 to run it.");
}

const cwd = await mkdtemp(join(tmpdir(), "claude-remoter-real-smoke-"));
const claudePath = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
const [model] = await configuredModels(join(homedir(), ".claude"));
if (!model) throw new Error("No model in settings.json");
const ids: string[] = [];
try {
  const first = await run("Reply with only: remoter-smoke-one", undefined);
  ids.push(first);
  await run("Reply with only: remoter-smoke-two", first);
  const fork = await forkSession(first, { dir: cwd, title: "Claude Remoter smoke fork" });
  ids.push(fork.sessionId);
  await run("Reply with only: remoter-smoke-fork", fork.sessionId);
  process.stdout.write("Real create, resume and fork smoke tests completed.\n");
} finally {
  for (const id of ids) await deleteSession(id, { dir: cwd }).catch(() => undefined);
  await rm(cwd, { recursive: true, force: true });
}

async function run(prompt: string, resume: string | undefined): Promise<string> {
  let sessionId = "";
  for await (const message of query({
    prompt,
    options: { cwd, model, resume, pathToClaudeCodeExecutable: claudePath, permissionMode: "default", maxTurns: 1 },
  })) {
    if (message.type === "result") sessionId = message.session_id;
  }
  if (!sessionId) throw new Error("Claude did not return a session id");
  return sessionId;
}
