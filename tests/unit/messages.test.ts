import { describe, expect, it } from "vitest";
import { normalizeTranscriptMessage, redactToolPayload, streamDeltaFromSdkMessage } from "../../src/server/session/messages.js";

describe("message normalization", () => {
  it("normalizes text, thinking and tool blocks", () => {
    const message = normalizeTranscriptMessage({
      type: "assistant", uuid: "m1", message: { role: "assistant", content: [
        { type: "text", text: "hello" }, { type: "thinking", thinking: "hmm" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "pwd", token: "secret" } },
      ] },
    });
    expect(message?.blocks).toHaveLength(3);
    expect(message?.blocks[2].input).toEqual({ command: "pwd", token: "[REDACTED]" });
  });

  it("extracts only text deltas", () => {
    expect(streamDeltaFromSdkMessage({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "a" } } })).toBe("a");
    expect(streamDeltaFromSdkMessage({ type: "assistant" })).toBeNull();
  });

  it("redacts nested top-level secret fields", () => {
    expect(redactToolPayload({ apiKey: "hidden", file: "ok" })).toEqual({ apiKey: "[REDACTED]", file: "ok" });
  });

  it("redacts exact configured values recursively", () => {
    const value = redactToolPayload({ nested: { endpoint: "https://private.example/v1", value: "safe" } }, [
      "https://private.example/v1",
    ]);
    expect(JSON.stringify(value)).not.toContain("private.example");
    expect(JSON.stringify(value)).toContain("safe");
  });
});
