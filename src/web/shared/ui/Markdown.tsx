// Renders assistant markdown text with GitHub-flavored syntax and LaTeX math support.
import type { Nodes } from "mdast";
import "katex/dist/katex.min.css";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { VFile } from "vfile";

// remark-math renders single-line `$$…$$` as inline math, but chat output
// usually means a display block, so $$-delimited nodes become math-display.
function remarkInlineDisplayMath() {
  return (tree: Nodes, file: VFile): void => {
    const upgrade = (node: Nodes): void => {
      const { start, end } = node.position ?? {};
      if (node.type === "inlineMath" && start?.offset !== undefined && end?.offset !== undefined) {
        if (String(file).slice(start.offset, end.offset).startsWith("$$")) {
          node.data = {
            ...node.data,
            hProperties: { ...(node.data?.hProperties ?? {}), className: ["language-math", "math-display"] },
          };
        }
      }
      for (const child of "children" in node ? node.children : []) upgrade(child);
    };
    upgrade(tree);
  };
}

// Render the given markdown inside the shared styling wrapper.
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkInlineDisplayMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
