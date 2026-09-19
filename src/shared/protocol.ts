// Shared wire types and labels: DTOs, client commands, server events, and option lists.
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const EFFORT_LEVELS = ["default", "low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  default: "Default",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

export const MODE_LABELS: Record<PermissionMode, string> = {
  default: "Default",
  acceptEdits: "Accept edits",
  plan: "Plan",
  auto: "Auto",
  dontAsk: "Don't ask",
  bypassPermissions: "Full access",
};

export interface AppConfigDto {
  models: string[];
  modes: Array<{ value: PermissionMode; label: string }>;
  efforts: Array<{ value: EffortLevel; label: string }>;
  maxFileBytes: number;
  maxTurnUploadBytes: number;
  localHostname: string;
}

export interface ProjectDto {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  sessionCount: number;
  updatedAt: number;
}

export type SessionState = "draft" | "idle" | "running" | "waiting" | "interrupted" | "error";

export interface SessionDto {
  id: string;
  sdkSessionId: string | null;
  projectId: string;
  title: string;
  summary: string;
  model: string;
  permissionMode: PermissionMode;
  effortLevel: EffortLevel;
  state: SessionState;
  gitBranch: string | null;
  parentSessionId: string | null;
  parentMessageId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ContentBlockDto {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "image" | "unknown";
  text?: string;
  toolUseId?: string;
  toolName?: string;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
}

export interface MessageDto {
  id: string;
  role: "user" | "assistant";
  blocks: ContentBlockDto[];
  timestamp?: number;
}

export interface UploadDto {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  isImage: boolean;
  url: string;
}

export interface QuestionOptionDto {
  label: string;
  description: string;
}

export interface QuestionDto {
  question: string;
  header: string;
  options: QuestionOptionDto[];
  multiSelect: boolean;
}

export type ServerEventType =
  | "session.metadata"
  | "turn.started"
  | "assistant.delta"
  | "assistant.message"
  | "tool.started"
  | "tool.finished"
  | "interaction.question"
  | "interaction.permission"
  | "interaction.resolved"
  | "mode.changed"
  | "effort.changed"
  | "external.changed"
  | "turn.completed"
  | "turn.failed"
  | "turn.interrupted"
  | "command.error";

export interface ServerEvent<T = unknown> {
  seq: number;
  type: ServerEventType;
  sessionId: string;
  payload: T;
  timestamp: number;
}

export type ClientCommand =
  | { type: "hello"; lastSeq?: number }
  | { type: "send"; text: string; uploadIds?: string[] }
  | { type: "answer"; interactionId: string; answers: Record<string, string[]> }
  | { type: "permission"; interactionId: string; decision: "allow" | "deny"; message?: string }
  | { type: "set_mode"; mode: PermissionMode }
  | { type: "set_model"; model: string }
  | { type: "set_effort"; effort: EffortLevel }
  | { type: "interrupt" };

export interface ApiErrorBody {
  error: string;
  code?: string;
}
