// Builds the project list from Claude transcript folders plus paths referenced by stored sessions.
import { basename, join } from "node:path";
import { open, opendir, stat } from "node:fs/promises";
import type { ProjectDto } from "../../shared/protocol.js";
import type { AppDatabase } from "./db.js";

const MAX_PROBE_BYTES = 1024 * 1024;

// List every known project: discovered in Claude's history or referenced by a stored session.
export async function listProjects(claudeConfigDir: string, db: AppDatabase): Promise<ProjectDto[]> {
  const transcriptActivity = new Map<string, number>();
  const projectsRoot = join(claudeConfigDir, "projects");
  try {
    const root = await opendir(projectsRoot);
    for await (const projectEntry of root) {
      if (!projectEntry.isDirectory()) continue;
      const found = await findCwd(join(projectsRoot, projectEntry.name));
      if (found) transcriptActivity.set(found.cwd, found.updatedAt);
    }
  } catch {
    // A missing or unreadable Claude projects directory yields no transcript-backed projects.
  }
  const usage = db.sessionStatsByProject();
  const projects: ProjectDto[] = [];
  for (const path of new Set([...transcriptActivity.keys(), ...usage.keys()])) {
    const referenced = usage.get(path);
    projects.push({
      id: path, name: basename(path) || path, path,
      exists: await isDirectory(path),
      sessionCount: referenced?.count ?? 0,
      updatedAt: Math.max(transcriptActivity.get(path) ?? 0, referenced?.lastUpdatedAt ?? 0),
    });
  }
  return projects.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Shape a freshly registered project path into the DTO returned to the client.
export function projectDto(path: string, sessionCount = 0): ProjectDto {
  return { id: path, name: basename(path) || path, path, exists: true, sessionCount, updatedAt: Date.now() };
}

// Check whether a path currently resolves to a directory.
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

// Read the newest transcripts of a folder to recover the project's working directory.
async function findCwd(encodedDir: string): Promise<{ cwd: string; updatedAt: number } | null> {
  const files: Array<{ path: string; mtime: number }> = [];
  try {
    const dir = await opendir(encodedDir);
    for await (const entry of dir) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(encodedDir, entry.name);
      try {
        files.push({ path, mtime: (await stat(path)).mtimeMs });
      } catch {
        // File disappeared during discovery.
      }
    }
  } catch {
    return null;
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const file of files.slice(0, 5)) {
    let handle;
    try {
      handle = await open(file.path, "r");
      const buffer = Buffer.allocUnsafe(MAX_PROBE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      for (const line of text.split("\n")) {
        if (!line.includes('"cwd"')) continue;
        try {
          const value = JSON.parse(line) as { cwd?: unknown };
          if (typeof value.cwd === "string" && value.cwd.startsWith("/")) {
            return { cwd: value.cwd, updatedAt: file.mtime };
          }
        } catch {
          // Partial or malformed lines are ignored.
        }
      }
    } catch {
      // Continue with the next transcript.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return null;
}
