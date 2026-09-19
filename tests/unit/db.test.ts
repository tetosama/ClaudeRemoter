import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppDatabase } from "../../src/server/data/db.js";

describe("AppDatabase", () => {
  it("indexes drafts and forks without duplicating SDK sessions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "remoter-db-"));
    const db = new AppDatabase(join(dir, "test.sqlite3"));
    const projectPath = "/tmp/project";
    const draft = db.createDraftSession(projectPath, "model", "default");
    expect(db.getSession(draft.id)?.state).toBe("draft");
    expect(db.getSession(draft.id)?.effort_level).toBe("default");
    db.updateSession(draft.id, { effortLevel: "medium" });
    expect(db.getSession(draft.id)?.effort_level).toBe("medium");
    const imported = db.importSession({ sdkSessionId: "sdk-1", projectId: projectPath, model: "model", summary: "one" });
    const importedAgain = db.importSession({ sdkSessionId: "sdk-1", projectId: projectPath, model: "model", summary: "updated" });
    expect(importedAgain.id).toBe(imported.id);
    expect(db.listSessions(projectPath, 10, 0)).toHaveLength(2);
    const fork = db.insertFork({
      sdkSessionId: "sdk-fork", projectId: projectPath, model: "model", permissionMode: "default",
      effortLevel: "medium", parentSessionId: imported.id, parentMessageId: "message-1", title: "Fork",
    });
    expect(db.getSession(fork.id)?.effort_level).toBe("medium");
    db.close();
  });

  it("rewrites legacy project-id references as paths and drops the projects table", async () => {
    const dir = await mkdtemp(join(tmpdir(), "remoter-db-projects-"));
    const path = join(dir, "test.sqlite3");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        exists_flag INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        sdk_session_id TEXT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        effort_level TEXT NOT NULL DEFAULT 'default',
        state TEXT NOT NULL,
        git_branch TEXT,
        parent_session_id TEXT,
        parent_message_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO projects VALUES ('p1', '/tmp/legacy', 'legacy', 1, 1, 1);
      INSERT INTO sessions VALUES ('legacy', 'sdk-1', 'p1', 'Legacy', '', 'model', 'default', 'default', 'idle', NULL, NULL, NULL, 1, 1);
    `);
    legacy.close();

    const db = new AppDatabase(path);
    expect(db.getSession("legacy")?.project_id).toBe("/tmp/legacy");
    expect([...db.sessionStatsByProject().keys()]).toEqual(["/tmp/legacy"]);
    expect(db.createDraftSession("/tmp/legacy", "model", "default").project_id).toBe("/tmp/legacy");
    db.close();
  });

  it("adds a default effort level when upgrading an existing database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "remoter-db-migration-"));
    const path = join(dir, "test.sqlite3");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        sdk_session_id TEXT,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        state TEXT NOT NULL,
        git_branch TEXT,
        parent_session_id TEXT,
        parent_message_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO sessions VALUES ('legacy', NULL, 'project', 'Legacy', '', 'model', 'default', 'idle', NULL, NULL, NULL, 1, 1);
    `);
    legacy.close();

    const db = new AppDatabase(path);
    expect(db.getSession("legacy")?.effort_level).toBe("default");
    db.close();
  });
});
