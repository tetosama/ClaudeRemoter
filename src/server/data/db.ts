// SQLite persistence for sessions and uploads, including schema migrations.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { EffortLevel, PermissionMode, SessionDto, SessionState, UploadDto } from "../../shared/protocol.js";

type Sqlite = InstanceType<typeof Database>;

export interface SessionRecord {
  id: string;
  sdk_session_id: string | null;
  project_id: string;
  title: string;
  summary: string;
  model: string;
  permission_mode: PermissionMode;
  effort_level: EffortLevel;
  state: SessionState;
  git_branch: string | null;
  parent_session_id: string | null;
  parent_message_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface UploadRecord {
  id: string;
  session_id: string;
  display_name: string;
  storage_path: string;
  mime: string;
  size: number;
  sha256: string;
  created_at: number;
}

export class AppDatabase {
  readonly raw: Sqlite;

  // Open the SQLite database, enable WAL and foreign keys, and run migrations.
  constructor(path: string) {
    this.raw = new Database(path);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
    this.migrate();
  }

  // Close the underlying database connection.
  close(): void {
    this.raw.close();
  }

  // Create tables and indexes, carry legacy project references forward, and reset stale states.
  migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        sdk_session_id TEXT,
        project_id TEXT NOT NULL,
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
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        storage_path TEXT NOT NULL UNIQUE,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const sessionColumns = this.raw.pragma("table_info(sessions)") as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "effort_level")) {
      this.raw.exec("ALTER TABLE sessions ADD COLUMN effort_level TEXT NOT NULL DEFAULT 'default'");
    }
    this.resolveLegacyProjectReferences();
    this.raw.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_project_sdk
        ON sessions(project_id, sdk_session_id) WHERE sdk_session_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_sessions_project_updated
        ON sessions(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_uploads_session
        ON uploads(session_id, created_at);
    `);
    this.raw.pragma("optimize");
    this.raw.prepare("UPDATE sessions SET state = 'interrupted' WHERE state IN ('running', 'waiting')").run();
  }

  // One-time upgrade: rewrite legacy project-id references as paths and drop the projects table.
  private resolveLegacyProjectReferences(): void {
    const hasProjects = this.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get();
    if (!hasProjects) return;
    this.raw.pragma("foreign_keys = OFF");
    this.raw.transaction(() => {
      this.raw.exec(`
        CREATE TABLE sessions_new (
          id TEXT PRIMARY KEY,
          sdk_session_id TEXT,
          project_id TEXT NOT NULL,
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
        INSERT INTO sessions_new(
          id,sdk_session_id,project_id,title,summary,model,permission_mode,effort_level,state,git_branch,
          parent_session_id,parent_message_id,created_at,updated_at
        )
        SELECT s.id,s.sdk_session_id,COALESCE(p.path,s.project_id),s.title,s.summary,s.model,s.permission_mode,
          s.effort_level,s.state,s.git_branch,s.parent_session_id,s.parent_message_id,s.created_at,s.updated_at
        FROM sessions s LEFT JOIN projects p ON p.id = s.project_id;
        DROP TABLE sessions;
        DROP TABLE projects;
        ALTER TABLE sessions_new RENAME TO sessions;
      `);
    })();
    this.raw.pragma("foreign_keys = ON");
  }

  // Aggregate session counts and latest activity per referenced project path.
  sessionStatsByProject(): Map<string, { count: number; lastUpdatedAt: number }> {
    const rows = this.raw.prepare("SELECT project_id, COUNT(*) AS count, MAX(updated_at) AS last FROM sessions GROUP BY project_id")
      .all() as Array<{ project_id: string; count: number; last: number }>;
    return new Map(rows.map((row) => [row.project_id, { count: Number(row.count), lastUpdatedAt: Number(row.last) }]));
  }

  // Create a new not-yet-run session for a project with the chosen defaults.
  createDraftSession(projectId: string, model: string, permissionMode: PermissionMode, effortLevel: EffortLevel = "default"): SessionRecord {
    const now = Date.now();
    const row: SessionRecord = {
      id: randomUUID(), sdk_session_id: null, project_id: projectId, title: "New session", summary: "",
      model, permission_mode: permissionMode, effort_level: effortLevel, state: "draft", git_branch: null,
      parent_session_id: null, parent_message_id: null, created_at: now, updated_at: now,
    };
    this.insertSession(row);
    return row;
  }

  // Insert or refresh a session discovered in Claude CLI history.
  importSession(input: {
    sdkSessionId: string; projectId: string; title?: string; summary?: string; model: string;
    permissionMode?: PermissionMode; effortLevel?: EffortLevel; gitBranch?: string | null; createdAt?: number; updatedAt?: number;
  }): SessionRecord {
    const existing = this.raw.prepare("SELECT * FROM sessions WHERE project_id = ? AND sdk_session_id = ?")
      .get(input.projectId, input.sdkSessionId) as SessionRecord | undefined;
    const now = Date.now();
    if (existing) {
      this.raw.prepare(`UPDATE sessions SET title=?,summary=?,git_branch=?,updated_at=MAX(updated_at,?) WHERE id=?`)
        .run(input.title || existing.title, input.summary || existing.summary, input.gitBranch ?? existing.git_branch,
          input.updatedAt || now, existing.id);
      return this.getSession(existing.id)!;
    }
    const row: SessionRecord = {
      id: randomUUID(), sdk_session_id: input.sdkSessionId, project_id: input.projectId,
      title: input.title || input.summary || "Historical session", summary: input.summary || "", model: input.model,
      permission_mode: input.permissionMode || "default", effort_level: input.effortLevel || "default",
      state: "idle", git_branch: input.gitBranch || null,
      parent_session_id: null, parent_message_id: null, created_at: input.createdAt || input.updatedAt || now,
      updated_at: input.updatedAt || now,
    };
    this.insertSession(row);
    return row;
  }

  // Persist a forked session that references its parent session and message.
  insertFork(input: {
    sdkSessionId: string; projectId: string; model: string; permissionMode: PermissionMode; effortLevel: EffortLevel;
    parentSessionId: string; parentMessageId: string; title: string;
  }): SessionRecord {
    const now = Date.now();
    const row: SessionRecord = {
      id: randomUUID(), sdk_session_id: input.sdkSessionId, project_id: input.projectId,
      title: input.title, summary: "", model: input.model, permission_mode: input.permissionMode,
      effort_level: input.effortLevel,
      state: "idle", git_branch: null, parent_session_id: input.parentSessionId,
      parent_message_id: input.parentMessageId, created_at: now, updated_at: now,
    };
    this.insertSession(row);
    return row;
  }

  // Insert a prepared session row into the sessions table.
  private insertSession(row: SessionRecord): void {
    this.raw.prepare(`INSERT INTO sessions(
      id,sdk_session_id,project_id,title,summary,model,permission_mode,effort_level,state,git_branch,
      parent_session_id,parent_message_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.id, row.sdk_session_id, row.project_id, row.title, row.summary, row.model, row.permission_mode,
      row.effort_level, row.state, row.git_branch, row.parent_session_id, row.parent_message_id, row.created_at, row.updated_at,
    );
  }

  // Fetch a single session row by id.
  getSession(id: string): SessionRecord | undefined {
    return this.raw.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRecord | undefined;
  }

  // Fetch the session of a project that matches a Claude SDK session id.
  getSessionBySdk(projectId: string, sdkSessionId: string): SessionRecord | undefined {
    return this.raw.prepare("SELECT * FROM sessions WHERE project_id = ? AND sdk_session_id = ?")
      .get(projectId, sdkSessionId) as SessionRecord | undefined;
  }

  // List a project's sessions as DTOs, newest first, with paging.
  listSessions(projectId: string, limit: number, offset: number): SessionDto[] {
    const rows = this.raw.prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?")
      .all(projectId, limit, offset) as SessionRecord[];
    return rows.map(sessionDto);
  }

  // Apply the given column changes to a session and return the refreshed row.
  updateSession(id: string, changes: Partial<{
    sdkSessionId: string; title: string; summary: string; model: string; permissionMode: PermissionMode; effortLevel: EffortLevel;
    state: SessionState; gitBranch: string | null; updatedAt: number;
  }>): SessionRecord {
    const mapping: Record<string, string> = {
      sdkSessionId: "sdk_session_id", title: "title", summary: "summary", model: "model",
      permissionMode: "permission_mode", effortLevel: "effort_level", state: "state", gitBranch: "git_branch", updatedAt: "updated_at",
    };
    const entries = Object.entries(changes).filter(([, value]) => value !== undefined);
    if (entries.length) {
      const assignments = entries.map(([key]) => `${mapping[key]} = ?`).join(", ");
      this.raw.prepare(`UPDATE sessions SET ${assignments} WHERE id = ?`)
        .run(...entries.map(([, value]) => value), id);
    }
    return this.getSession(id)!;
  }

  // Record a newly stored upload and return the complete record.
  addUpload(input: Omit<UploadRecord, "id" | "created_at">): UploadRecord {
    const row: UploadRecord = { ...input, id: randomUUID(), created_at: Date.now() };
    this.raw.prepare("INSERT INTO uploads(id,session_id,display_name,storage_path,mime,size,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(row.id, row.session_id, row.display_name, row.storage_path, row.mime, row.size, row.sha256, row.created_at);
    return row;
  }

  // Fetch a single upload record by id.
  getUpload(id: string): UploadRecord | undefined {
    return this.raw.prepare("SELECT * FROM uploads WHERE id = ?").get(id) as UploadRecord | undefined;
  }

  // Fetch the given uploads, restricted to those belonging to one session.
  getUploads(ids: string[], sessionId: string): UploadRecord[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.raw.prepare(`SELECT * FROM uploads WHERE session_id = ? AND id IN (${placeholders})`)
      .all(sessionId, ...ids) as UploadRecord[];
  }
}

// Convert a session row into the DTO sent to the client.
export function sessionDto(row: SessionRecord): SessionDto {
  return {
    id: row.id, sdkSessionId: row.sdk_session_id, projectId: row.project_id,
    title: row.title, summary: row.summary, model: row.model, permissionMode: row.permission_mode,
    effortLevel: row.effort_level,
    state: row.state, gitBranch: row.git_branch, parentSessionId: row.parent_session_id,
    parentMessageId: row.parent_message_id, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// Convert an upload row into the DTO sent to the client.
export function uploadDto(row: UploadRecord): UploadDto {
  const isImage = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(row.mime);
  return {
    id: row.id, name: row.display_name, mime: row.mime, size: row.size, sha256: row.sha256,
    isImage, url: `/api/uploads/${row.id}`,
  };
}
