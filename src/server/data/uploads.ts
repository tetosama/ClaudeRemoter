// Stores uploaded attachments on disk, hashes and limits them, and records them.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { MultipartFile } from "@fastify/multipart";
import type { AppDatabase, UploadRecord } from "./db.js";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TURN_UPLOAD_BYTES = 100 * 1024 * 1024;
export const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// Stream an uploaded part to disk, hashing it and enforcing the size limit.
export async function saveUpload(input: {
  part: MultipartFile;
  sessionId: string;
  uploadRoot: string;
  db: AppDatabase;
}): Promise<UploadRecord> {
  const safeName = sanitizeFilename(input.part.filename || "upload");
  const sessionDir = join(input.uploadRoot, input.sessionId);
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const tempName = `${Date.now()}-${Math.random().toString(16).slice(2)}-${safeName}`;
  const storagePath = join(sessionDir, tempName);
  const hash = createHash("sha256");
  let size = 0;
  input.part.file.on("data", (chunk: Buffer) => {
    size += chunk.length;
    hash.update(chunk);
  });
  try {
    await pipeline(input.part.file, createWriteStream(storagePath, { mode: 0o600, flags: "wx" }));
    if (input.part.file.truncated || size > MAX_FILE_BYTES) throw new Error("File exceeds the 25 MiB limit");
  } catch (error) {
    await unlink(storagePath).catch(() => undefined);
    throw error;
  }
  return input.db.addUpload({
    session_id: input.sessionId,
    display_name: safeName,
    storage_path: storagePath,
    mime: normalizeMime(input.part.mimetype),
    size,
    sha256: hash.digest("hex"),
  });
}

// Verify the stored file against its recorded size and open a read stream for it.
export async function openUpload(record: UploadRecord) {
  const info = await stat(record.storage_path);
  if (!info.isFile() || info.size !== record.size) throw new Error("Uploaded file is unavailable");
  return createReadStream(record.storage_path);
}

// Reduce a filename to a safe, length-capped basename.
export function sanitizeFilename(value: string): string {
  const cleaned = basename(value).normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/\\:]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 160);
  return cleaned || "upload";
}

// Validate and lowercase a reported MIME type, falling back to a generic one.
function normalizeMime(value: string): string {
  if (!value || /[\r\n]/.test(value)) return "application/octet-stream";
  return value.slice(0, 120).toLowerCase();
}
