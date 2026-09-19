// Reads the model identifiers the operator allows in Claude settings.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

// Collect the model names configured in settings.json's model field and env block.
export async function configuredModels(claudeConfigDir: string): Promise<string[]> {
  const raw = await readFile(join(claudeConfigDir, "settings.json"), "utf8");
  const settings = JSON.parse(raw) as { model?: unknown; env?: Record<string, unknown> };
  const values: unknown[] = [settings.model];
  for (const key of MODEL_ENV_KEYS) values.push(settings.env?.[key]);
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}
