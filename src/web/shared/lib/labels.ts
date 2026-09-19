// Maps internal session states to their English display labels.
import type { SessionState } from "@shared/protocol";

// Look up the display label for a session state.
export function stateLabel(state: SessionState): string {
  return ({ draft: "Draft", idle: "Idle", running: "Running", waiting: "Waiting for answer", interrupted: "Interrupted", error: "Error" })[state];
}
