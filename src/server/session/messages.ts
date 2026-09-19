// Converts raw Claude SDK messages into redacted, client-facing DTOs.
import type { ContentBlockDto, MessageDto } from "../../shared/protocol.js";
import { redactSecrets } from "../infra/config.js";

// Normalize a transcript entry into a message DTO, skipping anything that is not a message.
export function normalizeTranscriptMessage(value: unknown, sensitiveValues: readonly string[] = []): MessageDto | null {
  if (!isRecord(value)) return null;
  const role = value.type === "assistant" || value.type === "user" ? value.type : value.message && isRecord(value.message)
    ? value.message.role : null;
  if (role !== "user" && role !== "assistant") return null;
  const message = isRecord(value.message) ? value.message : value;
  const content = Array.isArray(message.content) ? message.content : typeof message.content === "string" ? message.content : [];
  return {
    id: typeof value.uuid === "string" ? value.uuid : typeof message.id === "string" ? message.id : cryptoId(value),
    role,
    blocks: normalizeContent(content, sensitiveValues),
    timestamp: parseTimestamp(value.timestamp),
  };
}

// Convert message content into typed, secret-redacted blocks for the client.
export function normalizeContent(content: unknown, sensitiveValues: readonly string[] = []): ContentBlockDto[] {
  if (typeof content === "string") return [{ type: "text", text: redactSecrets(content, sensitiveValues) }];
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlockDto[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: redactSecrets(block.text, sensitiveValues) });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      blocks.push({ type: "thinking", text: redactSecrets(block.thinking, sensitiveValues) });
    } else if (block.type === "tool_use") {
      blocks.push({
        type: "tool_use",
        toolUseId: typeof block.id === "string" ? block.id : undefined,
        toolName: typeof block.name === "string" ? block.name : "Tool",
        input: redactToolPayload(block.input, sensitiveValues),
      });
    } else if (block.type === "tool_result") {
      blocks.push({
        type: "tool_result",
        toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
        result: truncateResult(block.content, sensitiveValues),
        isError: block.is_error === true,
      });
    } else if (block.type === "image") {
      blocks.push({ type: "image" });
    } else {
      blocks.push({ type: "unknown", text: redactSecrets(safeString(block), sensitiveValues) });
    }
  }
  return blocks;
}

// Extract the streamed text increment from a partial SDK message, if any.
export function streamDeltaFromSdkMessage(message: unknown): string | null {
  if (!isRecord(message) || message.type !== "stream_event" || !isRecord(message.event)) return null;
  const event = message.event;
  if (event.type !== "content_block_delta" || !isRecord(event.delta)) return null;
  if (event.delta.type === "text_delta" && typeof event.delta.text === "string") return event.delta.text;
  return null;
}

// Pull the Claude SDK session id out of any message that carries one.
export function sdkSessionId(message: unknown): string | null {
  if (!isRecord(message)) return null;
  if (typeof message.session_id === "string") return message.session_id;
  if (isRecord(message.data) && typeof message.data.session_id === "string") return message.data.session_id;
  return null;
}

// Redact, truncate, and bound the nesting of a tool call payload.
export function redactToolPayload(value: unknown, sensitiveValues: readonly string[] = []): unknown {
  return redactPayload(value, sensitiveValues, 0);
}

// Redact and cap the size of a tool result before it reaches the client.
function truncateResult(value: unknown, sensitiveValues: readonly string[]): unknown {
  if (typeof value === "string") {
    const text = redactSecrets(value, sensitiveValues);
    return text.length > 50_000 ? `${text.slice(0, 50_000)}…` : text;
  }
  return redactToolPayload(value, sensitiveValues);
}

// Recursively redact secret-looking keys and truncate long, wide, or deep values.
function redactPayload(value: unknown, sensitiveValues: readonly string[], depth: number): unknown {
  if (typeof value === "string") {
    const text = redactSecrets(value, sensitiveValues);
    return text.length > 20_000 ? `${text.slice(0, 20_000)}…` : text;
  }
  if (depth >= 12) return "[Nested value omitted]";
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => redactPayload(item, sensitiveValues, depth + 1));
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 1_000)) {
    if (/token|api[_-]?key|authorization|password|secret/i.test(key)) output[key] = "[REDACTED]";
    else output[key] = redactPayload(item, sensitiveValues, depth + 1);
  }
  return output;
}

// Serialize a value safely, capping the resulting string length.
function safeString(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
  } catch {
    return "[Unsupported content]";
  }
}

// Parse a timestamp into epoch milliseconds, or undefined when unparseable.
function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Derive a stable fallback message id by hashing the message content.
function cryptoId(value: unknown): string {
  let hash = 2166136261;
  const text = safeString(value);
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return `message-${(hash >>> 0).toString(16)}`;
}

// Check that a value is a plain, non-array object.
function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
