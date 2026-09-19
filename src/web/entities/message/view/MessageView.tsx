// Renders one chat message with role avatar, content blocks and the fork control.
import { Markdown } from "@/shared/ui/Markdown";
import { pretty } from "@/shared/lib/format";
import type { ContentBlockDto, MessageDto } from "@shared/protocol";

// Render one message with its role avatar, every content block and the fork control.
export function MessageView({ message, onFork }: { message: MessageDto; onFork?: () => void }) {
  return <article className={`message ${message.role}`}>
    <div className="avatar">{message.role === "assistant" ? "C" : "You"}</div>
    <div className="message-body">
      {message.blocks.map((block, index) => <Block key={`${block.type}-${index}`} block={block} />)}
      {onFork && <button className="fork-button" onClick={onFork}>⑂ Fork from here</button>}
    </div>
  </article>;
}

// Render a single content block, choosing the presentation by its type.
function Block({ block }: { block: ContentBlockDto }) {
  if (block.type === "text") return <Markdown text={block.text || ""} />;
  if (block.type === "thinking") return <details className="thinking"><summary>Thinking</summary><pre>{block.text}</pre></details>;
  if (block.type === "tool_use") return <details className="tool-card"><summary><span>⌘</span>{block.toolName}<em>called</em></summary><pre>{pretty(block.input)}</pre></details>;
  if (block.type === "tool_result") return <details className={`tool-card result ${block.isError ? "failed" : ""}`}><summary><span>{block.isError ? "!" : "✓"}</span>Tool result<em>{block.isError ? "Error" : "Done"}</em></summary><pre>{pretty(block.result)}</pre></details>;
  if (block.type === "image") return <p className="muted">[Image]</p>;
  return block.text ? <pre>{block.text}</pre> : null;
}
