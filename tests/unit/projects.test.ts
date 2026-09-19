import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/server/data/db.js";
import { listProjects } from "../../src/server/data/projects.js";

describe("project discovery", () => {
  it("reads cwd metadata from transcript fixtures without copying messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "remoter-discovery-"));
    const project = join(root, "workspace");
    const encoded = join(root, "claude", "projects", "-fixture-workspace");
    await Promise.all([mkdir(project), mkdir(encoded, { recursive: true })]);
    await writeFile(join(encoded, "11111111-1111-4111-8111-111111111111.jsonl"), [
      JSON.stringify({ type: "user", cwd: project, uuid: "message-1", message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "assistant", cwd: project, uuid: "message-2", message: { role: "assistant", content: "world" } }),
    ].join("\n"));
    const db = new AppDatabase(join(root, "index.sqlite3"));
    expect(await listProjects(join(root, "claude"), db)).toMatchObject([
      { id: project, path: project, sessionCount: 0, exists: true },
    ]);
    db.close();
  });
});
